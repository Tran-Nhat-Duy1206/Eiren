import { AppError } from '../../core/errors/errors.js';
import { type Actor, type PermissionService } from '../../core/permissions/permission-service.js';
import type { Logger } from '../../core/logger/logger.js';
import type { GuildLogNotifier } from '../../services/log-notifier.js';
import type { TicketGateway } from './discord-gateway.js';
import { TicketRepository, type Ticket, type TicketType } from './repository.js';

export const ticketTypes: readonly TicketType[] = ['SUPPORT', 'REPORT', 'APPEAL', 'PARTNERSHIP', 'BUG_REPORT', 'OTHER'];
export class TicketService {
  constructor(private readonly repository: TicketRepository, private readonly permissions: PermissionService,
    private readonly logger: Logger, private readonly gatewayForGuild: (guildId: string) => Promise<TicketGateway>, private readonly notify?: GuildLogNotifier) {}
  private async staff(actor: Actor, minimum: 'HELPER' | 'MODERATOR' | 'ADMIN') { await this.permissions.require(actor, minimum); }
  private async ticket(actor: Actor, id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('VALIDATION', 'Invalid ticket ID.');
    const ticket = await this.repository.get(actor.guildId, id);
    if (!ticket) throw new AppError('NOT_FOUND', 'Ticket not found.');
    return ticket;
  }
  private async visible(actor: Actor, ticket: Ticket) {
    if (ticket.creatorId === actor.userId || (await this.repository.participants(ticket.id)).some(p => p.userId === actor.userId)) return;
    await this.staff(actor, 'HELPER');
  }
  async settings(actor: Actor) { await this.staff(actor, 'ADMIN'); return this.repository.settings(actor.guildId); }
  async configure(actor: Actor, patch: { staffRoleId?: string | null; transcriptChannelId?: string | null; maxActiveTickets?: number }) {
    await this.staff(actor, 'ADMIN');
    if (patch.maxActiveTickets !== undefined && (!Number.isInteger(patch.maxActiveTickets) || patch.maxActiveTickets < 1 || patch.maxActiveTickets > 10))
      throw new AppError('VALIDATION', 'Maximum active tickets must be 1–10.');
    for (const id of [patch.staffRoleId, patch.transcriptChannelId]) if (id !== undefined && id !== null && !/^\d{17,20}$/.test(id)) throw new AppError('VALIDATION', 'Invalid Discord ID.');
    return this.repository.configure(actor.guildId, patch);
  }
  async open(actor: Actor, type: TicketType) {
    if (!ticketTypes.includes(type)) throw new AppError('VALIDATION', 'Unknown ticket type.');
    const { setting, categoryId } = await this.repository.settings(actor.guildId);
    if (!categoryId || !setting?.staffRoleId) throw new AppError('VALIDATION', 'Ticket category and staff role must be configured first.');
    const gateway = await this.gatewayForGuild(actor.guildId);
    await gateway.assertConfiguration(categoryId, setting.staffRoleId);
    const row = await this.repository.reserve(actor.guildId, actor.userId, type, setting.maxActiveTickets);
    let channelId: string | undefined;
    try {
      channelId = await gateway.create(categoryId, setting.staffRoleId, actor.userId, row.id, type);
      const attached = await this.repository.attach(actor.guildId, row.id, channelId);
      if (!attached) throw new AppError('CONFLICT', 'Ticket creation state changed.');
      await this.log(actor.guildId, 'Ticket opened', row.id, actor.userId);
      return attached;
    } catch (error) {
      if (channelId) {
        try { await gateway.delete(channelId); } catch { this.logger.error({ guildId: actor.guildId, ticketId: row.id, channelId }, 'Orphaned ticket channel requires manual cleanup'); }
      }
      await this.repository.abandon(actor.guildId, row.id);
      throw error;
    }
  }
  async claim(actor: Actor, id: number) {
    await this.staff(actor, 'HELPER');
    const gateway = await this.gatewayForGuild(actor.guildId);
    const row = await this.repository.claim(actor.guildId, id, actor.userId, async (ticket, alreadyParticipant) => {
      const grant = ticket.creatorId !== actor.userId && !alreadyParticipant;
      if (grant) await gateway.setParticipant(ticket.channelId!, actor.userId, true);
      return async () => {
        if (grant) await gateway.setParticipant(ticket.channelId!, actor.userId, false);
      };
    });
    await this.log(actor.guildId, 'Ticket claimed', id, actor.userId);
    return row;
  }
  async transfer(actor: Actor, id: number, userId: string) {
    await this.staff(actor, 'MODERATOR');
    const gateway = await this.gatewayForGuild(actor.guildId);
    if (!/^\d{17,20}$/.test(userId) || !await gateway.memberExists(userId)) throw new AppError('NOT_FOUND', 'Staff member not found.');
    await this.staff({ ...actor, userId, roleIds: await gateway.memberRoleIds(userId) }, 'HELPER');
    const row = await this.repository.transfer(actor.guildId, id, userId, async (previous, oldParticipant, newParticipant) => {
      const channelId = previous.channelId!;
      const oldId = previous.assignedStaffId;
      const revokeOld = !!oldId && oldId !== userId && oldId !== previous.creatorId && !oldParticipant;
      const grantNew = userId !== previous.creatorId && !newParticipant;
      if (grantNew) await gateway.setParticipant(channelId, userId, true);
      try {
        if (revokeOld) await gateway.setParticipant(channelId, oldId, false);
      } catch (error) {
        if (grantNew && userId !== oldId) {
          try { await gateway.setParticipant(channelId, userId, false); }
          catch { this.logger.error({ guildId: actor.guildId, ticketId: id, userId }, 'Transfer grant requires manual reconciliation'); }
        }
        throw error;
      }
      return async () => {
        if (revokeOld) await gateway.setParticipant(channelId, oldId, true);
        if (grantNew && userId !== oldId) await gateway.setParticipant(channelId, userId, false);
      };
    });
    await this.log(actor.guildId, 'Ticket transferred', id, actor.userId);
    return row;
  }
  async participant(actor: Actor, id: number, userId: string, add: boolean) {
    await this.staff(actor, 'HELPER');
    const row = await this.ticket(actor, id);
    if (row.status === 'CLOSED' || !row.channelId) throw new AppError('CONFLICT', 'Ticket is not active.');
    if (userId === row.creatorId) throw new AppError('VALIDATION', 'Cannot modify ticket creator access.');
    if (!/^\d{17,20}$/.test(userId)) throw new AppError('VALIDATION', 'Invalid member ID.');
    const gateway = await this.gatewayForGuild(actor.guildId);
    const { setting } = await this.repository.settings(actor.guildId);
    if (userId === actor.guildId || userId === gateway.botId() || userId === setting?.staffRoleId || userId === row.assignedStaffId)
      throw new AppError('VALIDATION', 'Cannot change server-wide, bot, or assigned staff access.');
    const updated = await this.repository.changeParticipant(actor.guildId, id, userId, actor.userId, add,
      () => gateway.setParticipant(row.channelId!, userId, add),
      async () => {
        try { await gateway.setParticipant(row.channelId!, userId, !add); }
        catch { this.logger.error({ guildId: actor.guildId, ticketId: id, userId }, 'Participant access requires manual reconciliation'); }
      });
    await this.log(actor.guildId, add ? 'Ticket participant added' : 'Ticket participant removed', id, actor.userId);
    return updated;
  }
  async close(actor: Actor, id: number, reason = 'Closed by request') {
    const row = await this.ticket(actor, id);
    if (actor.userId !== row.creatorId) await this.staff(actor, 'MODERATOR');
    if (!reason.trim() || reason.length > 400) throw new AppError('VALIDATION', 'Provide a reason up to 400 characters.');
    if (!row.channelId) throw new AppError('CONFLICT', 'Ticket channel is still being created.');
    const gateway = await this.gatewayForGuild(actor.guildId);
    // The database row lock spans fetch and transition: concurrent closers cannot persist duplicate transcripts.
    const { row: closed, changed } = await this.repository.archive(actor.guildId, id, actor.userId, reason.trim(), channelId => gateway.transcript(channelId));
    // Cleanup can be retried by issuing /ticket close again if Discord was temporarily unavailable.
    try { await gateway.delete(row.channelId); }
    catch (error) { this.logger.error({ guildId: actor.guildId, ticketId: id, errorType: error instanceof Error ? error.name : 'unknown' }, 'Closed ticket channel requires cleanup; retry /ticket close'); }
    if (changed) await this.log(actor.guildId, 'Ticket closed', id, actor.userId);
    return closed;
  }
  async transcript(actor: Actor, id: number) {
    await this.staff(actor, 'MODERATOR');
    const row = await this.ticket(actor, id);
    if (row.transcriptRedactedAt) throw new AppError('NOT_FOUND', 'The retained transcript was removed under the guild retention policy.');
    if (!row.transcriptGeneratedAt || row.transcript === null) throw new AppError('NOT_FOUND', 'No completed transcript is available for this ticket.');
    return row.transcript;
  }
  async status(actor: Actor, id: number) { const row = await this.ticket(actor, id); await this.visible(actor, row); return row; }
  async list(actor: Actor, all = false) {
    if (all) await this.staff(actor, 'HELPER');
    return this.repository.list(actor.guildId, all ? undefined : actor.userId);
  }
  private async log(guildId: string, title: string, ticketId: number, actorId: string) {
    try { await this.notify?.(guildId, 'moderation', title, [{ name: 'Ticket', value: String(ticketId) }], { actorId }); }
    catch { this.logger.warn({ guildId, ticketId }, 'Ticket lifecycle notification failed'); }
  }
}
