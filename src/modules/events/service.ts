import { AppError } from '../../core/errors/errors.js';
import type { Logger } from '../../core/logger/logger.js';
import { levels, type Actor, type PermissionService } from '../../core/permissions/permission-service.js';
import type { EventInput, EventRepository, CommunityEvent } from './repository.js';
import type { EventGateway } from './discord-gateway.js';

export function parseEventTime(input: string) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(Z|([+-])(0\d|1[0-4]):([0-5]\d))$/.exec(input);
  if (!match) throw new AppError('VALIDATION', 'Use ISO time with explicit Z or timezone offset.');
  const [, minute, seconds, zone, sign, hours, minutes] = match;
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (Number(hours) * 60 + Number(minutes));
  if (Math.abs(offset) > 14 * 60) throw new AppError('VALIDATION', 'Invalid ISO time.');
  const date = new Date(input);
  if (!Number.isFinite(date.getTime()) ||
      new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19) !== `${minute}:${seconds ?? '00'}`)
    throw new AppError('VALIDATION', 'Invalid ISO time.');
  return date;
}
export type EventHooks = { onJoined?(guildId: string, userId: string): Promise<void>; onAttended?(guildId: string, userId: string): Promise<void> };
export class EventService {
  constructor(private readonly repository: EventRepository, private readonly permissions: PermissionService,
    private readonly gateway: (guildId: string) => Promise<EventGateway>, private readonly logger: Logger,
    private readonly hooks: EventHooks = {}, private readonly isEnabled: (guildId: string) => Promise<boolean> = async () => true) {}
  private async authorize(actor: Actor, row: CommunityEvent) {
    if (row.creatorId !== actor.userId && levels.indexOf(await this.permissions.resolve(actor)) < levels.indexOf('MODERATOR'))
      throw new AppError('PERMISSION', 'Only the creator or a moderator can manage this event.');
  }
  async create(actor: Actor, input: Omit<EventInput, 'guildId' | 'creatorId'>) {
    await this.permissions.require(actor, 'HELPER');
    this.validate(input);
    await (await this.gateway(actor.guildId)).validateChannel(input.channelId);
    const row = await this.repository.create({ ...input, guildId: actor.guildId, creatorId: actor.userId });
    await this.refresh(row);
    return row;
  }
  private validate(input: { title?: string; description?: string | null; startAt?: Date; endAt?: Date | null; maxParticipants?: number | null }) {
    if (input.title !== undefined && (!input.title.trim() || input.title.length > 256)) throw new AppError('VALIDATION', 'Title must be 1–256 characters.');
    if (input.description !== undefined && input.description !== null && input.description.length > 2000) throw new AppError('VALIDATION', 'Description must be at most 2000 characters.');
    if (input.startAt && (!Number.isFinite(input.startAt.getTime()) || input.startAt <= new Date())) throw new AppError('VALIDATION', 'Start must be in the future.');
    if (input.endAt && (!Number.isFinite(input.endAt.getTime()) || (input.startAt && input.endAt <= input.startAt))) throw new AppError('VALIDATION', 'End must follow start.');
    if (input.maxParticipants != null && (!Number.isSafeInteger(input.maxParticipants) || input.maxParticipants < 1 || input.maxParticipants > 10000)) throw new AppError('VALIDATION', 'Capacity must be positive.');
  }
  async view(guildId: string, id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new AppError('VALIDATION', 'Invalid event ID.');
    const row = await this.repository.get(guildId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Event not found.');
    return { row, participants: await this.repository.count(id) };
  }
  list(guildId: string) { return this.repository.list(guildId); }
  async edit(actor: Actor, id: number, changes: Partial<Pick<EventInput, 'title' | 'description' | 'startAt' | 'endAt' | 'maxParticipants'>>) {
    const { row } = await this.view(actor.guildId, id); await this.authorize(actor, row);
    this.validate({ ...changes, startAt: changes.startAt ?? row.startAt, endAt: changes.endAt === undefined ? row.endAt : changes.endAt });
    const result = await this.repository.edit(actor.guildId, id, changes); await this.refresh(result); return result;
  }
  async transition(actor: Actor, id: number, action: 'start' | 'close' | 'cancel') {
    const { row } = await this.view(actor.guildId, id); await this.authorize(actor, row);
    const updated = await this.repository.transition(actor.guildId, id, action === 'close' ? 'ACTIVE' : 'SCHEDULED',
      action === 'start' ? 'ACTIVE' : action === 'close' ? 'COMPLETED' : 'CANCELLED');
    if (!updated) throw new AppError('CONFLICT', 'Event has already changed status.');
    await this.refresh(updated); return updated;
  }
  async join(guildId: string, id: number, userId: string, bot = false) {
    if (bot) throw new AppError('VALIDATION', 'Bots cannot join events.');
    const changed = await this.repository.join(guildId, id, userId);
    if (changed) { try { await this.hooks.onJoined?.(guildId, userId); } catch { this.logger.warn({ guildId, id }, 'Event join hook failed'); }
      await this.refresh((await this.view(guildId, id)).row); }
    return changed;
  }
  async leave(guildId: string, id: number, userId: string, bot = false) {
    if (bot) throw new AppError('VALIDATION', 'Bots cannot leave events.');
    const changed = await this.repository.leave(guildId, id, userId);
    if (changed) await this.refresh((await this.view(guildId, id)).row);
    return changed;
  }
  async attend(actor: Actor, id: number, userId: string, bot = false) {
    await this.permissions.require(actor, 'HELPER');
    if (bot) throw new AppError('VALIDATION', 'Bots cannot attend events.');
    const changed = await this.repository.attend(actor.guildId, id, userId, actor.userId);
    if (changed) try { await this.hooks.onAttended?.(actor.guildId, userId); } catch { this.logger.warn({ guildId: actor.guildId, id }, 'Event attendance hook failed'); }
    return changed;
  }
  async button(guildId: string, id: number, userId: string, bot: boolean, action: 'join' | 'leave', channelId: string, messageId: string) {
    const { row } = await this.view(guildId, id);
    if (row.channelId !== channelId || row.announcementMessageId !== messageId) throw new AppError('CONFLICT', 'This event button is stale.');
    return action === 'join' ? this.join(guildId, id, userId, bot) : this.leave(guildId, id, userId, bot);
  }
  private async refresh(row: CommunityEvent) {
    let orphan: { channelId: string; messageId: string } | undefined;
    try {
      const gateway = await this.gateway(row.guildId);
      await this.repository.syncAnnouncement(row.guildId, row.id, async (current, participants) => {
        if (current.announcementMessageId) {
          try { await gateway.update(current.channelId, current.announcementMessageId, current, participants); return {}; }
          catch (error) { if (!gateway.isMissing(error)) throw error; }
        }
        const messageId = await gateway.post(current.channelId, current, participants);
        orphan = { channelId: current.channelId, messageId };
        return { messageId };
      });
      orphan = undefined;
    } catch {
      if (orphan) try { await (await this.gateway(row.guildId)).remove(orphan.channelId, orphan.messageId); } catch { /* pending reconciliation */ }
      try { await this.repository.deferPresentation(row.guildId, row.id); }
      catch { this.logger.warn({ guildId: row.guildId, eventId: row.id }, 'Event presentation retry scheduling failed'); }
      this.logger.warn({ guildId: row.guildId, eventId: row.id }, 'Event announcement pending reconciliation');
    }
  }
  async runDue(now = new Date()) {
    const transitions = await this.repository.transitionDue(now, 20, this.isEnabled);
    for (const row of transitions) await this.refresh(row);
    await this.repository.cancelExpiredReminders(now);
    const presentations = await this.repository.claimPendingPresentations(now);
    for (const row of presentations) if (await this.isEnabled(row.guildId)) await this.refresh(row);
    const due = await this.repository.claimDue(now);
    for (const { event, reminder } of due) {
      try {
        await this.repository.deliverReminder(event.guildId, event.id, reminder.offsetSeconds, reminder.claimedAt!, now,
          async current => (await this.gateway(event.guildId)).remind(current.channelId, current, reminder.offsetSeconds), this.isEnabled, event.startAt);
      } catch { this.logger.warn({ guildId: event.guildId, eventId: event.id, offsetSeconds: reminder.offsetSeconds }, 'Event reminder pending recovery'); }
    }
    return due.length;
  }
}
