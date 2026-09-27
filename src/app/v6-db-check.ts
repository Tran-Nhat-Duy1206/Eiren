import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { guilds, analyticsGuildHourly as hourly, analyticsChannelHourly as channels,
  analyticsCommandHourly as commands, analyticsEventDedupe as dedupe,
  analyticsMemberState as members, analyticsActiveVoiceSessions as voice,
  dashboardSessions, dashboardAuditLog } from '../core/database/schema.js';
import { AnalyticsRepository } from '../modules/analytics/repository.js';
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
  assert('voiceExitAndAllocation', (await db.select().from(voice).where(eq(voice.guildId, guildId))).length === 0 &&
    (await db.select().from(channels).where(and(eq(channels.guildId, guildId), eq(channels.channelId, 'beta'))))
      .reduce((sum, row) => sum + row.voiceSeconds, 0) === 10 &&
    (await db.select().from(hourly).where(eq(hourly.guildId, guildId))).reduce((sum, row) => sum + row.voiceSeconds, 0) === 30);
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
