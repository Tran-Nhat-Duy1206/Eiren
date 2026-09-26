import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { guildSettings, ticketParticipants, ticketSettings, tickets } from '../../core/database/schema.js';
import { AppError } from '../../core/errors/errors.js';

export type Ticket = typeof tickets.$inferSelect;
export type TicketSettings = typeof ticketSettings.$inferSelect;
export type TicketType = 'SUPPORT' | 'REPORT' | 'APPEAL' | 'PARTNERSHIP' | 'BUG_REPORT' | 'OTHER';
export class TicketRepository {
  constructor(private readonly db: Database) {}
  async settings(guildId: string) {
    const [setting] = await this.db.select().from(ticketSettings).where(eq(ticketSettings.guildId, guildId));
    const [guild] = await this.db.select({ ticketCategoryId: guildSettings.ticketCategoryId }).from(guildSettings).where(eq(guildSettings.guildId, guildId));
    return { setting, categoryId: guild?.ticketCategoryId ?? null };
  }
  async configure(guildId: string, patch: Partial<Pick<TicketSettings, 'staffRoleId' | 'transcriptChannelId' | 'maxActiveTickets'>>) {
    await this.db.insert(ticketSettings).values({ guildId, ...patch }).onConflictDoUpdate({ target: ticketSettings.guildId, set: patch });
    return (await this.settings(guildId)).setting!;
  }
  /** Transaction-scoped PostgreSQL advisory lock spans the capacity check and placeholder insertion. */
  async reserve(guildId: string, creatorId: string, type: TicketType, limit: number) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
      const existing = await tx.select().from(tickets).where(and(eq(tickets.guildId, guildId), eq(tickets.creatorId, creatorId), inArray(tickets.status, ['OPEN', 'CLAIMED'])));
      if (existing.length >= limit) throw new AppError('CONFLICT', `You already have the maximum ${limit} active tickets.`);
      const [ticket] = await tx.insert(tickets).values({ guildId, creatorId, type, status: 'OPEN', channelId: null }).returning();
      return ticket!;
    });
  }
  async attach(guildId: string, id: number, channelId: string) {
    const [row] = await this.db.update(tickets).set({ channelId }).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id), isNull(tickets.channelId), eq(tickets.status, 'OPEN'))).returning();
    return row;
  }
  async abandon(guildId: string, id: number) {
    await this.db.delete(tickets).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id), isNull(tickets.channelId)));
  }
  async get(guildId: string, id: number) {
    const [row] = await this.db.select().from(tickets).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id)));
    return row;
  }
  /** Claim and Discord access are serialized with archive and participant operations. */
  async claim(guildId: string, id: number, actorId: string,
    grant: (row: Ticket, alreadyParticipant: boolean) => Promise<() => Promise<void>>) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(tickets).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id))).for('update');
      if (!row || row.status !== 'OPEN' || !row.channelId) throw new AppError('CONFLICT', 'Ticket is already claimed, closed or not ready.');
      const [participant] = await tx.select().from(ticketParticipants)
        .where(and(eq(ticketParticipants.ticketId, id), eq(ticketParticipants.userId, actorId)));
      const undo = await grant(row, !!participant);
      try {
        const [claimed] = await tx.update(tickets).set({ status: 'CLAIMED', assignedStaffId: actorId, claimedAt: new Date() })
          .where(eq(tickets.id, id)).returning();
        return claimed!;
      } catch (error) { await undo(); throw error; }
    });
  }
  /** Transfer overwrites and assignment are serialized with archive and participant operations. */
  async transfer(guildId: string, id: number, userId: string,
    reconcile: (row: Ticket, oldAssigneeIsParticipant: boolean, newAssigneeIsParticipant: boolean) => Promise<() => Promise<void>>) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(tickets).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id))).for('update');
      if (!row || row.status === 'CLOSED' || !row.channelId) throw new AppError('CONFLICT', 'Ticket is closed or not ready.');
      const [oldParticipant] = row.assignedStaffId ? await tx.select().from(ticketParticipants)
        .where(and(eq(ticketParticipants.ticketId, id), eq(ticketParticipants.userId, row.assignedStaffId))) : [];
      const [newParticipant] = await tx.select().from(ticketParticipants)
        .where(and(eq(ticketParticipants.ticketId, id), eq(ticketParticipants.userId, userId)));
      const undo = await reconcile(row, !!oldParticipant, !!newParticipant);
      try {
        const [updated] = await tx.update(tickets).set({ assignedStaffId: userId, status: 'CLAIMED', claimedAt: new Date() }).where(eq(tickets.id, id)).returning();
        return updated!;
      } catch (error) { await undo(); throw error; }
    });
  }
  async saveTranscript(guildId: string, id: number, transcript: string) {
    const [row] = await this.db.update(tickets).set({ transcript, transcriptGeneratedAt: new Date() }).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id), isNull(tickets.transcriptGeneratedAt), inArray(tickets.status, ['OPEN', 'CLAIMED']))).returning();
    return row;
  }
  async close(guildId: string, id: number, by: string, reason: string) {
    const [row] = await this.db.update(tickets).set({ status: 'CLOSED', closedAt: new Date(), closedBy: by, closeReason: reason }).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id), inArray(tickets.status, ['OPEN', 'CLAIMED']), sql`${tickets.transcriptGeneratedAt} IS NOT NULL`)).returning();
    return row;
  }
  /** Row lock serializes concurrent close requests across bot processes while fetching the transcript. */
  async archive(guildId: string, id: number, by: string, reason: string, fetchTranscript: (channelId: string) => Promise<string>) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(tickets).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id))).for('update');
      if (!row) throw new AppError('NOT_FOUND', 'Ticket not found.');
      if (row.status === 'CLOSED') return { row, changed: false };
      if (!row.channelId) throw new AppError('CONFLICT', 'Ticket channel is still being created.');
      if (!row.transcriptGeneratedAt) {
        const transcript = await fetchTranscript(row.channelId);
        await tx.update(tickets).set({ transcript, transcriptGeneratedAt: new Date() }).where(eq(tickets.id, id));
      }
      const [closed] = await tx.update(tickets).set({ status: 'CLOSED', closedAt: new Date(), closedBy: by, closeReason: reason }).where(eq(tickets.id, id)).returning();
      return { row: closed!, changed: true };
    });
  }
  /** Row lock coordinates participant Discord overwrites with transcript/close across processes. */
  async changeParticipant(guildId: string, id: number, userId: string, addedBy: string, add: boolean,
    apply: () => Promise<void>, undo: () => Promise<void>) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(tickets).where(and(eq(tickets.guildId, guildId), eq(tickets.id, id))).for('update');
      if (!row || row.status === 'CLOSED' || !row.channelId) throw new AppError('CONFLICT', 'Ticket is not active.');
      if (userId === row.creatorId || userId === row.assignedStaffId) throw new AppError('CONFLICT', 'Cannot change creator or current assignee access.');
      await apply();
      try {
        if (add) await tx.insert(ticketParticipants).values({ ticketId: id, userId, addedBy }).onConflictDoNothing();
        else await tx.delete(ticketParticipants).where(and(eq(ticketParticipants.ticketId, id), eq(ticketParticipants.userId, userId)));
      } catch (error) { await undo(); throw error; }
      return row;
    });
  }
  async participants(id: number) { return this.db.select().from(ticketParticipants).where(eq(ticketParticipants.ticketId, id)); }
  async addParticipant(id: number, userId: string, addedBy: string) {
    await this.db.insert(ticketParticipants).values({ ticketId: id, userId, addedBy }).onConflictDoNothing();
  }
  async removeParticipant(id: number, userId: string) {
    await this.db.delete(ticketParticipants).where(and(eq(ticketParticipants.ticketId, id), eq(ticketParticipants.userId, userId)));
  }
  async list(guildId: string, creatorId?: string) {
    return this.db.select().from(tickets).where(creatorId ? and(eq(tickets.guildId, guildId), eq(tickets.creatorId, creatorId)) : eq(tickets.guildId, guildId)).orderBy(asc(tickets.createdAt)).limit(50);
  }
}
