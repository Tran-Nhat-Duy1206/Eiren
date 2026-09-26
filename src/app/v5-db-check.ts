import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { communityEvents, eventParticipants, eventAttendance, eventReminders, giveaways, giveawayEntries,
  giveawayDraws, giveawayWinners, tempvoiceSettings, tempvoiceRooms, memberAchievements, guilds, guildModules,
  memberLevels, memberVerifications } from '../core/database/schema.js';
import { EventRepository } from '../modules/events/repository.js';
import { GiveawayRepository } from '../modules/giveaways/repository.js';
import { TempvoiceRepository } from '../modules/tempvoice/repository.js';
import { AchievementRepository } from '../modules/achievements/repository.js';
import { AchievementsService } from '../modules/achievements/service.js';
import { achievementsCommand } from '../modules/achievements/commands.js';
import { ModuleService } from '../services/module-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { buildRegistry, manifests } from './registry.js';

const checks: Record<string, boolean | string | number> = {};
const assert = (name: string, ok: unknown) => { checks[name] = Boolean(ok); if (!ok) throw new Error(name); };
const errorClass = (error: unknown) => error instanceof Error ? error.constructor.name : 'unknown';
const guildId = `v5-check-${randomUUID()}`;
let stage = 'initialize';
let a: ReturnType<typeof createDatabase> | undefined, b: ReturnType<typeof createDatabase> | undefined;
try {
  a = createDatabase(loadEnv().DATABASE_URL); b = createDatabase(loadEnv().DATABASE_URL);
  const db = a.db;
  stage = 'schema';
  const expected = ['community_events', 'event_participants', 'event_attendance', 'event_reminders', 'giveaways',
    'giveaway_entries', 'giveaway_draws', 'giveaway_winners', 'tempvoice_settings', 'tempvoice_rooms', 'member_achievements'];
  const tables = await db.execute(sql`select table_name from information_schema.tables where table_schema = current_schema() and table_name in
    ('community_events','event_participants','event_attendance','event_reminders','giveaways','giveaway_entries',
    'giveaway_draws','giveaway_winners','tempvoice_settings','tempvoice_rooms','member_achievements')`);
  assert('elevenV5Tables', expected.every(name => tables.rows.some(row => row.table_name === name)) && tables.rows.length === expected.length);
  const journal = await db.execute(sql`select count(*)::int as count from drizzle.__drizzle_migrations`);
  assert('journalAtLeastNine', Number(journal.rows[0]?.count) >= 9);
  await db.insert(guilds).values({ id: guildId });
  await db.insert(guildModules).values(['events', 'giveaways', 'tempvoice', 'achievements', 'levels', 'reputation']
    .map(moduleKey => ({ guildId, moduleKey, enabled: true, updatedBy: 'synthetic' })));
  const moduleState = new ModuleService(new GuildRepository(db), buildRegistry(manifests).definitions);
  await moduleState.setEnabled(guildId, 'events', false, 'synthetic');
  assert('v5IndependentModuleDisable', !await moduleState.isEnabled(guildId, 'events') &&
    await moduleState.isEnabled(guildId, 'giveaways') && await moduleState.isEnabled(guildId, 'tempvoice') &&
    await moduleState.isEnabled(guildId, 'achievements'));
  await moduleState.setEnabled(guildId, 'events', true, 'synthetic');
  const events = new EventRepository(db), events2 = new EventRepository(b.db);
  const giveaway = new GiveawayRepository(db), giveaway2 = new GiveawayRepository(b.db);
  const voice = new TempvoiceRepository(db), voice2 = new TempvoiceRepository(b.db);
  const achievement = new AchievementRepository(db), achievement2 = new AchievementRepository(b.db);
  const now = new Date();
  stage = 'events';
  const event = await events.create({ guildId, creatorId: 'organizer', title: 'Synthetic event', description: 'V5 check',
    channelId: 'channel', startAt: new Date(now.getTime() + 1800_000), endAt: new Date(now.getTime() + 3600_000), maxParticipants: 1 });
  assert('eventPersistsAndReminders', (await events2.get(guildId, event.id))?.title === 'Synthetic event' &&
    (await db.select().from(eventReminders).where(eq(eventReminders.eventId, event.id))).length === 3);
  const presentationClaims = await Promise.all([events.claimPendingPresentations(now), events2.claimPendingPresentations(now)]);
  assert('eventPresentationClaimOnce', presentationClaims.flat().filter(item => item.id === event.id).length === 1);
  await events.syncAnnouncement(guildId, event.id, async () => ({ messageId: 'posted' }));
  assert('eventPresentationPersisted', (await events2.get(guildId, event.id))?.presentationPending === false &&
    (await events2.get(guildId, event.id))?.announcementMessageId === 'posted');
  const joined = await Promise.all([events.join(guildId, event.id, 'one'), events2.join(guildId, event.id, 'two')].map(p => p.catch(() => false)));
  assert('eventConcurrentFinalCapacity', joined.filter(Boolean).length === 1 && await events.count(event.id) === 1);
  const winner = joined[0] ? 'one' : 'two';
  assert('eventParticipantUnique', !await events2.join(guildId, event.id, winner) &&
    (await db.select().from(eventParticipants).where(eq(eventParticipants.eventId, event.id))).length === 1);
  let presentedCount = -1;
  const pendingAfterJoin = (await events2.get(guildId, event.id))?.presentationPending;
  await events2.syncAnnouncement(guildId, event.id, async (_row, members) => { presentedCount = members; return {}; });
  assert('eventRsvpPresentationRecovery', pendingAfterJoin && presentedCount === 1 &&
    (await events.get(guildId, event.id))?.presentationPending === false);
  const reminderClock = new Date(now.getTime() + 1200_000); // The ten-minute reminder for an event 30 minutes out.
  const due = await Promise.all([events.claimDue(reminderClock), events2.claimDue(reminderClock)]);
  assert('reminderClaimOnce', due.flat().filter(item => item.event.id === event.id).length === 1 &&
    due.flat().find(item => item.event.id === event.id)?.reminder.offsetSeconds === 600);
  assert('reminderCancelClaimRace', !!await events.transition(guildId, event.id, 'SCHEDULED', 'ACTIVE') &&
    (await events2.claimDue(now)).every(item => item.event.id !== event.id) &&
    (await db.select().from(eventReminders).where(eq(eventReminders.eventId, event.id))).every(item => item.status === 'CANCELLED') &&
    !await events.deliverReminder(guildId, event.id, 3600, now, now, async () => 'late', async () => true));
  assert('attendanceExplicitOnly', await events.attend(guildId, event.id, winner, 'organizer') &&
    !await events2.attend(guildId, event.id, winner, 'organizer') &&
    (await db.select().from(eventAttendance).where(eq(eventAttendance.eventId, event.id))).length === 1);
  stage = 'giveaways';
  const prize = await giveaway.create({ guildId, creatorId: 'organizer', channelId: 'channel', messageId: 'posted',
    prize: 'Synthetic prize', startAt: new Date(now.getTime() - 3600_000), endAt: new Date(now.getTime() + 3600_000),
    winnerCount: 1, requireVerified: true, minLevel: 5 });
  assert('giveawayEligibilityPersisted', (await giveaway2.get(guildId, prize.id))?.minLevel === 5 &&
    (await giveaway2.get(guildId, prize.id))?.requireVerified === true);
  const [first, second] = await Promise.all([giveaway.entry(prize.id, 'qualified', 'enter', 'channel', 'posted'),
    giveaway2.entry(prize.id, 'qualified', 'enter', 'channel', 'posted')]);
  assert('giveawayEntryConcurrentUnique', [first, second].filter(Boolean).length === 1 && await giveaway.entryCount(prize.id) === 1);
  await giveaway.entry(prize.id, 'unqualified', 'enter', 'channel', 'posted');
  await giveaway.entry(prize.id, 'second', 'enter', 'channel', 'posted');
  await db.insert(memberLevels).values([{ guildId, userId: 'qualified', xp: 2500, messageCount: 10 },
    { guildId, userId: 'second', xp: 2500, messageCount: 10 }]);
  await db.insert(memberVerifications).values([{ guildId, userId: 'qualified', status: 'VERIFIED' },
    { guildId, userId: 'second', status: 'VERIFIED' }]);
  const eligible = async (userId: string, tx: Parameters<Parameters<GiveawayRepository['draw']>[4]>[1]) =>
    await giveaway.verified(guildId, userId, tx) && (await giveaway.level(guildId, userId, tx) ?? 0) >= 2500;
  const pick = (ids: string[], count: number) => ids.slice(0, count);
  const drawAt = new Date(now.getTime() + 7200_000);
  const entrants = ['qualified', 'second', 'unqualified'];
  const drawn = await Promise.all([giveaway.draw(guildId, prize.id, 'ORIGINAL', entrants, eligible, pick, drawAt),
    giveaway2.draw(guildId, prize.id, 'ORIGINAL', entrants, eligible, pick, drawAt)]);
  assert('giveawayConcurrentOriginal', drawn.filter(row => row.state === 'DRAWN').length === 1 &&
    drawn.filter(row => row.state === 'ALREADY').length === 1 && drawn.find(row => row.state === 'DRAWN')?.winners?.[0] === 'qualified');
  const reroll = await giveaway2.draw(guildId, prize.id, 'REROLL', entrants, eligible, pick, drawAt);
  assert('giveawayRerollHistory', reroll.state === 'DRAWN' && reroll.winners?.[0] === 'second' &&
    (await giveaway.draws(prize.id)).length === 2 && (await giveaway.winners(prize.id)).length === 2);
  const history = await giveaway.draws(prize.id);
  const originalDraw = history.find(item => item.kind === 'ORIGINAL')!;
  const rerollDraw = history.find(item => item.kind === 'REROLL')!;
  const claims = await Promise.all([giveaway.claimDrawNotice(originalDraw.id), giveaway2.claimDrawNotice(originalDraw.id)]);
  const firstClaim = claims.find(Boolean)!;
  assert('giveawayNoticeClaimUnique', claims.filter(Boolean).length === 1 &&
    await giveaway.finishDrawNotice(originalDraw.id, firstClaim, 'original-result') &&
    !await giveaway2.claimDrawNotice(originalDraw.id));
  const rerollClaim = await giveaway.claimDrawNotice(rerollDraw.id);
  if (rerollClaim) await giveaway.releaseDrawNotice(rerollDraw.id, rerollClaim);
  const retried = await giveaway2.claimDrawNotice(rerollDraw.id);
  assert('giveawayRerollNoticeRetry', !!rerollClaim && !!retried &&
    await giveaway2.finishDrawNotice(rerollDraw.id, retried, 'reroll-result') &&
    (await giveaway.pendingDrawNotices(10)).length === 0);
  stage = 'tempvoice';
  await db.insert(tempvoiceSettings).values({ guildId, enabled: true, lobbyChannelId: 'lobby' });
  const reservations = await Promise.all([voice.reserve(guildId, 'owner'), voice2.reserve(guildId, 'owner')]);
  assert('tempvoiceConcurrentOwnerUnique', reservations.filter(item => item.created).length === 1 &&
    reservations[0]!.row.id === reservations[1]!.row.id);
  const room = reservations[0]!.row;
  await voice.attach(room.id, 'room'); await voice.activate(room.id);
  const transferred = await voice2.transfer(guildId, 'room', 'owner', 'new-owner', async () => async () => {});
  assert('tempvoiceTransferPersistent', transferred.ownerId === 'new-owner' && !(await voice.byOwner(guildId, 'owner')) &&
    (await voice.byOwner(guildId, 'new-owner'))?.id === room.id);
  await voice.markEmpty(guildId, 'room', true);
  const firstEmpty = (await voice2.byChannel(guildId, 'room'))?.emptySince;
  await voice2.markEmpty(guildId, 'room', true);
  assert('tempvoiceEmptySinceStable', !!firstEmpty && (await voice.byChannel(guildId, 'room'))?.emptySince?.getTime() === firstEmpty.getTime());
  assert('tempvoiceCleanupIdempotent', await voice.cleanup(room.id, row => row.status === 'ACTIVE' && !!row.emptySince,
    async () => true) && !await voice2.cleanup(room.id, row => row.status === 'ACTIVE', async () => true) &&
    !(await voice.byOwner(guildId, 'new-owner')));
  stage = 'achievements';
  const modules = { isEnabled: async (_guild: string, key: string) => key === 'achievements' || key === 'levels' };
  const achievements = new AchievementsService(achievement, modules);
  const achievements2 = new AchievementsService(achievement2, modules);
  const awards = await Promise.all([achievements.onLevel(guildId, 'qualified', 5, 100),
    achievements2.onLevel(guildId, 'qualified', 5, 100)]);
  assert('achievementConcurrentUnique', awards.flat().length === 3 &&
    (await achievement.list(guildId, 'qualified')).length === 3);
  assert('achievementThresholds', (await achievements.onLevel(guildId, 'qualified', 10, 100)).join(',') === 'level-10' &&
    (await achievement2.list(guildId, 'qualified')).length === 4);
  let presentation = '';
  await achievementsCommand.execute({ guildId, user: { id: 'qualified' }, options: { getUser: () => null },
    editReply: async (payload: { content: string }) => { presentation = payload.content; } } as never,
  { achievements } as never);
  assert('achievementSyntheticPresentation', presentation.includes('Rising Star') && presentation.includes('Veteran') &&
    !presentation.includes('moderator') && !presentation.includes('ticket'));
  checks.passedCount = Object.values(checks).filter(value => value === true).length;
} catch (error) {
  checks.failedStage = stage; checks.errorClass = errorClass(error); process.exitCode = 1;
} finally {
  if (a) {
    try {
      const client = await a.pool.connect();
      try {
        await client.query('DELETE FROM guilds WHERE id = $1', [guildId]);
        const remaining = await client.query(`SELECT
          (SELECT count(*) FROM guilds WHERE id = $1) +
          (SELECT count(*) FROM community_events WHERE guild_id = $1) +
          (SELECT count(*) FROM giveaways WHERE guild_id = $1) +
          (SELECT count(*) FROM tempvoice_rooms WHERE guild_id = $1) +
          (SELECT count(*) FROM member_achievements WHERE guild_id = $1) AS count`, [guildId]);
        assert('syntheticDataRemoved', Number(remaining.rows[0]?.count) === 0);
      } finally { client.release(); }
    } catch (error) { checks.cleanupErrorClass = errorClass(error); process.exitCode = 1; }
  }
  for (const connection of [b, a]) if (connection) try { await connection.pool.end(); }
    catch (error) { checks.poolCloseErrorClass = errorClass(error); process.exitCode = 1; }
  checks.passedCount = Object.values(checks).filter(value => value === true).length;
  console.log(JSON.stringify(checks));
}
