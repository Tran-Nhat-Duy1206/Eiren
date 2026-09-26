import { and, eq, desc, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { guildPermissionRoles, levelsSettings, memberLevels, levelRewards, levelIgnoredChannels } from '../../core/database/schema.js';
import { eligibleMessage, levelForXp } from './formula.js';

export type LevelSettings = typeof levelsSettings.$inferSelect;
export type MemberLevel = typeof memberLevels.$inferSelect;
export type LevelReward = typeof levelRewards.$inferSelect;
export type AwardInput = { guildId: string; userId: string; messageId: string; at: number; fingerprint: string | null };
export class LevelsRepository {
  constructor(private readonly db: Database) {}
  async settings(guildId: string) {
    const [row] = await this.db.select().from(levelsSettings).where(eq(levelsSettings.guildId, guildId));
    if (row) return row;
    await this.db.insert(levelsSettings).values({ guildId }).onConflictDoNothing();
    const [created] = await this.db.select().from(levelsSettings).where(eq(levelsSettings.guildId, guildId));
    return created!;
  }
  async configure(guildId: string, patch: Partial<Pick<LevelSettings, 'cooldownSeconds' | 'xpPerMessage' | 'minLength' | 'levelUpChannelId'>>) {
    await this.settings(guildId);
    const [row] = await this.db.update(levelsSettings).set(patch).where(eq(levelsSettings.guildId, guildId)).returning();
    return row!;
  }
  async ignored(guildId: string, channelId: string) {
    const [row] = await this.db.select({ channelId: levelIgnoredChannels.channelId }).from(levelIgnoredChannels)
      .where(and(eq(levelIgnoredChannels.guildId, guildId), eq(levelIgnoredChannels.channelId, channelId)));
    return !!row;
  }
  async ignore(guildId: string, channelId: string) {
    await this.db.insert(levelIgnoredChannels).values({ guildId, channelId }).onConflictDoNothing();
  }
  async allow(guildId: string, channelId: string) {
    await this.db.delete(levelIgnoredChannels).where(and(eq(levelIgnoredChannels.guildId, guildId), eq(levelIgnoredChannels.channelId, channelId)));
  }
  ignoredChannels(guildId: string) { return this.db.select().from(levelIgnoredChannels).where(eq(levelIgnoredChannels.guildId, guildId)); }
  async mappedRole(guildId: string, roleId: string) {
    const [row] = await this.db.select({ roleId: guildPermissionRoles.roleId }).from(guildPermissionRoles)
      .where(and(eq(guildPermissionRoles.guildId, guildId), eq(guildPermissionRoles.roleId, roleId)));
    return !!row;
  }
  async addReward(guildId: string, level: number, roleId: string) {
    await this.db.insert(levelRewards).values({ guildId, level, roleId }).onConflictDoNothing();
  }
  async removeReward(guildId: string, level: number, roleId: string) {
    await this.db.delete(levelRewards).where(and(eq(levelRewards.guildId, guildId), eq(levelRewards.level, level), eq(levelRewards.roleId, roleId)));
  }
  rewards(guildId: string) { return this.db.select().from(levelRewards).where(eq(levelRewards.guildId, guildId)).orderBy(levelRewards.level); }
  member(guildId: string, userId: string) { return this.db.select().from(memberLevels).where(and(eq(memberLevels.guildId, guildId), eq(memberLevels.userId, userId))).then(rows => rows[0]); }
  async rank(guildId: string, userId: string, xp: number) {
    const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(memberLevels)
      .where(and(eq(memberLevels.guildId, guildId), sql`(${memberLevels.xp} > ${xp} or (${memberLevels.xp} = ${xp} and ${memberLevels.userId} < ${userId}))`));
    return Number(row?.count ?? 0) + 1;
  }
  top(guildId: string, limit = 10) { return this.db.select().from(memberLevels).where(eq(memberLevels.guildId, guildId))
    .orderBy(desc(memberLevels.xp), memberLevels.userId).limit(limit); }
  /** Transaction-scoped advisory lock serializes first insert and subsequent updates across workers/processes. */
  async award(input: AwardInput, settings: LevelSettings) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`levels:${input.guildId}:${input.userId}`}, 0))`);
      const [prior] = await tx.select().from(memberLevels).where(and(eq(memberLevels.guildId, input.guildId), eq(memberLevels.userId, input.userId))).for('update');
      if (!eligibleMessage(input, prior ?? { lastMessageId: null, lastXpAt: null, lastFingerprint: null }, settings.cooldownSeconds, input.fingerprint)) return null;
      const xp = (prior?.xp ?? 0) + settings.xpPerMessage;
      if (!Number.isSafeInteger(xp)) return null;
      const before = levelForXp(prior?.xp ?? 0), after = levelForXp(xp);
      const values = { guildId: input.guildId, userId: input.userId, xp, messageCount: (prior?.messageCount ?? 0) + 1,
        lastXpAt: new Date(input.at), lastMessageId: input.messageId, lastFingerprint: input.fingerprint, updatedAt: new Date() };
      if (prior) await tx.update(memberLevels).set(values).where(and(eq(memberLevels.guildId, input.guildId), eq(memberLevels.userId, input.userId)));
      else await tx.insert(memberLevels).values(values);
      const rewards = after > before ? await tx.select().from(levelRewards).where(and(eq(levelRewards.guildId, input.guildId),
        sql`${levelRewards.level} > ${before}`, sql`${levelRewards.level} <= ${after}`)) : [];
      return { xp, before, after, messageCount: values.messageCount, rewards };
    });
  }
}
