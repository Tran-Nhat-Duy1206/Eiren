import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { guilds, analyticsGuildHourly as hourly, analyticsChannelHourly as channels,
  analyticsCommandHourly as commands, analyticsEventDedupe as dedupe,
  analyticsMemberState as members, analyticsActiveVoiceSessions as voice,
  dashboardSessions, dashboardAuditLog, guildModules } from '../core/database/schema.js';
import { AnalyticsRepository } from '../modules/analytics/repository.js';
import { AnalyticsService } from '../modules/analytics/service.js';
import { ModuleService } from '../services/module-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import type { PermissionService } from '../core/permissions/permission-service.js';
import { DashboardAuth } from '../dashboard/auth/dashboard-auth.js';

const checks: Record<string, boolean | number | string> = {};
const assert = (name: string, value: unknown) => { checks[name] = Boolean(value); if (!value) throw new Error(name); };
const id = randomUUID();
const guildId = `v6-check-${id}`, otherId = `v6-check-other-${id}`;
const tokenHashes = new Set<string>();
const clock = new Date(Math.floor((Date.now() - 2 * 3600_000) / 3600_000) * 3600_000);
const time = (ms: number) => new Date(clock.getTime() + ms);
let stage = 'initialize';
let connection: ReturnType<typeof createDatabase> | undefined;
try {
  connection = createDatabase(loadEnv().DATABASE_URL);
  const db = connection.db;
  stage = 'schema';
  const names = ['analytics_settings', 'analytics_guild_hourly', 'analytics_channel_hourly', 'analytics_command_hourly',
    'analytics_event_dedupe', 'analytics_member_state', 'analytics_active_voice_sessions', 'dashboard_sessions', 'dashboard_audit_log'];
  const tables = await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN
    ('analytics_settings','analytics_guild_hourly','analytics_channel_hourly','analytics_command_hourly','analytics_event_dedupe',
     'analytics_member_state','analytics_active_voice_sessions','dashboard_sessions','dashboard_audit_log')`);
  assert('nineV6Tables', names.every(name => tables.rows.some(row => row.table_name === name)));
  await db.insert(guilds).values([{ id: guildId }, { id: otherId }]);
  const analytics = new AnalyticsRepository(db);
  stage = 'messages';
  const inserted = await Promise.all(Array.from({ length: 8 }, (_, n) => analytics.message(guildId, `msg-${id}-${n}`, 'alpha', time(120_000))));
  assert('atomicMessageUpsert', inserted.every(Boolean) && (await db.select().from(hourly).where(eq(hourly.guildId, guildId)))[0]?.messages === 8);
  assert('messageDedupeTransaction', !await analytics.message(guildId, `msg-${id}-0`, 'beta', time(120_000)) &&
    (await db.select().from(dedupe).where(eq(dedupe.guildId, guildId))).length === 8 &&
    (await db.select().from(channels).where(eq(channels.guildId, guildId)))[0]?.messages === 8);
  await analytics.message(guildId, `msg-${id}-8`, 'beta', time(120_000));
  await analytics.message(otherId, `msg-${id}-0`, 'alpha', time(120_000));
  assert('channelAndGuildIsolation', (await db.select().from(channels).where(eq(channels.guildId, guildId))).length === 2 &&
    (await db.select().from(hourly).where(eq(hourly.guildId, guildId)))[0]?.messages === 9 &&
    (await db.select().from(hourly).where(eq(hourly.guildId, otherId)))[0]?.messages === 1);
  stage = 'members';
  const memberResults = [await analytics.member(guildId, 'member', true, time(1000)),
    await analytics.member(guildId, 'member', true, time(2000)), await analytics.member(guildId, 'member', false, time(3000)),
    await analytics.member(guildId, 'member', true, time(4000))];
  assert('joinDuplicateLeaveRejoin', memberResults.join(',') === 'true,false,true,true' &&
    (await db.select().from(hourly).where(eq(hourly.guildId, guildId)))[0]?.joins === 2 &&
    (await db.select().from(hourly).where(eq(hourly.guildId, guildId)))[0]?.leaves === 1 &&
    (await db.select().from(members).where(eq(members.guildId, guildId)))[0]?.present === true);
  stage = 'voice';
  const start = time(3590_000);
  await analytics.voice(guildId, 'speaker', 'alpha', start);
  assert('voiceSessionPersists', (await db.select().from(voice).where(eq(voice.guildId, guildId)))[0]?.channelId === 'alpha');
  await analytics.voice(guildId, 'speaker', 'beta', time(3610_000));
  assert('voiceMoveAcrossHour', (await db.select().from(voice).where(eq(voice.guildId, guildId)))[0]?.channelId === 'beta' &&
    (await db.select().from(channels).where(and(eq(channels.guildId, guildId), eq(channels.channelId, 'alpha'))))
      .reduce((sum, row) => sum + row.voiceSeconds, 0) === 20);
  await analytics.voice(guildId, 'speaker', null, time(3620_000));
  assert('voiceExitAndAllocation', (await db.select().from(voice).where(eq(voice.guildId, guildId)))[0]?.channelId === null &&
    (await db.select().from(channels).where(and(eq(channels.guildId, guildId), eq(channels.channelId, 'beta'))))
      .reduce((sum, row) => sum + row.voiceSeconds, 0) === 10 &&
    (await db.select().from(hourly).where(eq(hourly.guildId, guildId))).reduce((sum, row) => sum + row.voiceSeconds, 0) === 30);
  stage = 'voice-race';
  let analyticsEnabled = true;
  const gated = new AnalyticsService(analytics, {} as PermissionService,
    { isEnabled: async () => analyticsEnabled } as unknown as ModuleService);
  const seconds = async (channelId: string) => (await db.select().from(channels).where(and(eq(channels.guildId, guildId), eq(channels.channelId, channelId))))
    .reduce((sum, row) => sum + row.voiceSeconds, 0);
  // A short restart (<10m) used to bill bot downtime. A pre-ready event is a no-credit fence.
  await analytics.voice(guildId, 'restart-short', 'restart-short', time(4000_000));
  await gated.recordVoice(guildId, 'restart-short', 'restart-short', time(4120_000));
  assert('shortRestartNeverCreditsDowntime', await seconds('restart-short') === 0 &&
    (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'restart-short'))))[0]?.updatedAt.getTime() === time(4120_000).getTime());
  stage = 'voice-race-reconcile';
  await gated.reconcileVoice(guildId, [{ userId: 'restart-short', channelId: 'restart-short' }], time(4130_000), time(4140_000));
  await gated.recordVoice(guildId, 'restart-short', 'restart-short', time(4145_000));
  assert('freshBaselineAccruesOnlyObservedTime', await seconds('restart-short') === 5);
  await analytics.voice(guildId, 'restart-long', 'restart-long', time(4600_000));
  const longGated = new AnalyticsService(analytics, {} as PermissionService,
    { isEnabled: async () => true } as unknown as ModuleService);
  await longGated.recordVoice(guildId, 'restart-long', 'restart-long', time(5260_000));
  assert('longRestartAlsoNeverCreditsDowntime', await seconds('restart-long') === 0);
  const snapshotCutoff = time(5900_000);
  await analytics.voice(guildId, 'mover', 'A-move', time(5890_000));
  await analytics.voice(guildId, 'mover', 'B-move', time(5901_000));
  const movedBefore = (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'mover'))))[0]!;
  await analytics.reconcileVoice(guildId, [{ userId: 'mover', channelId: 'A-move' }], snapshotCutoff, time(5910_000));
  const movedAfter = (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'mover'))))[0]!;
  assert('staleSnapshotCannotOverwriteMove', movedAfter.channelId === 'B-move' &&
    movedAfter.joinedAt.getTime() === movedBefore.joinedAt.getTime() && movedAfter.updatedAt.getTime() === movedBefore.updatedAt.getTime());
  await analytics.voice(guildId, 'newer-join', 'B-join', time(5902_000));
  await analytics.reconcileVoice(guildId, [], snapshotCutoff, time(5910_000));
  assert('staleSnapshotCannotDeleteNewJoin', (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'newer-join'))))[0]?.channelId === 'B-join');
  await analytics.voice(guildId, 'leaver', 'A-leave', time(5890_000));
  await analytics.voice(guildId, 'leaver', null, time(5903_000));
  await analytics.reconcileVoice(guildId, [{ userId: 'leaver', channelId: 'A-leave' }], snapshotCutoff, time(5910_000));
  assert('staleSnapshotCannotResurrectLeave', (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'leaver'))))[0]?.channelId === null);
  await analytics.heartbeat(guildId, [{ userId: 'mover', channelId: 'A-move' }], snapshotCutoff, 1000, time(5910_000));
  assert('staleHeartbeatPreservesMoveAndJoin', (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'mover'))))[0]?.channelId === 'B-move' &&
    (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'newer-join'))))[0]?.channelId === 'B-join');
  const equalBoundary = time(5940_000);
  await analytics.baselineVoice(guildId, 'same-millisecond', 'B-equal', equalBoundary);
  await analytics.reconcileVoice(guildId, [{ userId: 'same-millisecond', channelId: 'A-equal' }], equalBoundary, time(5950_000));
  await analytics.heartbeat(guildId, [{ userId: 'same-millisecond', channelId: 'A-equal' }], equalBoundary, 1000, time(5950_000));
  assert('equalBoundaryNeverOverwritesNewEvent', (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'same-millisecond'))))[0]?.channelId === 'B-equal');
  await analytics.voice(guildId, 'concurrent', 'A-concurrent', time(5960_000));
  await Promise.all([
    analytics.heartbeat(guildId, [{ userId: 'concurrent', channelId: 'A-concurrent' }], time(5970_000), 1000, time(5970_000)),
    analytics.voice(guildId, 'concurrent', 'B-concurrent', time(5971_000)),
  ]);
  assert('guildLockedConcurrentHeartbeatAndMove', await seconds('A-concurrent') === 11 &&
    (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'concurrent'))))[0]?.channelId === 'B-concurrent');
  const equalStartup = time(5980_000);
  await analytics.voice(guildId, 'same-startup-millisecond', 'equal-restart', equalStartup);
  const equalGated = new AnalyticsService(analytics, {} as PermissionService,
    { isEnabled: async () => true } as unknown as ModuleService);
  await equalGated.reconcileVoice(guildId, [{ userId: 'same-startup-millisecond', channelId: 'equal-restart' }],
    equalStartup, time(5982_000));
  await equalGated.recordVoice(guildId, 'same-startup-millisecond', 'equal-restart', time(5985_000));
  assert('equalStartupBoundaryNeverCreditsDowntime', await seconds('equal-restart') === 0);
  await equalGated.heartbeat(guildId, [{ userId: 'same-startup-millisecond', channelId: 'equal-restart' }], time(5990_000));
  assert('equalStartupResumeCreditsObservedTime', await seconds('equal-restart') === 5);
  await analytics.voice(guildId, 'reordered', 'A-reordered', time(5960_000));
  await analytics.voice(guildId, 'reordered', 'B-reordered', time(5970_000));
  const reordered = await analytics.voice(guildId, 'reordered', 'A-reordered', time(5965_000));
  const duplicate = await analytics.voice(guildId, 'reordered', 'B-reordered', time(5970_000));
  assert('duplicateAndReorderedEventsNoDoubleCredit', !reordered && !duplicate && await seconds('A-reordered') === 10 &&
    (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'reordered'))))[0]?.channelId === 'B-reordered');
  await analytics.voice(guildId, 'disabled-user', 'disabled-voice', time(6000_000));
  gated.invalidateVoice(guildId);
  analyticsEnabled = false;
  assert('disabledVoiceEventRejected', !await gated.recordVoice(guildId, 'disabled-user', 'disabled-voice', time(6050_000)));
  analyticsEnabled = true;
  gated.invalidateVoice(guildId);
  assert('reenabledHeartbeatWaitsForBaseline', await gated.heartbeat(guildId,
    [{ userId: 'disabled-user', channelId: 'disabled-voice' }], time(6055_000)) === 0 && await seconds('disabled-voice') === 0);
  await gated.recordVoice(guildId, 'disabled-user', 'disabled-voice', time(6060_000));
  assert('reenabledVoiceNeverCreditsDisabledTime', await seconds('disabled-voice') === 0);
  await gated.reconcileVoice(guildId, [{ userId: 'disabled-user', channelId: 'disabled-voice' }], time(6070_000), time(6080_000));
  await gated.heartbeat(guildId, [{ userId: 'disabled-user', channelId: 'disabled-voice' }], time(6085_000), 1000);
  assert('reenabledVoiceAccruesOnlyAfterFreshBaseline', await seconds('disabled-voice') === 5);
  const moduleRepository = new GuildRepository(db);
  const realModules = new ModuleService(moduleRepository,
    [{ key: 'core', defaultEnabled: true }, { key: 'analytics', defaultEnabled: false }]);
  await realModules.setEnabled(guildId, 'analytics', true, 'synthetic');
  // Backdate only our synthetic module row to model a completed enable before the virtual fixture clock.
  await db.update(guildModules).set({ updatedAt: time(6090_000) })
    .where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, 'analytics')));
  const realGated = new AnalyticsService(analytics, {} as PermissionService, realModules);
  const initialEpoch = await realModules.voiceEpoch(guildId);
  await analytics.voice(guildId, 'toggle-fence', 'toggle-fence', time(6100_000));
  await realGated.reconcileVoice(guildId, [{ userId: 'toggle-fence', channelId: 'toggle-fence' }],
    time(6110_000), time(6120_000));
  await realModules.setEnabled(guildId, 'analytics', false, 'synthetic');
  assert('dbToggleRejectsDelayedVoiceWrite', !await analytics.voice(guildId, 'toggle-fence', 'toggle-fence', time(6150_000), time(6120_000), initialEpoch) &&
    await seconds('toggle-fence') === 0 && !realGated.isVoiceReady(guildId));
  await realModules.setEnabled(guildId, 'analytics', true, 'synthetic');
  await db.update(guildModules).set({ updatedAt: time(6120_000) })
    .where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, 'analytics')));
  const staleModuleSnapshot = await analytics.reconcileVoice(guildId,
    [{ userId: 'toggle-fence', channelId: 'stale-toggle' }], time(6120_000), time(6140_000), initialEpoch);
  assert('sameMillisecondModuleEpochRejectsStaleSnapshot', staleModuleSnapshot === -1 &&
    (await db.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, 'toggle-fence'))))[0]?.channelId === 'toggle-fence');
  assert('sameMillisecondModuleEpochRejectsHeartbeat',
    await analytics.heartbeat(guildId, [{ userId: 'toggle-fence', channelId: 'toggle-fence' }],
      time(6150_000), 1000, time(6150_000), time(6120_000), initialEpoch) === -1 && await seconds('toggle-fence') === 0);
  await analytics.voice(guildId, 'toggle-fence', 'toggle-fence', time(6160_000), time(6120_000), initialEpoch);
  assert('dbToggleReenableFencesOtherWorker', await seconds('toggle-fence') === 0 &&
    (await realModules.voiceEpoch(guildId)) === initialEpoch + 2);
  await db.update(guildModules).set({ updatedAt: time(6165_000) })
    .where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, 'analytics')));
  await realGated.reconcileVoice(guildId, [{ userId: 'toggle-fence', channelId: 'toggle-fence' }],
    time(6170_000), time(6180_000));
  await realGated.heartbeat(guildId, [{ userId: 'toggle-fence', channelId: 'toggle-fence' }], time(6185_000));
  assert('dbToggleFreshInterval', await seconds('toggle-fence') === 5);
  stage = 'commands';
  assert('commandAccepted', await analytics.command(guildId, `cmd-${id}`, 'check', false, 11, time(1000)));
  assert('commandDedupeAndAggregate', !await analytics.command(guildId, `cmd-${id}`, 'check', true, 99, time(1000)) &&
    await analytics.command(guildId, `cmd2-${id}`, 'check', true, 23, time(1000)) &&
    (await db.select().from(commands).where(eq(commands.guildId, guildId)))[0]?.invocations === 2 &&
    (await db.select().from(commands).where(eq(commands.guildId, guildId)))[0]?.errors === 1 &&
    (await db.select().from(commands).where(eq(commands.guildId, guildId)))[0]?.totalDurationMs === 34);
  stage = 'ranges';
  const summary = await analytics.summary(guildId, '24h', new Date());
  const other = await analytics.summary(otherId, '24h', new Date());
  assert('boundedRangeAndIsolation', summary.trend.length <= 24 && summary.totals.messages === 9 &&
    other.totals.messages === 1 && summary.channels.every(row => row.channelId !== 'outside'));
  assert('localGrowthAndVoiceTop', summary.totals.net === 1 &&
    summary.localDays.some(row => Number(row.net) === 1) &&
    summary.voiceChannels.some(row => row.voiceSeconds > 0) && Array.isArray(summary.details.tickets.daily));
  await db.insert(hourly).values({ guildId, bucketStart: new Date(clock.getTime() - 40 * 86400_000), messages: 7 });
  const short = await analytics.summary(guildId, '24h', new Date());
  assert('rangeExcludesOldBuckets', short.totals.messages === 9 && short.trend.length <= 24);
  stage = 'retention';
  // Scope destructive checks to our guild: never invoke global prune against an operator's real data.
  await analytics.configure(guildId, 30);
  const cutoff = new Date(Date.now() - 30 * 86400_000);
  const removed = await db.execute(sql`WITH doomed AS (SELECT ctid FROM analytics_guild_hourly WHERE guild_id = ${guildId}
    AND bucket_start < ${cutoff} LIMIT 1) DELETE FROM analytics_guild_hourly WHERE ctid IN (SELECT ctid FROM doomed)`);
  assert('boundedScopedRetention', removed.rowCount === 1 && (await db.select().from(hourly).where(eq(hourly.guildId, guildId))).length === 2);
  const oldDedupe = new Date(Date.now() - 4 * 86400_000);
  await db.insert(dedupe).values([{ guildId, eventKey: `old-${id}-1`, createdAt: oldDedupe },
    { guildId, eventKey: `old-${id}-2`, createdAt: oldDedupe }]);
  const cleanup = await db.execute(sql`WITH doomed AS (SELECT event_key FROM analytics_event_dedupe WHERE guild_id = ${guildId}
    AND created_at < ${new Date(Date.now() - 72 * 3600_000)} LIMIT 1)
    DELETE FROM analytics_event_dedupe WHERE guild_id = ${guildId} AND event_key IN (SELECT event_key FROM doomed)`);
  assert('dedupeCleanupBounded', cleanup.rowCount === 1 &&
    (await db.select().from(dedupe).where(eq(dedupe.guildId, guildId))).some(row => row.eventKey.startsWith('old-')));
  assert('authoritativeRowsPreserved', (await db.select().from(guilds).where(eq(guilds.id, guildId))).length === 1 &&
    (await db.select().from(members).where(eq(members.guildId, guildId))).length === 1);
  stage = 'maintenance-regression';
  // Global scheduler SQL runs inside a rollback-only transaction; operator data is never committed or deleted.
  const ancient = new Date('1899-01-01T00:00:00.000Z');
  const maintenanceNow = new Date('1900-01-01T00:00:00.000Z');
  const rollback = new Error('maintenance fixture rollback');
  try {
    await db.transaction(async tx => {
      const fixtureDb = tx as unknown as typeof db;
      await tx.insert(dedupe).values({ guildId, eventKey: `maintenance-${id}`, createdAt: ancient });
      await tx.insert(hourly).values({ guildId, bucketStart: ancient, messages: 1 });
      await tx.insert(channels).values({ guildId, channelId: 'maintenance', bucketStart: ancient, messages: 1 });
      await tx.insert(commands).values({ guildId, commandName: 'maintenance', bucketStart: ancient, invocations: 1 });
      await tx.insert(members).values({ guildId, userId: 'maintenance-member', present: true, lastChangedAt: ancient });
      await tx.insert(voice).values({ guildId, userId: 'maintenance-voice', channelId: 'maintenance', joinedAt: ancient, updatedAt: ancient });
      const removedCount = await new AnalyticsRepository(fixtureDb).prune(maintenanceNow, 1);
      assert('schedulerPrunesAllSixTables', removedCount === 6 &&
        !(await tx.select().from(dedupe).where(eq(dedupe.eventKey, `maintenance-${id}`))).length &&
        !(await tx.select().from(hourly).where(eq(hourly.bucketStart, ancient))).length &&
        !(await tx.select().from(channels).where(eq(channels.channelId, 'maintenance'))).length &&
        !(await tx.select().from(commands).where(eq(commands.commandName, 'maintenance'))).length &&
        !(await tx.select().from(members).where(eq(members.userId, 'maintenance-member'))).length &&
        !(await tx.select().from(voice).where(eq(voice.userId, 'maintenance-voice'))).length);
      const maintenanceAuth = new DashboardAuth(fixtureDb, { baseUrl: 'http://localhost:3080/',
        sessionSecret: randomUUID(), discordClientId: 'synthetic', discordClientSecret: randomUUID(), secureCookies: false });
      const before = (await tx.select().from(dashboardSessions)).length;
      await maintenanceAuth.cleanupExpired(maintenanceNow);
      assert('schedulerCleanupNoExpiredSessions', (await tx.select().from(dashboardSessions)).length === before);
      const current = await maintenanceAuth.createSession('123456', [], null, maintenanceNow);
      const currentHash = createHash('sha256').update(current.sessionCookie.value).digest('hex');
      const expired = await maintenanceAuth.createSession('123456', [], null, ancient);
      const expiredHash = createHash('sha256').update(expired.sessionCookie.value).digest('hex');
      await maintenanceAuth.cleanupExpired(maintenanceNow);
      assert('schedulerCleanupKeepsLiveSession', (await tx.select().from(dashboardSessions).where(eq(dashboardSessions.tokenHash, currentHash))).length === 1);
      assert('schedulerCleanupRemovesExpiredSession', !(await tx.select().from(dashboardSessions).where(eq(dashboardSessions.tokenHash, expiredHash))).length);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  assert('schedulerFixtureRolledBack', !(await db.select().from(dedupe).where(eq(dedupe.eventKey, `maintenance-${id}`))).length);
  stage = 'sessions';
  const auth = new DashboardAuth(db, { baseUrl: 'http://localhost:3080/', sessionSecret: randomUUID(),
    discordClientId: 'synthetic', discordClientSecret: randomUUID(), secureCookies: false });
  const created = await auth.createSession('123456', ['111', '222'], 'Synthetic');
  const raw = created.sessionCookie.value, hash = createHash('sha256').update(raw).digest('hex');
  tokenHashes.add(hash);
  assert('sessionCreateAndHashedToken', raw !== hash &&
    (await db.select().from(dashboardSessions).where(eq(dashboardSessions.tokenHash, hash)))[0]?.userId === '123456' &&
    !(await db.select().from(dashboardSessions).where(eq(dashboardSessions.tokenHash, raw))).length);
  assert('sessionFind', (await auth.getSession(raw))?.oauthGuildIds.join(',') === '111,222');
  await auth.revokeSession(raw);
  assert('sessionRevoke', await auth.getSession(raw) === null);
  const expired = await auth.createSession('123456', ['111'], null, new Date(Date.now() - 2 * 86400_000));
  const expiredHash = createHash('sha256').update(expired.sessionCookie.value).digest('hex');
  tokenHashes.add(expiredHash);
  // CleanupExpired is global; verify expiry against this synthetic token through getSession instead.
  assert('expiredSessionCleanup', await auth.getSession(expired.sessionCookie.value) === null &&
    !(await db.select().from(dashboardSessions).where(eq(dashboardSessions.tokenHash, expiredHash))).length);
  stage = 'audit';
  await db.insert(dashboardAuditLog).values([{ guildId, actorUserId: '123456', action: 'synthetic-check', targetType: 'module',
    targetId: 'analytics', success: true, requestId: id }, { guildId: otherId, actorUserId: '123456',
    action: 'synthetic-check', targetType: 'module', targetId: 'analytics', success: false, requestId: id }]);
  assert('auditLogAndGuildIsolation', (await db.select().from(dashboardAuditLog).where(eq(dashboardAuditLog.guildId, guildId))).some(row => row.requestId === id && row.success) &&
    (await db.select().from(dashboardAuditLog).where(eq(dashboardAuditLog.guildId, otherId))).some(row => row.requestId === id && !row.success));
} catch (error) {
  checks.failedStage = stage;
  checks.errorClass = error instanceof Error ? error.constructor.name : 'unknown';
  const pgCause = error as { cause?: { code?: string; cause?: { code?: string } } };
  checks.pgCode = pgCause.cause?.code ?? pgCause.cause?.cause?.code ?? 'none';
  process.exitCode = 1;
} finally {
  if (connection) {
    try {
      const db = connection.db;
      for (const tokenHash of tokenHashes) await db.delete(dashboardSessions).where(eq(dashboardSessions.tokenHash, tokenHash));
      await db.delete(guilds).where(eq(guilds.id, guildId));
      await db.delete(guilds).where(eq(guilds.id, otherId));
      const remaining = await db.execute(sql`SELECT (SELECT count(*) FROM guilds WHERE id IN (${guildId}, ${otherId})) +
        (SELECT count(*) FROM dashboard_audit_log WHERE request_id = ${id}) AS count`);
      assert('syntheticDataRemoved', Number(remaining.rows[0]?.count) === 0);
    } catch (error) {
      checks.cleanupErrorClass = error instanceof Error ? error.constructor.name : 'unknown';
      process.exitCode = 1;
    }
    try { await connection.pool.end(); } catch { checks.poolCloseFailed = true; process.exitCode = 1; }
  }
  checks.passedCount = Object.values(checks).filter(value => value === true).length;
  console.log(JSON.stringify(checks));
}
