import { and, desc, eq, inArray, isNotNull, lt, lte, notInArray, or } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { moderationCases, moderatorNotes } from '../../core/database/schema.js';

export type ModerationAction = 'WARN' | 'TIMEOUT' | 'KICK' | 'BAN' | 'TEMPBAN' | 'UNBAN' | 'PURGE';
export type CaseStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'PROCESSING' | 'EXPIRED' | 'SUPERSEDED' | 'FAILED';
export type ModerationCase = typeof moderationCases.$inferSelect;
export type NewCase = Omit<typeof moderationCases.$inferInsert, 'id' | 'createdAt' | 'status' | 'claimedAt'> & { action: ModerationAction };

export class ModerationRepository {
  constructor(private readonly db: Database) {}
  async createCase(values: NewCase): Promise<ModerationCase> {
    const [record] = await this.db.insert(moderationCases).values(values).returning();
    return record!;
  }
  async getCase(guildId: string, id: number) {
    const [record] = await this.db.select().from(moderationCases)
      .where(and(eq(moderationCases.guildId, guildId), eq(moderationCases.id, id)));
    return record;
  }
  history(guildId: string, targetId: string, limit = 10) {
    return this.db.select().from(moderationCases)
      .where(and(eq(moderationCases.guildId, guildId), eq(moderationCases.targetId, targetId)))
      .orderBy(desc(moderationCases.createdAt), desc(moderationCases.id)).limit(Math.min(25, Math.max(1, limit)));
  }
  async complete(id: number, status: 'ACTIVE' | 'COMPLETED', metadata: Record<string, string | number | boolean | null>) {
    const [record] = await this.db.update(moderationCases).set({ status, metadata })
      .where(and(eq(moderationCases.id, id), eq(moderationCases.status, 'PENDING'))).returning();
    return record;
  }
  async setStatus(id: number, expected: CaseStatus, status: CaseStatus) {
    const [record] = await this.db.update(moderationCases)
      .set({ status, claimedAt: null })
      .where(and(eq(moderationCases.id, id), eq(moderationCases.status, expected))).returning();
    return record;
  }
  async addNote(guildId: string, targetId: string, moderatorId: string, content: string) {
    const [record] = await this.db.insert(moderatorNotes).values({ guildId, targetId, moderatorId, content }).returning();
    return record!;
  }
  notes(guildId: string, targetId: string, limit = 10) {
    return this.db.select().from(moderatorNotes)
      .where(and(eq(moderatorNotes.guildId, guildId), eq(moderatorNotes.targetId, targetId)))
      .orderBy(desc(moderatorNotes.createdAt), desc(moderatorNotes.id)).limit(Math.min(25, Math.max(1, limit)));
  }
  async claimDue(now = new Date(), limit = 20, applyingIds: readonly number[] = []): Promise<ModerationCase[]> {
    const stale = new Date(now.getTime() - 5 * 60_000);
    return this.db.transaction(async tx => {
      const candidates = await tx.select().from(moderationCases).where(and(
        isNotNull(moderationCases.expiresAt), lte(moderationCases.expiresAt, now),
        inArray(moderationCases.action, ['TEMPBAN', 'TIMEOUT']),
        // This single-process bot excludes its in-flight API calls; PENDING from a prior
        // process or a failed DB completion remains eligible on restart/after recovery.
        applyingIds.length ? notInArray(moderationCases.id, [...applyingIds]) : undefined,
        or(eq(moderationCases.status, 'ACTIVE'), eq(moderationCases.status, 'PENDING'),
          and(eq(moderationCases.status, 'PROCESSING'), lt(moderationCases.claimedAt, stale))),
      )).orderBy(moderationCases.expiresAt).limit(limit).for('update', { skipLocked: true });
      if (!candidates.length) return [];
      await tx.update(moderationCases).set({ status: 'PROCESSING', claimedAt: now })
        .where(inArray(moderationCases.id, candidates.map(item => item.id)));
      return candidates.map(item => ({ ...item, status: 'PROCESSING', claimedAt: now }));
    });
  }
}
