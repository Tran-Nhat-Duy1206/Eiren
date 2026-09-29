import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { aiRequests, aiUsageDaily, guilds, guildModules } from '../core/database/schema.js';
import { pruneAiMetadata } from '../modules/ai/retention.js';
import { AiRepository } from '../modules/ai/repository.js';

const connection = createDatabase(loadEnv().DATABASE_URL);
const db = connection.db;
const guildId = `retention-check-${randomUUID()}`;
const at = new Date('2025-06-15T12:00:00Z');
const oldDay = '2023-01-01', recentDay = '2025-06-01';
const old = new Date('2023-01-01T12:00:00Z');
const checks: Record<string, boolean> = {};
function check(name: string, passes: boolean) { checks[name] = passes; if (!passes) throw new Error(name); }
const key = (n: number) => `retention-${n}`;
const insertRequest = async (n: number, status: 'RESERVED' | 'SETTLED', day = oldDay,
  createdAt = old, leaseUntil = new Date('2023-01-02T00:00:00Z')) => {
  const id = randomUUID();
  await db.insert(aiRequests).values({ id, guildId, userId: '12345678901234567', requestKey: key(n),
    usageDay: day, epoch: 0, modelId: 'synthetic', reservedInputTokens: 1, reservedOutputTokens: 1,
    reservedCostMicros: 10, createdAt, leaseUntil, status,
    ...(status === 'SETTLED' ? { settledAt: createdAt, actualCostMicros: 10 } : {}) });
  return id;
};
try {
  await db.insert(guilds).values({ id: guildId });
  await db.insert(guildModules).values({ guildId, moduleKey: 'ai', enabled: true, updatedBy: 'synthetic' });
  await db.insert(aiUsageDaily).values([{ guildId, utcDay: oldDay, requests: 504,
    reservedCostMicros: 20, settledCostMicros: 5020 }, { guildId, utcDay: recentDay }]);
  for (let n = 0; n < 502; n++) await insertRequest(n, 'SETTLED');
  const expiredId = await insertRequest(502, 'RESERVED');
  const liveId = await insertRequest(503, 'RESERVED', oldDay, old, new Date('2026-01-01T00:00:00Z'));
  const recentId = await insertRequest(504, 'SETTLED', recentDay, new Date('2025-06-01T00:00:00Z'));
  const first = await pruneAiMetadata(db, at);
  check('batchBoundsAndExpiredAccounting', first.expired === 1 && first.requestsPruned === 500 && first.usageDaysPruned === 0);
  const [usage] = await db.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, guildId), eq(aiUsageDaily.utcDay, oldDay)));
  check('countersExact', usage?.reservedCostMicros === 10 && usage.settledCostMicros === 5030 && usage.requests === 504);
  check('liveAndRecentPreserved', (await db.select().from(aiRequests).where(eq(aiRequests.id, liveId))).length === 1 &&
    (await db.select().from(aiRequests).where(eq(aiRequests.id, recentId))).length === 1);
  check('expiredNeverReserved', (await db.select().from(aiRequests).where(eq(aiRequests.id, expiredId)))
    .every(row => row.status === 'EXPIRED'));
  const second = await pruneAiMetadata(db, at);
  check('referenceGuardsOldUsage', second.requestsPruned === 3 && second.usageDaysPruned === 0);
  const anchorId = await insertRequest(506, 'SETTLED', oldDay, new Date('2025-06-01T00:00:00Z'));
  // Keep the old usage row for inspecting exact accounting even when the pruner wins.
  // Hold the actual global lock while prune and settle both wait; neither can delete a live lease.
  let unlock!: () => void;
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const held = db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(0, hashtext('eiren-ai-budget'))`);
    ready();
    await new Promise<void>(resolve => { unlock = resolve; });
  });
  await waiting;
  const pruning = pruneAiMetadata(db, at);
  const settling = new AiRepository(db).settle({ id: liveId, guildId, userId: '12345678901234567', epoch: 0,
    modelId: 'synthetic', reservedCostMicros: 10, leaseUntil: new Date('2026-01-01T00:00:00Z') },
  { inputTokens: 0, outputTokens: 0, costMicros: 4 }, at);
  unlock();
  await held;
  await Promise.all([pruning, settling]);
  const [raceRow] = await db.select().from(aiRequests).where(eq(aiRequests.id, liveId));
  const [raceUsage] = await db.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, guildId), eq(aiUsageDaily.utcDay, oldDay)));
  check('heldLockPruneVsSettleExactlyOnce', raceUsage?.reservedCostMicros === 0 &&
    raceUsage.settledCostMicros === 5034 && (!raceRow || raceRow.status === 'SETTLED'));
  // Both contenders see a lease that has genuinely expired: only one may charge it.
  const expiredRaceId = await insertRequest(505, 'RESERVED');
  await db.update(aiUsageDaily).set({ reservedCostMicros: 10 })
    .where(and(eq(aiUsageDaily.guildId, guildId), eq(aiUsageDaily.utcDay, oldDay)));
  let releaseExpired!: () => void, expiredReady!: () => void;
  const expiredHeldReady = new Promise<void>(resolve => { expiredReady = resolve; });
  const expiredHeld = db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(0, hashtext('eiren-ai-budget'))`);
    expiredReady();
    await new Promise<void>(resolve => { releaseExpired = resolve; });
  });
  await expiredHeldReady;
  const expiredPrune = pruneAiMetadata(db, at);
  const expiredSettle = new AiRepository(db).settle({ id: expiredRaceId, guildId,
    userId: '12345678901234567', epoch: 0, modelId: 'synthetic', reservedCostMicros: 10,
    leaseUntil: new Date('2023-01-02T00:00:00Z') }, { inputTokens: 0, outputTokens: 0, costMicros: 4 }, at);
  releaseExpired();
  await expiredHeld;
  await Promise.all([expiredPrune, expiredSettle]);
  const [afterExpiredRace] = await db.select().from(aiUsageDaily)
    .where(and(eq(aiUsageDaily.guildId, guildId), eq(aiUsageDaily.utcDay, oldDay)));
  const [expiredRaceRow] = await db.select().from(aiRequests).where(eq(aiRequests.id, expiredRaceId));
  check('expiredLeasePruneVsSettleChargesOnce', afterExpiredRace?.reservedCostMicros === 0 &&
    afterExpiredRace.settledCostMicros === 5044 && (!expiredRaceRow || expiredRaceRow.status === 'EXPIRED'));
  await db.delete(aiRequests).where(eq(aiRequests.id, anchorId));
  const final = await pruneAiMetadata(db, at);
  check('oldUsagePrunedWithoutReferences', final.usageDaysPruned === 1 &&
    (await db.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, guildId), eq(aiUsageDaily.utcDay, oldDay)))).length === 0);
  check('newUsagePreserved', (await db.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, guildId),
    eq(aiUsageDaily.utcDay, recentDay)))).length === 1);
  console.log(JSON.stringify(checks));
} catch (error) {
  console.error(JSON.stringify({ checks, errorType: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally {
  try { await db.delete(guilds).where(eq(guilds.id, guildId)); }
  finally { await connection.pool.end(); }
}
