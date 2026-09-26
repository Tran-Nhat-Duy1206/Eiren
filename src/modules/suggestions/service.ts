import { AppError } from '../../core/errors/errors.js';
import type { Logger } from '../../core/logger/logger.js';
import type { GuildLogService } from '../logging/guild-log-service.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import { statuses, type SuggestionRepository, type SuggestionStatus, type Suggestion } from './repository.js';
import type { SuggestionGateway } from './discord-gateway.js';

export class SuggestionService {
  constructor(private readonly repository: SuggestionRepository, private readonly permissions: PermissionService,
    private readonly gateway: (guildId: string) => Promise<SuggestionGateway>, private readonly logger: Logger,
    private readonly guildLogs?: Pick<GuildLogService, 'send'>) {}
  async settings(actor: Actor) { await this.permissions.require(actor, 'ADMIN'); return this.repository.settings(actor.guildId); }
  async configure(actor: Actor, channelId: string | null) {
    await this.permissions.require(actor, 'ADMIN');
    if (channelId) await (await this.gateway(actor.guildId)).validateChannel(channelId);
    return this.repository.configure(actor.guildId, channelId);
  }
  async create(guildId: string, authorId: string, content: string) {
    const text = content.trim();
    if (!text || text.length > 2000) throw new AppError('VALIDATION', 'Suggestion must be 1–2000 characters.');
    const settings = await this.repository.settings(guildId);
    if (!settings?.channelId) throw new AppError('VALIDATION', 'Configure a suggestions channel first.');
    const row = await this.repository.create(guildId, authorId, text, settings.channelId);
    let messageId: string;
    let gateway: SuggestionGateway;
    try {
      gateway = await this.gateway(guildId);
      messageId = await gateway.post(settings.channelId, row, { up: 0, down: 0 });
    } catch {
      this.logger.warn({ guildId, suggestionId: row.id, channelId: settings.channelId }, 'Suggestion post pending reconciliation');
      return { row, posted: false as const };
    }
    try {
      const attached = await this.repository.attach(guildId, row.id, settings.channelId, messageId);
      if (!attached) throw new Error('Suggestion attachment not persisted');
    } catch {
      this.logger.warn({ guildId, suggestionId: row.id, channelId: settings.channelId, messageId }, 'Suggestion post attachment failed; removing orphan');
      try { await gateway.remove(settings.channelId, messageId); }
      catch { this.logger.warn({ guildId, suggestionId: row.id, channelId: settings.channelId, messageId }, 'Suggestion orphan removal failed'); }
      return { row, posted: false as const };
    }
    return { row, posted: true as const };
  }
  async view(guildId: string, id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new AppError('VALIDATION', 'Invalid suggestion ID.');
    const row = await this.repository.get(guildId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Suggestion not found.');
    return { row, counts: await this.repository.totals(id) };
  }
  private async refresh(row: Suggestion) {
    if (!row.channelId || !row.messageId) return;
    try { await (await this.gateway(row.guildId)).update(row.channelId, row.messageId, row, await this.repository.totals(row.id)); }
    catch { this.logger.warn({ guildId: row.guildId, suggestionId: row.id, status: row.status }, 'Suggestion post update failed'); }
  }
  private async logReview(row: Suggestion, action: 'status' | 'response', actorId: string) {
    try {
      await this.guildLogs?.send(row.guildId, 'general', `Suggestion ${action}`, [
        { name: 'Suggestion ID', value: String(row.id) },
        { name: 'Status', value: row.status },
      ], { actorId });
    } catch {
      this.logger.warn({ guildId: row.guildId, suggestionId: row.id, status: row.status }, 'Suggestion audit log failed');
    }
  }
  async status(actor: Actor, id: number, status: string) {
    await this.permissions.require(actor, 'MODERATOR');
    await this.view(actor.guildId, id);
    if (!statuses.includes(status as SuggestionStatus)) throw new AppError('VALIDATION', 'Invalid suggestion status.');
    const row = (await this.repository.setStatus(actor.guildId, id, status as SuggestionStatus, actor.userId))!;
    await this.refresh(row);
    await this.logReview(row, 'status', actor.userId);
    return row;
  }
  async respond(actor: Actor, id: number, response: string) {
    await this.permissions.require(actor, 'MODERATOR');
    await this.view(actor.guildId, id);
    const text = response.trim();
    if (!text || text.length > 1000) throw new AppError('VALIDATION', 'Response must be 1–1000 characters.');
    const row = (await this.repository.respond(actor.guildId, id, text, actor.userId))!;
    await this.refresh(row);
    await this.logReview(row, 'response', actor.userId);
    return row;
  }
  async vote(guildId: string, id: number, userId: string, choice: 1 | -1,
    channelId: string, messageId: string, bot: boolean) {
    if (bot) throw new AppError('VALIDATION', 'Bots cannot vote.');
    const { row } = await this.view(guildId, id);
    if (!row.messageId || row.messageId !== messageId || row.channelId !== channelId)
      throw new AppError('VALIDATION', 'This suggestion button is stale.');
    const changed = await this.repository.vote(id, userId, choice);
    if (changed) await this.refresh(row);
    return changed;
  }
}
