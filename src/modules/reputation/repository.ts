import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { memberReputation, reputationGrants, reputationSettings } from '../../core/database/schema.js';
import { AppError } from '../../core/errors/errors.js';

export type ReputationConfig = { globalCooldownSeconds: number; sameTargetCooldownSeconds: number };
export const defaultReputationConfig: ReputationConfig = { globalCooldownSeconds: 86400, sameTargetCooldownSeconds: 604800 };

export class ReputationRepository {
  constructor(private readonly db: Database) {}
  async settings(guildId: string): Promise<ReputationConfig> {
    const [row] = await this.db.select().from(reputationSettings).where(eq(reputationSettings.guildId, guildId));
    return row ?? defaultReputationConfig;
  }
  async configure(guildId: string, config: ReputationConfig) {
    const [row] = await this.db.insert(reputationSettings).values({ guildId, ...config })
      .onConflictDoUpdate({ target: reputationSettings.guildId, set: config }).returning();
    return row!;
  }
  async score(guildId: string, userId: string): Promise<number> {
    const [row] = await this.db.select({ score: memberReputation.score }).from(memberReputation)
      .where(and(eq(memberReputation.guildId, guildId), eq(memberReputation.userId, userId)));
    return row?.score ?? 0;
  }
  /** Serializes all grants from one giver in one guild across processes and restarts. */
  async grant(guildId: string, giverId: string, receiverId: string): Promise<number> {
    return this.db.transaction(async tx => {
      // A two-text advisory key avoids JS integer precision loss and hash collisions are merely extra serialization.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), hashtext(${giverId}))`);
      const [config] = await tx.select().from(reputationSettings).where(eq(reputationSettings.guildId, guildId));
      const limits = config ?? defaultReputationConfig;
      const clock = await tx.execute(sql`SELECT clock_timestamp() AS now`);
      const now = new Date((clock.rows[0] as { now: string | Date }).now);
      const [latest] = await tx.select({ createdAt: reputationGrants.createdAt }).from(reputationGrants)
        .where(and(eq(reputationGrants.guildId, guildId), eq(reputationGrants.giverId, giverId)))
        .orderBy(desc(reputationGrants.createdAt), desc(reputationGrants.id)).limit(1);
      const [same] = await tx.select({ createdAt: reputationGrants.createdAt }).from(reputationGrants)
        .where(and(eq(reputationGrants.guildId, guildId), eq(reputationGrants.giverId, giverId), eq(reputationGrants.receiverId, receiverId)))
        .orderBy(desc(reputationGrants.createdAt), desc(reputationGrants.id)).limit(1);
      const globalRemaining = latest ? latest.createdAt.getTime() + limits.globalCooldownSeconds * 1000 - now.getTime() : 0;
      const targetRemaining = same ? same.createdAt.getTime() + limits.sameTargetCooldownSeconds * 1000 - now.getTime() : 0;
      if (globalRemaining > 0 || targetRemaining > 0) {
        const seconds = Math.ceil(Math.max(globalRemaining, targetRemaining) / 1000);
        throw new AppError('CONFLICT', `Reputation cooldown: try again in ${seconds} seconds.`);
      }
      await tx.insert(reputationGrants).values({ guildId, giverId, receiverId, createdAt: now });
      const [row] = await tx.insert(memberReputation).values({ guildId, userId: receiverId, score: 1, updatedAt: now })
        .onConflictDoUpdate({ target: [memberReputation.guildId, memberReputation.userId],
          set: { score: sql`${memberReputation.score} + 1`, updatedAt: now } }).returning({ score: memberReputation.score });
      return row!.score;
    });
  }
}
