import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { appeals, moderationCases, reports } from '../../core/database/schema.js';
import { AppError } from '../../core/errors/errors.js';

export type Report = typeof reports.$inferSelect;
export type Appeal = typeof appeals.$inferSelect;

export class ReportRepository {
  constructor(private readonly db: Database) {}

  async submitReport(input: { guildId: string; reporterId: string; reportedUserId: string | null; category: string; description: string; evidenceUrl: string | null }, now = new Date()) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`report:${input.guildId}:${input.reporterId}`}, 0))`);
      const recent = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.guildId, input.guildId), eq(reports.reporterId, input.reporterId), gte(reports.createdAt, new Date(now.getTime() - 60 * 60_000)))).limit(1);
      if (recent.length) throw new AppError('CONFLICT', 'Please wait before submitting another report.');
      const [record] = await tx.insert(reports).values({ ...input, createdAt: now }).returning();
      return record!;
    });
  }

  async submitAppeal(input: { guildId: string; appellantId: string; caseId: number | null; reason: string }, now = new Date()) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`appeal:${input.guildId}:${input.appellantId}`}, 0))`);
      if (input.caseId !== null) {
        const [linked] = await tx.select({ id: moderationCases.id }).from(moderationCases).where(and(eq(moderationCases.id, input.caseId), eq(moderationCases.guildId, input.guildId), eq(moderationCases.targetId, input.appellantId)));
        if (!linked) throw new AppError('VALIDATION', 'That case cannot be appealed by this user in this server.');
      }
      const pending = await tx.select({ id: appeals.id }).from(appeals).where(and(eq(appeals.guildId, input.guildId), eq(appeals.appellantId, input.appellantId), eq(appeals.status, 'PENDING'))).limit(1);
      if (pending.length) throw new AppError('CONFLICT', 'You already have a pending appeal.');
      const recent = await tx.select({ id: appeals.id }).from(appeals).where(and(eq(appeals.guildId, input.guildId), eq(appeals.appellantId, input.appellantId), gte(appeals.createdAt, new Date(now.getTime() - 24 * 60 * 60_000)))).limit(1);
      if (recent.length) throw new AppError('CONFLICT', 'Please wait before submitting another appeal.');
      const [record] = await tx.insert(appeals).values({ ...input, createdAt: now }).returning();
      return record!;
    });
  }

  listReports(guildId: string, limit = 10) {
    return this.db.select().from(reports).where(eq(reports.guildId, guildId)).orderBy(desc(reports.createdAt), desc(reports.id)).limit(limit);
  }
  listAppeals(guildId: string, limit = 10) {
    return this.db.select().from(appeals).where(eq(appeals.guildId, guildId)).orderBy(desc(appeals.createdAt), desc(appeals.id)).limit(limit);
  }
  async getReport(guildId: string, id: number) {
    const [record] = await this.db.select().from(reports).where(and(eq(reports.guildId, guildId), eq(reports.id, id)));
    return record;
  }
  async getAppeal(guildId: string, id: number) {
    const [record] = await this.db.select().from(appeals).where(and(eq(appeals.guildId, guildId), eq(appeals.id, id)));
    return record;
  }
  async closeReport(guildId: string, id: number, closedBy: string, resolutionNote: string, now = new Date()) {
    const [record] = await this.db.update(reports).set({ status: 'CLOSED', closedAt: now, closedBy, resolutionNote }).where(and(eq(reports.guildId, guildId), eq(reports.id, id), sql`${reports.status} <> 'CLOSED'`)).returning();
    return record;
  }
  async reviewAppeal(guildId: string, id: number, reviewerId: string, status: 'ACCEPTED' | 'REJECTED', reviewNote: string, now = new Date()) {
    const [record] = await this.db.update(appeals).set({ status, reviewerId, reviewNote, reviewedAt: now }).where(and(eq(appeals.guildId, guildId), eq(appeals.id, id), eq(appeals.status, 'PENDING'))).returning();
    return record;
  }
}
