import { randomUUID } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { giveaways, giveawayEntries, giveawayDraws, giveawayWinners, guildModules, memberLevels, memberVerifications } from '../../core/database/schema.js';

export type Giveaway = typeof giveaways.$inferSelect;
export type GiveawayInput = typeof giveaways.$inferInsert;
export type DrawKind = 'ORIGINAL' | 'REROLL';
export class GiveawayRepository {
  constructor(private readonly db: Database) {}
  async create(input: GiveawayInput) { const [row] = await this.db.insert(giveaways).values(input).returning(); return row!; }
  async get(guildId: string, id: number) { const [row] = await this.db.select().from(giveaways).where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, id))); return row; }
  async attach(guildId: string, id: number, messageId: string) { const [row] = await this.db.update(giveaways).set({ messageId, updatedAt: new Date() }).where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, id), eq(giveaways.status, 'ACTIVE'), sql`${giveaways.messageId} is null`)).returning(); return row; }
  async claimAnnouncement(id: number, now = new Date()) {
    const token = `PENDING:${now.getTime()}:${randomUUID()}`;
    const [row] = await this.db.update(giveaways).set({ resultAnnouncementId: token, updatedAt: now })
      .where(and(eq(giveaways.id, id), eq(giveaways.status, 'ENDED'),
        sql`(${giveaways.resultAnnouncementId} is null or (${giveaways.resultAnnouncementId} like 'PENDING:%' and ${giveaways.updatedAt} < ${new Date(now.getTime() - 120000)}))`)).returning();
    return row ? token : null;
  }
  async finishAnnouncement(id: number, token: string, messageId: string) {
    await this.db.update(giveaways).set({ resultAnnouncementId: messageId, updatedAt: new Date() })
      .where(and(eq(giveaways.id, id), eq(giveaways.resultAnnouncementId, token)));
  }
  async releaseAnnouncement(id: number, token: string) {
    await this.db.update(giveaways).set({ resultAnnouncementId: null, updatedAt: new Date() })
      .where(and(eq(giveaways.id, id), eq(giveaways.resultAnnouncementId, token)));
  }
  async pendingAnnouncements(limit: number) { return this.db.select().from(giveaways).where(and(eq(giveaways.status, 'ENDED'),
    sql`(${giveaways.resultAnnouncementId} is null or ${giveaways.resultAnnouncementId} like 'PENDING:%')`))
    .orderBy(giveaways.endAt, giveaways.id).limit(limit); }
  /** A conditional lease keeps concurrent schedulers from posting the same missing announcement. */
  async claimPost(guildId: string, id: number, now = new Date()) {
    const token = `PENDING:${now.getTime()}:${randomUUID()}`;
    const [row] = await this.db.update(giveaways).set({ messageId: token, updatedAt: now })
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, id), eq(giveaways.status, 'ACTIVE'),
        sql`(${giveaways.messageId} is null or (${giveaways.messageId} like 'PENDING:%' and ${giveaways.updatedAt} < ${new Date(now.getTime() - 300000)}))`)).returning();
    return row ? token : null;
  }
  async finishPost(guildId: string, id: number, token: string, messageId: string) {
    const [row] = await this.db.update(giveaways).set({ messageId, updatedAt: new Date() })
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, id), eq(giveaways.status, 'ACTIVE'), eq(giveaways.messageId, token))).returning();
    return row ?? null;
  }
  async releasePost(guildId: string, id: number, token: string) {
    await this.db.update(giveaways).set({ messageId: null, updatedAt: new Date() })
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, id), eq(giveaways.messageId, token)));
  }
  async markMissing(guildId: string, id: number, messageId: string) {
    const [row] = await this.db.update(giveaways).set({ messageId: null, updatedAt: new Date() })
      .where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, id), eq(giveaways.status, 'ACTIVE'), eq(giveaways.messageId, messageId))).returning();
    return !!row;
  }
  async missingPosts(limit: number) { return this.db.select({ giveaway: giveaways }).from(giveaways)
    .innerJoin(guildModules, and(eq(guildModules.guildId, giveaways.guildId), eq(guildModules.moduleKey, 'giveaways'), eq(guildModules.enabled, true)))
    .where(and(eq(giveaways.status, 'ACTIVE'), sql`(${giveaways.messageId} is null or (${giveaways.messageId} like 'PENDING:%' and ${giveaways.updatedAt} < ${new Date(Date.now() - 300000)}))`))
    .orderBy(giveaways.endAt, giveaways.id).limit(limit).then(rows => rows.map(row => row.giveaway)); }
  async refreshCandidates(limit: number) { return this.db.select({ giveaway: giveaways }).from(giveaways)
    .innerJoin(guildModules, and(eq(guildModules.guildId, giveaways.guildId), eq(guildModules.moduleKey, 'giveaways'), eq(guildModules.enabled, true)))
    .where(sql`${giveaways.messageId} is not null and ${giveaways.messageId} not like 'PENDING:%'`).orderBy(giveaways.updatedAt, giveaways.id).limit(limit)
    .then(rows => rows.map(row => row.giveaway)); }
  async markRefreshAttempt(id: number, messageId: string) { await this.db.update(giveaways).set({ updatedAt: new Date() }).where(and(eq(giveaways.id, id), eq(giveaways.messageId, messageId))); }
  async entry(id: number, userId: string, action: 'enter' | 'leave', channelId: string, messageId: string) {
    return this.db.transaction(async tx => {
      const [giveaway] = await tx.select().from(giveaways).where(eq(giveaways.id, id)).for('update');
      if (!giveaway || giveaway.status !== 'ACTIVE' || giveaway.endAt <= new Date() || giveaway.channelId !== channelId || giveaway.messageId !== messageId) return null;
      if (action === 'enter') {
        const [existing] = await tx.select({ userId: giveawayEntries.userId }).from(giveawayEntries)
          .where(and(eq(giveawayEntries.giveawayId, id), eq(giveawayEntries.userId, userId)));
        if (existing) return false;
        const [total] = await tx.select({ count: sql<number>`count(*)::int` }).from(giveawayEntries).where(eq(giveawayEntries.giveawayId, id));
        if (Number(total?.count ?? 0) >= 300) return null;
        const [row] = await tx.insert(giveawayEntries).values({ giveawayId: id, userId }).onConflictDoNothing().returning(); return !!row;
      }
      const [row] = await tx.delete(giveawayEntries).where(and(eq(giveawayEntries.giveawayId, id), eq(giveawayEntries.userId, userId))).returning(); return !!row;
    });
  }
  async entryCount(id: number) { const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(giveawayEntries).where(eq(giveawayEntries.giveawayId, id)); return Number(row?.count ?? 0); }
  async entries(id: number, limit = 300) { return this.db.select({ userId: giveawayEntries.userId }).from(giveawayEntries).where(eq(giveawayEntries.giveawayId, id)).orderBy(giveawayEntries.userId).limit(limit + 1); }
  async verified(guildId: string, userId: string, db: Pick<Database, 'select'> = this.db) { const [row] = await db.select({ status: memberVerifications.status }).from(memberVerifications).where(and(eq(memberVerifications.guildId, guildId), eq(memberVerifications.userId, userId))); return row?.status === 'VERIFIED'; }
  async level(guildId: string, userId: string, db: Pick<Database, 'select'> = this.db) { const [row] = await db.select({ xp: memberLevels.xp }).from(memberLevels).where(and(eq(memberLevels.guildId, guildId), eq(memberLevels.userId, userId))); return row?.xp; }
  async winners(id: number) { return this.db.select({ userId: giveawayWinners.userId }).from(giveawayWinners).where(eq(giveawayWinners.giveawayId, id)); }
  async drawWinners(drawId: number) { return this.db.select({ userId: giveawayWinners.userId }).from(giveawayWinners)
    .where(eq(giveawayWinners.drawId, drawId)).orderBy(giveawayWinners.ordinal); }
  async pendingDrawNotices(limit: number) { return this.db.select({ draw: giveawayDraws, row: giveaways }).from(giveawayDraws)
    .innerJoin(giveaways, eq(giveawayDraws.giveawayId, giveaways.id))
    .innerJoin(guildModules, and(eq(guildModules.guildId, giveaways.guildId), eq(guildModules.moduleKey, 'giveaways'), eq(guildModules.enabled, true)))
    .where(sql`${giveawayDraws.resultAnnouncementId} is null`)
    .orderBy(giveawayDraws.createdAt, giveawayDraws.id).limit(limit); }
  async claimDrawNotice(drawId: number, now = new Date()) {
    const [row] = await this.db.update(giveawayDraws).set({ notificationClaimedAt: now })
      .where(and(eq(giveawayDraws.id, drawId), sql`${giveawayDraws.resultAnnouncementId} is null`,
        sql`(${giveawayDraws.notificationClaimedAt} is null or ${giveawayDraws.notificationClaimedAt} < ${new Date(now.getTime() - 300000)})`)).returning();
    return row?.notificationClaimedAt ?? null;
  }
  async finishDrawNotice(drawId: number, claim: Date, messageId: string) {
    const [row] = await this.db.update(giveawayDraws).set({ resultAnnouncementId: messageId, notificationClaimedAt: null })
      .where(and(eq(giveawayDraws.id, drawId), eq(giveawayDraws.notificationClaimedAt, claim), sql`${giveawayDraws.resultAnnouncementId} is null`)).returning();
    return !!row;
  }
  async releaseDrawNotice(drawId: number, claim: Date) {
    await this.db.update(giveawayDraws).set({ notificationClaimedAt: null })
      .where(and(eq(giveawayDraws.id, drawId), eq(giveawayDraws.notificationClaimedAt, claim)));
  }
  async draws(id: number) { return this.db.select().from(giveawayDraws).where(eq(giveawayDraws.giveawayId, id)); }
  async due(now: Date, limit = 20) { return this.db.select({ giveaway: giveaways }).from(giveaways)
    .innerJoin(guildModules, and(eq(guildModules.guildId, giveaways.guildId), eq(guildModules.moduleKey, 'giveaways'), eq(guildModules.enabled, true)))
    .where(and(eq(giveaways.status, 'ACTIVE'), lte(giveaways.endAt, now)))
    .orderBy(giveaways.endAt, giveaways.id).limit(limit).then(rows => rows.map(row => row.giveaway)); }
  /** Locks parent first, then rechecks entries, eligibility and past winners in the same transaction. */
  async draw(guildId: string, id: number, kind: DrawKind, expectedEntries: readonly string[], eligible: (userId: string, tx: Pick<Database, 'select'>) => Promise<boolean>, pick: (ids: string[], count: number) => string[], now = new Date(), maxEntries = 300) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(giveaways).where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, id))).for('update');
      if (!row) return { state: 'NOT_FOUND' as const };
      if (kind === 'ORIGINAL' && row.status === 'ENDED') return { state: 'ALREADY' as const, row };
      if (kind === 'ORIGINAL' && (row.status !== 'ACTIVE' || row.endAt > now)) return { state: 'NOT_DUE' as const, row };
      if (kind === 'REROLL' && row.status !== 'ENDED') return { state: 'NOT_ENDED' as const, row };
      const entries = await tx.select({ userId: giveawayEntries.userId }).from(giveawayEntries).where(eq(giveawayEntries.giveawayId, id)).orderBy(giveawayEntries.userId).limit(maxEntries + 1);
      if (entries.length > maxEntries) return { state: 'TOO_MANY' as const, row };
      if (entries.length !== expectedEntries.length || entries.some((entry, i) => entry.userId !== expectedEntries[i]))
        return { state: 'RETRY' as const, row };
      const prior = await tx.select({ userId: giveawayWinners.userId }).from(giveawayWinners).where(eq(giveawayWinners.giveawayId, id));
      const excluded = new Set(prior.map(w => w.userId));
      const candidates: string[] = [];
      for (const entry of entries) if (!excluded.has(entry.userId) && await eligible(entry.userId, tx)) candidates.push(entry.userId);
      const selected = pick(candidates, Math.min(row.winnerCount, candidates.length));
      const [draw] = await tx.insert(giveawayDraws).values({ giveawayId: id, kind }).returning();
      for (let i = 0; i < selected.length; i++) await tx.insert(giveawayWinners).values({ drawId: draw!.id, giveawayId: id, userId: selected[i]!, ordinal: i + 1 });
      if (kind === 'ORIGINAL') await tx.update(giveaways).set({ status: 'ENDED', updatedAt: now }).where(eq(giveaways.id, id));
      return { state: 'DRAWN' as const, row: { ...row, status: kind === 'ORIGINAL' ? 'ENDED' : row.status }, winners: selected, drawId: draw!.id };
    });
  }
  async cancel(guildId: string, id: number) { return this.db.transaction(async tx => {
    const [row] = await tx.select().from(giveaways).where(and(eq(giveaways.guildId, guildId), eq(giveaways.id, id))).for('update');
    if (!row || row.status !== 'ACTIVE') return null;
    const [updated] = await tx.update(giveaways).set({ status: 'CANCELLED', updatedAt: new Date() }).where(eq(giveaways.id, id)).returning(); return updated!;
  }); }
}
