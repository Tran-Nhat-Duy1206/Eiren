import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { memberVerifications, verificationSettings } from '../../core/database/schema.js';

export type VerificationMode = 'BUTTON' | 'MANUAL' | 'BUTTON_AND_ACCOUNT_AGE';
export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'BYPASSED';
export type VerificationMethod = 'BUTTON' | 'MANUAL' | 'AUTO';
export type VerificationSettings = typeof verificationSettings.$inferSelect;
export type MemberVerification = typeof memberVerifications.$inferSelect;
export type VerificationSettingsPatch = Partial<Omit<typeof verificationSettings.$inferInsert, 'guildId'>>;
export type MemberTransitionFields = Partial<Omit<typeof memberVerifications.$inferInsert, 'guildId' | 'userId' | 'status'>>;

export class VerificationRepository {
  constructor(private readonly db: Database) {}
  async getSettings(guildId: string) {
    const [settings] = await this.db.select().from(verificationSettings).where(eq(verificationSettings.guildId, guildId));
    return settings;
  }
  async ensureSettings(guildId: string) {
    await this.db.insert(verificationSettings).values({ guildId }).onConflictDoNothing();
    return (await this.getSettings(guildId))!;
  }
  async updateSettings(guildId: string, patch: VerificationSettingsPatch, actorId: string) {
    await this.db.insert(verificationSettings).values({ guildId, ...patch, updatedBy: actorId })
      .onConflictDoUpdate({
        target: verificationSettings.guildId,
        set: { ...patch, updatedBy: actorId, updatedAt: new Date() },
      });
    return (await this.getSettings(guildId))!;
  }
  async getMember(guildId: string, userId: string) {
    const [record] = await this.db.select().from(memberVerifications)
      .where(and(eq(memberVerifications.guildId, guildId), eq(memberVerifications.userId, userId)));
    return record;
  }
  async upsertPending(guildId: string, userId: string, accountCreatedAt: Date | null) {
    await this.db.insert(memberVerifications).values({ guildId, userId, accountCreatedAt })
      .onConflictDoNothing();
    return (await this.getMember(guildId, userId))!;
  }
  /** A later membership epoch starts fresh; duplicate/out-of-order join delivery preserves the row. */
  async resetForRejoin(guildId: string, userId: string, joinedAt: Date, accountCreatedAt: Date | null) {
    await this.db.insert(memberVerifications).values({ guildId, userId, accountCreatedAt, createdAt: joinedAt })
      .onConflictDoUpdate({
        target: [memberVerifications.guildId, memberVerifications.userId],
        set: { status: 'PENDING', method: null, reason: null, accountCreatedAt, createdAt: joinedAt,
          updatedAt: new Date(), verifiedAt: null, verifiedBy: null, rejectedAt: null, rejectedBy: null,
          rulesAcknowledgedAt: null, metadata: {} },
        setWhere: sql`${memberVerifications.createdAt} < ${joinedAt}`,
      });
    return (await this.getMember(guildId, userId))!;
  }
  /** Conditional transition so duplicate clicks and concurrent staff cannot corrupt state. */
  async transition(guildId: string, userId: string, from: readonly VerificationStatus[],
    to: VerificationStatus, fields: MemberTransitionFields = {}) {
    const [record] = await this.db.update(memberVerifications)
      .set({ status: to, updatedAt: new Date(), ...fields })
      .where(and(eq(memberVerifications.guildId, guildId), eq(memberVerifications.userId, userId),
        inArray(memberVerifications.status, [...from]))).returning();
    return record;
  }
  async acknowledgeRules(guildId: string, userId: string) {
    const [record] = await this.db.update(memberVerifications)
      .set({ rulesAcknowledgedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(memberVerifications.guildId, guildId), eq(memberVerifications.userId, userId),
        eq(memberVerifications.status, 'PENDING'))).returning();
    return record;
  }
  async mergeMetadata(guildId: string, userId: string, patch: Record<string, string | number | boolean | null>) {
    const [record] = await this.db.update(memberVerifications)
      .set({ metadata: sql`${memberVerifications.metadata} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
      .where(and(eq(memberVerifications.guildId, guildId), eq(memberVerifications.userId, userId))).returning();
    return record;
  }
  listPending(guildId: string, limit = 25) {
    return this.db.select().from(memberVerifications)
      .where(and(eq(memberVerifications.guildId, guildId), eq(memberVerifications.status, 'PENDING')))
      .orderBy(desc(memberVerifications.createdAt)).limit(Math.min(50, Math.max(1, limit)));
  }
}
