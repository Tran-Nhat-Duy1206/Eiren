import { and, asc, count, eq, lte, or, lt, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { communityEvents, eventParticipants, eventAttendance, eventReminders, guildModules } from '../../core/database/schema.js';
import { AppError } from '../../core/errors/errors.js';

export type CommunityEvent = typeof communityEvents.$inferSelect;
export type EventInput = Pick<typeof communityEvents.$inferInsert, 'guildId' | 'creatorId' | 'title' | 'description' | 'startAt' | 'endAt' | 'channelId' | 'maxParticipants'>;
export const reminderOffsets = [86400, 3600, 600] as const;
export class EventRepository {
  constructor(private readonly db: Database) {}
  async create(input: EventInput) {
    return this.db.transaction(async tx => {
      const [row] = await tx.insert(communityEvents).values(input).returning();
      await tx.insert(eventReminders).values(reminderOffsets.map(offsetSeconds => ({ eventId: row!.id, offsetSeconds,
        status: row!.startAt.getTime() - offsetSeconds * 1000 > Date.now() ? 'PENDING' : 'CANCELLED' })));
      return row!;
    });
  }
  async get(guildId: string, id: number) {
    const [row] = await this.db.select().from(communityEvents).where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, id)));
    return row;
  }
  list(guildId: string, limit = 20) { return this.db.select().from(communityEvents).where(eq(communityEvents.guildId, guildId)).orderBy(asc(communityEvents.startAt)).limit(Math.min(25, Math.max(1, limit))); }
  async count(id: number) { const [row] = await this.db.select({ value: count() }).from(eventParticipants).where(eq(eventParticipants.eventId, id)); return row?.value ?? 0; }
  async edit(guildId: string, id: number, changes: Partial<Pick<EventInput, 'title' | 'description' | 'startAt' | 'endAt' | 'maxParticipants'>>) {
    return this.db.transaction(async tx => {
      const [current] = await tx.select().from(communityEvents).where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, id))).for('update');
      if (!current || current.status !== 'SCHEDULED') throw new AppError('CONFLICT', 'Only planned events can be edited.');
      const [{ value = 0 } = { value: 0 }] = await tx.select({ value: count() }).from(eventParticipants).where(eq(eventParticipants.eventId, id));
      if (changes.maxParticipants != null && changes.maxParticipants < value) throw new AppError('CONFLICT', 'Capacity cannot be below current RSVPs.');
      const [row] = await tx.update(communityEvents).set({ ...changes, presentationPending: true, presentationRetryAt: null, updatedAt: new Date() }).where(eq(communityEvents.id, id)).returning();
      if (changes.startAt && changes.startAt.getTime() !== current.startAt.getTime())
        for (const offsetSeconds of reminderOffsets) await tx.update(eventReminders).set({
          status: row!.startAt.getTime() - offsetSeconds * 1000 > Date.now() ? 'PENDING' : 'CANCELLED',
          claimedAt: null, deliveredAt: null, messageId: null,
        }).where(and(eq(eventReminders.eventId, id), eq(eventReminders.offsetSeconds, offsetSeconds)));
      return row!;
    });
  }
  async transition(guildId: string, id: number, expected: 'SCHEDULED' | 'ACTIVE', next: 'ACTIVE' | 'COMPLETED' | 'CANCELLED') {
    return this.db.transaction(async tx => {
      const [row] = await tx.update(communityEvents).set({ status: next, presentationPending: true, presentationRetryAt: null, updatedAt: new Date() }).where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, id), eq(communityEvents.status, expected))).returning();
      if (row) await tx.update(eventReminders).set({ status: 'CANCELLED' }).where(and(eq(eventReminders.eventId, id), or(eq(eventReminders.status, 'PENDING'), eq(eventReminders.status, 'PROCESSING'))));
      return row;
    });
  }
  async join(guildId: string, id: number, userId: string, now = new Date()) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(communityEvents).where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, id))).for('update');
      if (!row) throw new AppError('NOT_FOUND', 'Event not found.');
      if (row.status !== 'SCHEDULED' || row.startAt <= now) throw new AppError('CONFLICT', 'RSVPs are closed.');
      const [existing] = await tx.select().from(eventParticipants).where(and(eq(eventParticipants.eventId, id), eq(eventParticipants.userId, userId)));
      if (existing) return false;
      const [{ value = 0 } = { value: 0 }] = await tx.select({ value: count() }).from(eventParticipants).where(eq(eventParticipants.eventId, id));
      if (row.maxParticipants != null && value >= row.maxParticipants) throw new AppError('CONFLICT', 'Event is full.');
      await tx.insert(eventParticipants).values({ eventId: id, userId });
      await tx.update(communityEvents).set({ presentationPending: true, presentationRetryAt: null }).where(eq(communityEvents.id, id));
      return true;
    });
  }
  async leave(guildId: string, id: number, userId: string) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(communityEvents).where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, id))).for('update');
      if (!row) throw new AppError('NOT_FOUND', 'Event not found.');
      if (row.status !== 'SCHEDULED') throw new AppError('CONFLICT', 'RSVPs are closed.');
      const removed = await tx.delete(eventParticipants).where(and(eq(eventParticipants.eventId, id), eq(eventParticipants.userId, userId))).returning();
      if (removed.length) await tx.update(communityEvents).set({ presentationPending: true, presentationRetryAt: null }).where(eq(communityEvents.id, id));
      return removed.length > 0;
    });
  }
  async attend(guildId: string, id: number, userId: string, markedBy: string) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(communityEvents).where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, id))).for('update');
      if (!row || row.status !== 'ACTIVE') throw new AppError('CONFLICT', 'Event must be started to mark attendance.');
      const [participant] = await tx.select().from(eventParticipants).where(and(eq(eventParticipants.eventId, id), eq(eventParticipants.userId, userId)));
      if (!participant) throw new AppError('VALIDATION', 'User has not joined this event.');
      const result = await tx.insert(eventAttendance).values({ eventId: id, userId, markedBy }).onConflictDoNothing().returning();
      return result.length > 0;
    });
  }
  async syncAnnouncement(guildId: string, id: number,
    publish: (row: CommunityEvent, participants: number) => Promise<{ messageId?: string; remove?: () => Promise<void> }>) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(communityEvents)
        .where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, id))).for('update');
      if (!row) return false;
      const [{ value = 0 } = { value: 0 }] = await tx.select({ value: count() }).from(eventParticipants).where(eq(eventParticipants.eventId, id));
      const result = await publish(row, value);
      const [attached] = await tx.update(communityEvents).set({
        ...(result.messageId ? { announcementMessageId: result.messageId } : {}),
        presentationPending: false, presentationRetryAt: null,
      }).where(eq(communityEvents.id, id)).returning();
      if (!attached) { await result.remove?.(); return false; }
      return true;
    });
  }
  async attach(guildId: string, id: number, messageId: string, oldMessageId: string | null) {
    const [row] = await this.db.update(communityEvents).set({ announcementMessageId: messageId, updatedAt: new Date() }).where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, id), oldMessageId === null ? isNull(communityEvents.announcementMessageId) : eq(communityEvents.announcementMessageId, oldMessageId))).returning();
    return row;
  }
  async claimPendingPresentations(now = new Date(), limit = 20) {
    return this.db.transaction(async tx => {
      const rows = await tx.select({ event: communityEvents }).from(communityEvents)
        .innerJoin(guildModules, and(eq(guildModules.guildId, communityEvents.guildId), eq(guildModules.moduleKey, 'events'), eq(guildModules.enabled, true)))
        .where(and(eq(communityEvents.presentationPending, true),
          or(isNull(communityEvents.presentationRetryAt), lte(communityEvents.presentationRetryAt, now))))
        .orderBy(asc(communityEvents.presentationRetryAt), asc(communityEvents.id))
        .limit(Math.max(1, Math.min(limit, 20))).for('update', { skipLocked: true });
      if (rows.length) await tx.update(communityEvents)
        .set({ presentationRetryAt: new Date(now.getTime() + 60_000) })
        .where(sql`${communityEvents.id} in (${sql.join(rows.map(r => sql`${r.event.id}`), sql`, `)})`);
      return rows.map(r => r.event);
    });
  }
  async deferPresentation(guildId: string, id: number, now = new Date()) {
    await this.db.update(communityEvents).set({ presentationPending: true, presentationRetryAt: new Date(now.getTime() + 60_000) })
      .where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, id), eq(communityEvents.presentationPending, true),
        or(isNull(communityEvents.presentationRetryAt), lte(communityEvents.presentationRetryAt, now))));
  }
  async transitionDue(now = new Date(), limit = 20, enabled: (guildId: string) => Promise<boolean> = async () => true) {
    const candidates = await this.db.select({ event: communityEvents }).from(communityEvents)
      .innerJoin(guildModules, and(eq(guildModules.guildId, communityEvents.guildId), eq(guildModules.moduleKey, 'events'), eq(guildModules.enabled, true)))
      .where(or(and(eq(communityEvents.status, 'SCHEDULED'), lte(communityEvents.startAt, now)),
        and(eq(communityEvents.status, 'ACTIVE'), lte(communityEvents.endAt, now))))
      .orderBy(asc(communityEvents.startAt)).limit(limit);
    const changed: CommunityEvent[] = [];
    for (const { event: candidate } of candidates) {
      if (!await enabled(candidate.guildId)) continue;
      const next = candidate.status === 'SCHEDULED' ? 'ACTIVE' : 'COMPLETED';
      const row = await this.transition(candidate.guildId, candidate.id, candidate.status as 'SCHEDULED' | 'ACTIVE', next);
      if (row) changed.push(row);
    }
    return changed;
  }
  async cancelExpiredReminders(now = new Date(), limit = 100) {
    const candidates = await this.db.select({ eventId: eventReminders.eventId, offsetSeconds: eventReminders.offsetSeconds })
      .from(eventReminders).innerJoin(communityEvents, eq(eventReminders.eventId, communityEvents.id))
      .where(and(or(eq(eventReminders.status, 'PENDING'), eq(eventReminders.status, 'PROCESSING')),
        or(eq(communityEvents.status, 'CANCELLED'), eq(communityEvents.status, 'COMPLETED'), lte(communityEvents.startAt, now))))
      .limit(limit);
    for (const item of candidates) await this.db.update(eventReminders).set({ status: 'CANCELLED' })
      .where(and(eq(eventReminders.eventId, item.eventId), eq(eventReminders.offsetSeconds, item.offsetSeconds),
        or(eq(eventReminders.status, 'PENDING'), eq(eventReminders.status, 'PROCESSING'))));
    return candidates.length;
  }
  async claimDue(now = new Date(), limit = 20) {
    return this.db.transaction(async tx => {
      const stale = new Date(now.getTime() - 5 * 60_000);
      const candidates = await tx.select({ reminder: eventReminders, event: communityEvents }).from(eventReminders).innerJoin(communityEvents, eq(eventReminders.eventId, communityEvents.id))
        .innerJoin(guildModules, and(eq(guildModules.guildId, communityEvents.guildId), eq(guildModules.moduleKey, 'events'), eq(guildModules.enabled, true)))
        .where(and(eq(communityEvents.status, 'SCHEDULED'), gt(communityEvents.startAt, now),
          lte(sql`(${communityEvents.startAt} - (${eventReminders.offsetSeconds} * interval '1 second'))`, now),
          or(eq(eventReminders.status, 'PENDING'), and(eq(eventReminders.status, 'PROCESSING'), lt(eventReminders.claimedAt, stale)))))
        .orderBy(asc(communityEvents.startAt)).limit(limit).for('update', { skipLocked: true });
      const due = candidates;
      for (const item of due) await tx.update(eventReminders).set({ status: 'PROCESSING', claimedAt: now }).where(and(eq(eventReminders.eventId, item.event.id), eq(eventReminders.offsetSeconds, item.reminder.offsetSeconds)));
      return due.map(item => ({ ...item, reminder: { ...item.reminder, status: 'PROCESSING', claimedAt: now } }));
    });
  }
  // Legacy completion helper retained for DB smoke checks; runtime uses deliverReminder instead.
  async finishReminder(eventId: number, offsetSeconds: number, messageId: string) {
    const [row] = await this.db.update(eventReminders).set({ status: 'DELIVERED', deliveredAt: new Date(), messageId })
      .where(and(eq(eventReminders.eventId, eventId), eq(eventReminders.offsetSeconds, offsetSeconds), eq(eventReminders.status, 'PROCESSING'))).returning();
    return row;
  }
  async deliverReminder(guildId: string, eventId: number, offsetSeconds: number, claimedAt: Date,
    now: Date, send: (event: CommunityEvent) => Promise<string>, enabled: (guildId: string) => Promise<boolean>,
    expectedStartAt?: Date) {
    // Event-first lock order matches edit/join/cancel; keep the lock through Discord delivery
    // so a committed cancellation or reschedule cannot be followed by an old reminder.
    return this.db.transaction(async tx => {
      const [event] = await tx.select().from(communityEvents)
        .where(and(eq(communityEvents.guildId, guildId), eq(communityEvents.id, eventId))).for('update');
      if (!event) return false;
      const [reminder] = await tx.select().from(eventReminders)
        .where(and(eq(eventReminders.eventId, eventId), eq(eventReminders.offsetSeconds, offsetSeconds))).for('update');
      if (!reminder || reminder.status !== 'PROCESSING' || reminder.claimedAt?.getTime() !== claimedAt.getTime()
        || event.status !== 'SCHEDULED' || (expectedStartAt && event.startAt.getTime() !== expectedStartAt.getTime()) || event.startAt <= now || event.startAt <= new Date() || !await enabled(guildId)) return false;
      const messageId = await send(event);
      await tx.update(eventReminders).set({ status: 'DELIVERED', deliveredAt: new Date(), messageId })
        .where(and(eq(eventReminders.eventId, eventId), eq(eventReminders.offsetSeconds, offsetSeconds)));
      return true;
    });
  }
}
