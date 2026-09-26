import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { antiraidSettings, joinHistory } from '../../core/database/schema.js';

export type AntiRaidSettings = typeof antiraidSettings.$inferSelect;
export type AntiRaidSettingsPatch = Partial<Omit<typeof antiraidSettings.$inferInsert, 'guildId'>>;
export type JoinHistoryRecord = typeof joinHistory.$inferSelect;
export interface JoinHistoryInput {
  guildId: string; userId: string; joinedAt: Date; accountCreatedAt: Date | null;
  accountAgeSeconds: number | null; verificationStatus: string | null; riskScore: number; signals: string[];
}
export interface EmergencyState {
  enabled: boolean; actorId: string; reason: string;
  joinCount?: number | null; windowSeconds?: number | null;
}

export class AntiRaidRepository {
  constructor(private readonly db: Database) {}
  async getSettings(guildId: string) {
    const [settings] = await this.db.select().from(antiraidSettings).where(eq(antiraidSettings.guildId, guildId));
    return settings;
  }
  async ensureSettings(guildId: string) {
    await this.db.insert(antiraidSettings).values({ guildId }).onConflictDoNothing();
    return (await this.getSettings(guildId))!;
  }
  async updateSettings(guildId: string, patch: AntiRaidSettingsPatch, actorId: string) {
    await this.db.insert(antiraidSettings).values({ guildId, ...patch, updatedBy: actorId })
      .onConflictDoUpdate({
        target: antiraidSettings.guildId,
        set: { ...patch, updatedBy: actorId, updatedAt: new Date() },
      });
    return (await this.getSettings(guildId))!;
  }
  async findJoin(guildId: string, userId: string, joinedAt: Date) {
    const [record] = await this.db.select().from(joinHistory)
      .where(and(eq(joinHistory.guildId, guildId), eq(joinHistory.userId, userId),
        eq(joinHistory.joinedAt, joinedAt)));
    return record;
  }
  /** Duplicate gateway deliveries collapse onto the same (guild, user, joined_at) row. */
  async recordJoin(values: JoinHistoryInput) {
    const [inserted] = await this.db.insert(joinHistory).values(values).onConflictDoNothing().returning();
    return inserted ?? this.findJoin(values.guildId, values.userId, values.joinedAt);
  }
  async countJoinsSince(guildId: string, since: Date, until = new Date()) {
    const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(joinHistory)
      .where(and(eq(joinHistory.guildId, guildId), gte(joinHistory.joinedAt, since), lte(joinHistory.joinedAt, until)));
    return row?.count ?? 0;
  }
  /** Serialize joins for one guild across workers before counting, inserting and activating emergency. */
  async evaluateJoin(values: JoinHistoryInput, retentionDays = 30) {
    await this.ensureSettings(values.guildId);
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${values.guildId}, 0))`);
      const [settings] = await tx.select().from(antiraidSettings).where(eq(antiraidSettings.guildId, values.guildId));
      if (!settings) throw new Error('Anti-raid settings unavailable');
      await tx.delete(joinHistory).where(and(eq(joinHistory.guildId, values.guildId),
        lt(joinHistory.joinedAt, new Date(Date.now() - retentionDays * 86400_000))));
      const [existing] = await tx.select().from(joinHistory).where(and(
        eq(joinHistory.guildId, values.guildId), eq(joinHistory.userId, values.userId), eq(joinHistory.joinedAt, values.joinedAt)));
      const [countRow] = await tx.select({ count: sql<number>`count(*)::int` }).from(joinHistory).where(and(
        eq(joinHistory.guildId, values.guildId), gte(joinHistory.joinedAt, new Date(values.joinedAt.getTime() - settings.joinWindowSeconds * 1000)),
        lte(joinHistory.joinedAt, values.joinedAt)));
      const joinCount = (countRow?.count ?? 0) + (existing ? 0 : 1);
      if (existing) return { settings, record: existing, duplicate: true, joinCount, emergencyActivated: false };
      const young = values.accountAgeSeconds !== null && values.accountAgeSeconds < settings.youngAccountAgeSeconds;
      const burst = settings.enabled && joinCount >= settings.joinThreshold;
      const signals = [burst ? 'join_burst' : '', young && settings.enabled ? 'young_account' : '',
        settings.emergencyMode && settings.enabled ? 'emergency_mode' : ''].filter(Boolean);
      const score = settings.enabled ? (burst ? 60 : 0) + (young ? settings.youngAccountWeight : 0)
        + (settings.emergencyMode ? 20 : 0) : 0;
      const [record] = await tx.insert(joinHistory).values({ ...values, riskScore: score, signals }).onConflictDoNothing().returning();
      if (!record) return { settings, record: undefined, duplicate: true, joinCount, emergencyActivated: false };
      let emergencyActivated = false;
      // Activate only on threshold crossing; a later staff disable must not be
      // silently reversed by every subsequent join in the same burst window.
      if (burst && joinCount === settings.joinThreshold && !settings.emergencyMode) {
        const [updated] = await tx.update(antiraidSettings).set({ emergencyMode: true, emergencyActivatedAt: new Date(),
          emergencyReason: 'join_burst', emergencyActorId: 'SYSTEM', emergencyJoinCount: joinCount,
          emergencyWindowSeconds: settings.joinWindowSeconds, updatedAt: new Date() })
          .where(and(eq(antiraidSettings.guildId, values.guildId), eq(antiraidSettings.emergencyMode, false))).returning();
        emergencyActivated = !!updated;
      }
      return { settings, record, duplicate: false, joinCount, emergencyActivated };
    });
  }
  async setEmergency(guildId: string, state: EmergencyState) {
    await this.ensureSettings(guildId);
    return this.db.transaction(async tx => {
      // Share the guild lock with evaluateJoin so staff changes and automatic
      // threshold crossings have an unambiguous commit order across processes.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
      const patch = state.enabled
        ? {
          emergencyMode: true, emergencyActivatedAt: new Date(), emergencyReason: state.reason,
          emergencyActorId: state.actorId, emergencyJoinCount: state.joinCount ?? null,
          emergencyWindowSeconds: state.windowSeconds ?? null, updatedAt: new Date(),
        }
        : { emergencyMode: false, emergencyReason: state.reason, emergencyActorId: state.actorId, updatedAt: new Date() };
      const [settings] = await tx.update(antiraidSettings).set(patch)
        .where(eq(antiraidSettings.guildId, guildId)).returning();
      return settings!;
    });
  }
  /** Global maintenance also removes dormant guild history after 30 days. */
  async pruneExpired(now = new Date()) {
    await this.db.delete(joinHistory).where(lt(joinHistory.joinedAt, new Date(now.getTime() - 30 * 86400_000)));
  }
  recentJoins(guildId: string, limit = 20) {
    return this.db.select().from(joinHistory).where(eq(joinHistory.guildId, guildId))
      .orderBy(desc(joinHistory.joinedAt)).limit(Math.min(100, Math.max(1, limit)));
  }
}
