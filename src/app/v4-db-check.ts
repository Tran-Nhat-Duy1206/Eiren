import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { guilds, memberLevels, reputationGrants, starboardMessages } from '../core/database/schema.js';
import { LevelsRepository } from '../modules/levels/repository.js';
import { ReputationRepository } from '../modules/reputation/repository.js';
import { StarboardRepository } from '../modules/starboard/repository.js';

const checks: Record<string, boolean | string> = {};
const assert = (name: string, condition: unknown) => {
  checks[name] = Boolean(condition);
  if (!condition) throw new Error(name);
};
const errorClass = (error: unknown) => error instanceof Error ? error.constructor.name : 'unknown';
const guildId = `v4-check-${randomUUID()}`;
const lockGuildId = `v4-lock-${randomUUID()}`;
const ids = { one: 'v4-user-one', two: 'v4-user-two', three: 'v4-user-three', four: 'v4-user-four' };
let stage = 'initialize';
let pool: ReturnType<typeof createDatabase>['pool'] | undefined;

try {
  const connection = createDatabase(loadEnv().DATABASE_URL);
  const db = connection.db;
  pool = connection.pool;
  stage = 'schema';
  const expected = ['levels_settings', 'member_levels', 'level_rewards', 'level_ignored_channels',
    'reputation_settings', 'member_reputation', 'reputation_grants', 'starboard_settings',
    'starboard_messages', 'starboard_ignored_channels'];
  const tables = await db.execute(sql`select table_name from information_schema.tables where table_schema = current_schema()
    and table_name in ('levels_settings', 'member_levels', 'level_rewards', 'level_ignored_channels',
      'reputation_settings', 'member_reputation', 'reputation_grants', 'starboard_settings',
      'starboard_messages', 'starboard_ignored_channels')`);
  assert('tenV4Tables', tables.rows.length === 10 && expected.every(name => tables.rows.some(row => row.table_name === name)));
  const journal = await db.execute(sql`select count(*)::int as count from drizzle.__drizzle_migrations`);
  assert('journalAtLeastFive', Number(journal.rows[0]?.count) >= 5);
  await db.insert(guilds).values([{ id: guildId }, { id: lockGuildId }]);
  const levels = new LevelsRepository(db), levelsAgain = new LevelsRepository(db);
  const rep = new ReputationRepository(db), repAgain = new ReputationRepository(db);
  const stars = new StarboardRepository(db), starsAgain = new StarboardRepository(db);

  stage = 'levels';
  const settings = await levels.configure(guildId, { cooldownSeconds: 5, xpPerMessage: 100 });
  const t = Date.now() - 60_000;
  const input = (userId: string, messageId: string, at: number) => ({ guildId, userId, messageId, at, fingerprint: null });
  const [first, second] = await Promise.all([
    levels.award(input(ids.one, 'm1', t), settings), levelsAgain.award(input(ids.one, 'm2', t + 6000), settings),
  ]);
  const member = await levelsAgain.member(guildId, ids.one);
  assert('levelsConcurrentIncreasing', first && second && member?.xp === 200 && member.messageCount === 2);
  assert('levelsCooldownNewInstance', await levelsAgain.award(input(ids.one, 'm3', t + 7000), settings) === null);
  await levels.award(input(ids.two, 'm4', t), settings);
  assert('levelsRankTop', await levels.rank(guildId, ids.one, 200) === 1 &&
    (await levels.top(guildId, 2)).map(row => row.userId).join(',') === `${ids.one},${ids.two}`);
  await levels.addReward(guildId, 1, 'role');
  await levelsAgain.addReward(guildId, 1, 'role');
  assert('levelRewardUnique', (await levels.rewards(guildId)).filter(row => row.level === 1 && row.roleId === 'role').length === 1);

  stage = 'reputation';
  await rep.configure(guildId, { globalCooldownSeconds: 60, sameTargetCooldownSeconds: 120 });
  const parallel = await Promise.allSettled([rep.grant(guildId, ids.one, ids.three), repAgain.grant(guildId, ids.one, ids.three)]);
  assert('reputationConcurrentOneGrant', parallel.filter(row => row.status === 'fulfilled').length === 1 &&
    parallel.filter(row => row.status === 'rejected' && errorClass(row.reason) === 'AppError').length === 1);
  const rejected = async (action: () => Promise<unknown>) => {
    try { await action(); return false; } catch (error) { return errorClass(error) === 'AppError'; }
  };
  assert('reputationGlobalNewInstance', await rejected(() => repAgain.grant(guildId, ids.one, ids.four)));
  await db.update(reputationGrants).set({ createdAt: new Date(Date.now() - 90_000) }).where(eq(reputationGrants.guildId, guildId));
  assert('reputationSameTargetNewInstance', await rejected(() => repAgain.grant(guildId, ids.one, ids.three)));
  assert('reputationDifferentTargetAfterGlobal', await repAgain.grant(guildId, ids.one, ids.four) === 1);
  assert('reputationOtherGiverUpsert', await rep.grant(guildId, ids.two, ids.three) === 2 &&
    await repAgain.score(guildId, ids.three) === 2);
  const history = await db.select().from(reputationGrants).where(eq(reputationGrants.guildId, guildId));
  assert('reputationHistory', history.length === 3 && history.filter(row => row.receiverId === ids.three).length === 2);

  stage = 'starboard';
  const source = { guildId, sourceChannelId: 'channel', sourceMessageId: 'source', sourceAuthorId: ids.one };
  let publishes = 0;
  const publish = (repository: StarboardRepository) => repository.transaction(async tx => {
    const row = await repository.lock(tx, source);
    if (row.status === 'PENDING') {
      publishes++;
      await repository.save(tx, row, { status: 'POSTED', starboardChannelId: 'board', starboardMessageId: 'posted', starCount: 5 });
    }
  });
  await Promise.all([publish(stars), publish(starsAgain)]);
  assert('starboardSinglePublishCallback', publishes === 1);
  const mapped = await starsAgain.get(guildId, source.sourceMessageId);
  assert('starboardMappingNewInstance', mapped?.status === 'POSTED' && mapped.starboardMessageId === 'posted');
  await starsAgain.transaction(async tx => {
    const row = await starsAgain.lock(tx, source);
    await starsAgain.save(tx, row, { starCount: 7 });
  });
  assert('starboardCountUpdate', (await stars.get(guildId, source.sourceMessageId))?.starCount === 7);
  assert('starboardSourceUnique', (await db.select().from(starboardMessages).where(eq(starboardMessages.guildId, guildId))).length === 1);

  stage = 'ignoreLock';
  const channelId = 'synthetic-source';
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  let locked: Promise<void> | undefined;
  try {
    locked = stars.reconcileTransaction(lockGuildId, channelId, async tx => {
      const row = await stars.lock(tx, { guildId: lockGuildId, sourceChannelId: channelId,
        sourceMessageId: 'message', sourceAuthorId: 'human' });
      reached();
      await gate;
      await stars.save(tx, row, { starboardChannelId: 'board', starboardMessageId: 'mirror', status: 'POSTED', starCount: 5 });
    });
    await entered;
    let completed = false;
    const ignored = starsAgain.ignore(lockGuildId, channelId).then(() => { completed = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    const blocked = !completed;
    release();
    await Promise.all([locked, ignored]);
    assert('sharedReconcileLockBlocksIgnore', blocked);
    assert('ignorePersistsAfterPublish', completed && await starsAgain.ignored(lockGuildId, channelId) &&
      (await starsAgain.postsFrom(lockGuildId, channelId)).length === 1);
  } finally {
    release();
    await locked?.catch(() => undefined);
  }
} catch (error) {
  checks.failedStage = stage;
  checks.errorClass = errorClass(error);
  process.exitCode = 1;
} finally {
  if (pool) {
    try {
      const client = await pool.connect();
      try {
        await client.query('DELETE FROM guilds WHERE id = ANY($1::text[])', [[guildId, lockGuildId]]);
        const remaining = await client.query(`SELECT
          (SELECT count(*) FROM member_levels WHERE guild_id = ANY($1::text[])) +
          (SELECT count(*) FROM reputation_grants WHERE guild_id = ANY($1::text[])) +
          (SELECT count(*) FROM starboard_messages WHERE guild_id = ANY($1::text[])) +
          (SELECT count(*) FROM starboard_ignored_channels WHERE guild_id = ANY($1::text[])) +
          (SELECT count(*) FROM guilds WHERE id = ANY($1::text[])) AS count`, [[guildId, lockGuildId]]);
        assert('syntheticDataRemoved', Number(remaining.rows[0]?.count) === 0);
      } finally { client.release(); }
    } catch (error) {
      checks.cleanupErrorClass = errorClass(error);
      process.exitCode = 1;
    }
    try { await pool.end(); } catch (error) {
      checks.poolCloseErrorClass = errorClass(error);
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(checks));
}
