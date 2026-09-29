import { and, eq, lt, lte, ne, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { aiRequests, aiUsageDaily } from '../../core/database/schema.js';

export const AI_RETENTION_BATCH = 500;
export type AiRetentionResult = Readonly<{ expired: number; requestsPruned: number; usageDaysPruned: number }>;

/** A single bounded pass; the same global lock serializes this with admission and settlement. */
export async function pruneAiMetadata(db: Database, at?: Date): Promise<AiRetentionResult> {
  if (at !== undefined && !Number.isFinite(at.getTime())) throw new Error('Invalid AI retention clock');
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(0, hashtext('eiren-ai-budget'))`);
    // Compute the real clock after waiting for the lock, as admission and settlement do.
    const now = at ?? new Date();
    const requestCutoff = new Date(now.getTime() - 30 * 86_400_000);
    const usageCutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1))
      .toISOString().slice(0, 10);
    // First account for stale leases. A request may be old but must never be deleted RESERVED.
    const expired = await tx.select().from(aiRequests)
      .where(and(eq(aiRequests.status, 'RESERVED'), lte(aiRequests.leaseUntil, now), lt(aiRequests.createdAt, requestCutoff)))
      .orderBy(aiRequests.createdAt, aiRequests.id).limit(AI_RETENTION_BATCH).for('update');
    for (const request of expired) {
      await tx.update(aiRequests).set({ status: 'EXPIRED', actualCostMicros: request.reservedCostMicros,
        settledAt: now }).where(eq(aiRequests.id, request.id));
      const counters = await tx.update(aiUsageDaily).set({
        reservedCostMicros: sql`${aiUsageDaily.reservedCostMicros} - ${request.reservedCostMicros}`,
        settledCostMicros: sql`${aiUsageDaily.settledCostMicros} + ${request.reservedCostMicros}`,
      }).where(and(eq(aiUsageDaily.guildId, request.guildId), eq(aiUsageDaily.utcDay, request.usageDay)))
        .returning({ guildId: aiUsageDaily.guildId });
      if (counters.length !== 1) throw new Error('AI retention missing usage counter');
    }
    // A terminal row may be pruned, including one just expired; the durable daily charge remains.
    const terminal = await tx.select({ id: aiRequests.id }).from(aiRequests)
      .where(and(ne(aiRequests.status, 'RESERVED'), lt(aiRequests.createdAt, requestCutoff)))
      .orderBy(aiRequests.createdAt, aiRequests.id).limit(AI_RETENTION_BATCH).for('update');
    if (terminal.length) await tx.delete(aiRequests).where(sql`${aiRequests.id} IN (${sql.join(terminal.map(row => sql`${row.id}`), sql`, `)})`);
    // NOT EXISTS explicitly guards the cascading FK, including live requests on old usage days.
    const days = await tx.select({ guildId: aiUsageDaily.guildId, utcDay: aiUsageDaily.utcDay })
      .from(aiUsageDaily).where(and(lt(aiUsageDaily.utcDay, usageCutoff),
        sql`NOT EXISTS (SELECT 1 FROM ai_requests r WHERE r.guild_id = ${aiUsageDaily.guildId}
          AND r.usage_day = ${aiUsageDaily.utcDay})`))
      .orderBy(aiUsageDaily.utcDay, aiUsageDaily.guildId).limit(AI_RETENTION_BATCH).for('update');
    for (const day of days) {
      await tx.delete(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, day.guildId),
        eq(aiUsageDaily.utcDay, day.utcDay), sql`NOT EXISTS (SELECT 1 FROM ai_requests r
          WHERE r.guild_id = ${day.guildId} AND r.usage_day = ${day.utcDay})`));
    }
    return Object.freeze({ expired: expired.length, requestsPruned: terminal.length, usageDaysPruned: days.length });
  });
}
