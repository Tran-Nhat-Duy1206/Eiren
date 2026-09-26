import { randomInt } from 'node:crypto';
import type { Database } from '../../core/database/connection.js';
import type { Logger } from '../../core/logger/logger.js';
import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import type { ModuleService } from '../../services/module-service.js';
import { levelForXp } from '../levels/formula.js';
import type { Giveaway, GiveawayRepository } from './repository.js';

export interface GiveawayGateway {
  validateChannel(channelId: string): Promise<void>;
  post(row: Giveaway, entries: number): Promise<string>;
  remove(channelId: string, messageId: string): Promise<void>;
  refresh(row: Giveaway, entries: number): Promise<void>;
  announce(row: Giveaway, winners: string[], drawId: number): Promise<string>;
  findAnnouncement(row: Giveaway, drawId: number): Promise<string | null>;
  member(userId: string): Promise<{ bot: boolean; createdAt: Date; joinedAt: Date | null; roleIds: string[] } | null>;
}
export type GiveawayCreate = { channelId: string; prize: string; endAt: Date; winnerCount: number; requiredRoleId?: string | null; minAccountAgeSeconds?: number | null; minGuildAgeSeconds?: number | null; requireVerified?: boolean; minLevel?: number | null };
export function chooseWinners(ids: string[], count: number): string[] {
  const pool = [...new Set(ids)];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const j = i + randomInt(pool.length - i);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, Math.min(count, pool.length));
}
export class GiveawayService {
  constructor(private readonly repository: GiveawayRepository, private readonly permissions: PermissionService,
    private readonly modules: ModuleService, private readonly gateway: (guildId: string) => Promise<GiveawayGateway>,
    private readonly logger: Logger, private readonly onWon?: (guildId: string, userId: string) => Promise<void>) {}
  private async enabled(guildId: string) { if (!await this.modules.isEnabled(guildId, 'giveaways')) throw new AppError('CONFLICT', 'Giveaways are disabled.'); }
  async create(actor: Actor, input: GiveawayCreate) {
    await this.permissions.require(actor, 'MODERATOR'); await this.enabled(actor.guildId);
    const prize = input.prize.trim();
    if (!prize || prize.length > 256 || !Number.isSafeInteger(input.winnerCount) || input.winnerCount < 1 || input.winnerCount > 20 ||
      !Number.isFinite(input.endAt.getTime()) || input.endAt.getTime() <= Date.now() + 1000 || input.endAt.getTime() > Date.now() + 365 * 86400000)
      throw new AppError('VALIDATION', 'Invalid giveaway prize, winner count, or end time.');
    for (const value of [input.minAccountAgeSeconds, input.minGuildAgeSeconds, input.minLevel])
      if (value != null && (!Number.isSafeInteger(value) || value < 0 || value > 31_536_000)) throw new AppError('VALIDATION', 'Invalid eligibility threshold.');
    if (input.minLevel != null && input.minLevel > 10000) throw new AppError('VALIDATION', 'Minimum level cannot exceed 10000.');
    if (input.requireVerified && !await this.modules.isEnabled(actor.guildId, 'verification')) throw new AppError('VALIDATION', 'Enable verification before requiring it.');
    if (input.minLevel && !await this.modules.isEnabled(actor.guildId, 'levels')) throw new AppError('VALIDATION', 'Enable levels before requiring a minimum level.');
    const gateway = await this.gateway(actor.guildId); await gateway.validateChannel(input.channelId);
    const row = await this.repository.create({ guildId: actor.guildId, creatorId: actor.userId, channelId: input.channelId,
      prize, startAt: new Date(), endAt: input.endAt, winnerCount: input.winnerCount, status: 'ACTIVE', messageId: null,
      requiredRoleId: input.requiredRoleId ?? null, minAccountAgeSeconds: input.minAccountAgeSeconds ?? null,
      minGuildAgeSeconds: input.minGuildAgeSeconds ?? null, requireVerified: input.requireVerified ?? false, minLevel: input.minLevel ?? null });
    try { const messageId = await gateway.post(row, await this.repository.entryCount(row.id)); const attached = await this.repository.attach(actor.guildId, row.id, messageId);
      if (!attached) { await gateway.remove(row.channelId, messageId); throw new Error('Attachment failed'); }
      return { row: attached, posted: true };
    } catch { this.logger.warn({ giveawayId: row.id }, 'Giveaway post pending reconciliation'); return { row, posted: false }; }
  }
  async view(guildId: string, id: number) {
    await this.enabled(guildId);
    if (!Number.isSafeInteger(id) || id < 1) throw new AppError('VALIDATION', 'Invalid giveaway ID.');
    const row = await this.repository.get(guildId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Giveaway not found.');
    return { row, entries: await this.repository.entryCount(id), draws: await this.repository.draws(id) };
  }
  private async eligible(row: Giveaway, userId: string, gateway: GiveawayGateway, now: Date, db?: Pick<Database, 'select'>, enabled?: { verification: boolean; levels: boolean }, cachedMember?: Awaited<ReturnType<GiveawayGateway['member']>>) {
    let member: Awaited<ReturnType<GiveawayGateway['member']>>;
    try { member = cachedMember === undefined ? await gateway.member(userId) : cachedMember; } catch { return false; }
    if (!member || member.bot || !member.joinedAt || member.joinedAt.getTime() > now.getTime() || member.createdAt.getTime() > now.getTime()) return false;
    if (row.requiredRoleId && !member.roleIds.includes(row.requiredRoleId)) return false;
    if (row.minAccountAgeSeconds && now.getTime() - member.createdAt.getTime() < row.minAccountAgeSeconds * 1000) return false;
    if (row.minGuildAgeSeconds && now.getTime() - member.joinedAt.getTime() < row.minGuildAgeSeconds * 1000) return false;
    if (row.requireVerified && (!(enabled?.verification ?? await this.modules.isEnabled(row.guildId, 'verification')) || !await this.repository.verified(row.guildId, userId, db))) return false;
    if (row.minLevel && (!(enabled?.levels ?? await this.modules.isEnabled(row.guildId, 'levels')) || levelForXp(await this.repository.level(row.guildId, userId, db) ?? 0) < row.minLevel)) return false;
    return true;
  }
  async entry(guildId: string, id: number, userId: string, action: 'enter' | 'leave', channelId: string, messageId: string, bot: boolean) {
    const { row } = await this.view(guildId, id);
    if (bot || row.status !== 'ACTIVE' || row.endAt <= new Date() || row.messageId !== messageId || row.channelId !== channelId)
      throw new AppError('VALIDATION', 'Giveaway is closed or this button is stale.');
    const gateway = await this.gateway(guildId);
    if (action === 'enter' && !await this.eligible(row, userId, gateway, new Date())) throw new AppError('VALIDATION', 'You do not meet the giveaway requirements.');
    const changed = await this.repository.entry(id, userId, action, channelId, messageId);
    if (changed === null) throw new AppError('VALIDATION', 'Giveaway closed, changed, or has reached the 300-entry limit.');
    if (changed) try { await gateway.refresh(row, await this.repository.entryCount(id)); }
    catch { this.logger.warn({ giveawayId: id }, 'Giveaway entry count refresh pending retry'); }
    return changed;
  }
  async end(actor: Actor, id: number) { await this.permissions.require(actor, 'MODERATOR'); return this.draw(actor.guildId, id, 'ORIGINAL', true); }
  async reroll(actor: Actor, id: number) { await this.permissions.require(actor, 'MODERATOR'); return this.draw(actor.guildId, id, 'REROLL'); }
  async draw(guildId: string, id: number, kind: 'ORIGINAL' | 'REROLL', manual = false) {
    const { row } = await this.view(guildId, id);
    const gateway = await this.gateway(guildId);
    const now = new Date();
    const enabled = { verification: !row.requireVerified || await this.modules.isEnabled(guildId, 'verification'),
      levels: !row.minLevel || await this.modules.isEnabled(guildId, 'levels') };
    let result: Awaited<ReturnType<GiveawayRepository['draw']>>;
    for (let attempt = 0; ; attempt++) {
      const entries = await this.repository.entries(id);
      if (entries.length > 300) throw new AppError('CONFLICT', 'Giveaway exceeds the 300-entry draw limit; no subset will be selected.');
      const members = new Map<string, Awaited<ReturnType<GiveawayGateway['member']>>>();
      // Eight bounded workers fetch all entrants; failures remain ineligible rather than biasing a truncated pool.
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
        while (cursor < entries.length) {
          const userId = entries[cursor++]!.userId;
          // A transient Discord failure aborts the whole draw; never silently remove a valid entrant.
          members.set(userId, await gateway.member(userId));
        }
      }));
      result = await this.repository.draw(guildId, id, kind, entries.map(entry => entry.userId),
        (userId, tx) => this.eligible(row, userId, gateway, now, tx, enabled, members.get(userId) ?? null), chooseWinners,
        manual && kind === 'ORIGINAL' ? new Date(Math.max(now.getTime(), row.endAt.getTime())) : now);
      if (result.state !== 'RETRY' || attempt >= 1) break;
    }
    if (result.state !== 'DRAWN') return result;
    try { await gateway.refresh(result.row, await this.repository.entryCount(id)); } catch { this.logger.warn({ giveawayId: id }, 'Giveaway message missing or cannot update'); }
    await this.reconcileDrawNotice(result.row, result.drawId, kind, gateway);
    for (const userId of result.winners) try { await this.onWon?.(guildId, userId); } catch { this.logger.warn({ giveawayId: id, userId }, 'Giveaway winner hook failed'); }
    return result;
  }
  private async reconcileDrawNotice(row: Giveaway, drawId: number, kind: 'ORIGINAL' | 'REROLL', gateway: GiveawayGateway) {
    const claim = await this.repository.claimDrawNotice(drawId);
    if (!claim) return;
    try {
      // Original notifications written before per-draw tracking must not be sent twice.
      const prior = kind === 'ORIGINAL' && row.resultAnnouncementId && !row.resultAnnouncementId.startsWith('PENDING:')
        ? row.resultAnnouncementId : await gateway.findAnnouncement(row, drawId);
      const winners = (await this.repository.drawWinners(drawId)).map(w => w.userId);
      const messageId = prior ?? await gateway.announce(row, winners, drawId);
      await this.repository.finishDrawNotice(drawId, claim, messageId);
      if (kind === 'ORIGINAL') try { await gateway.refresh(row, await this.repository.entryCount(row.id)); } catch { this.logger.warn({ giveawayId: row.id }, 'Giveaway original message missing'); }
    } catch { await this.repository.releaseDrawNotice(drawId, claim);
      this.logger.warn({ giveawayId: row.id, drawId }, 'Giveaway result notification pending retry'); }
  }
  async cancel(actor: Actor, id: number) { await this.permissions.require(actor, 'MODERATOR'); await this.enabled(actor.guildId);
    const row = await this.repository.cancel(actor.guildId, id); if (!row) throw new AppError('CONFLICT', 'Giveaway is not active.');
    try { await (await this.gateway(actor.guildId)).refresh(row, await this.repository.entryCount(id)); } catch { this.logger.warn({ giveawayId: id }, 'Giveaway message missing or cannot update'); }
    return row;
  }
  async runDue(limit = 20) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AppError('VALIDATION', 'Invalid batch size.');
    const rows = await this.repository.due(new Date(), limit);
    for (const row of rows) { try { if (await this.modules.isEnabled(row.guildId, 'giveaways')) await this.draw(row.guildId, row.id, 'ORIGINAL'); }
      catch { this.logger.warn({ giveawayId: row.id }, 'Giveaway draw failed; will retry'); } }
    const pending = await this.repository.pendingDrawNotices(limit);
    for (const { row, draw } of pending) try { if (await this.modules.isEnabled(row.guildId, 'giveaways'))
      await this.reconcileDrawNotice(row, draw.id, draw.kind as 'ORIGINAL' | 'REROLL', await this.gateway(row.guildId)); }
    catch { this.logger.warn({ giveawayId: row.id, drawId: draw.id }, 'Giveaway notification reconciliation failed'); }
    const missing = await this.repository.missingPosts(limit);
    for (const row of missing) try { if (await this.modules.isEnabled(row.guildId, 'giveaways')) {
      const gateway = await this.gateway(row.guildId);
      const messageId = await gateway.post(row, await this.repository.entryCount(row.id));
      if (!await this.repository.attach(row.guildId, row.id, messageId)) await gateway.remove(row.channelId, messageId);
    } } catch { this.logger.warn({ giveawayId: row.id }, 'Giveaway post reconciliation failed'); }
    // Round-robin reconciliation repairs counts and disabled buttons after transient Discord failures.
    const refreshes = await this.repository.refreshCandidates(limit);
    for (const row of refreshes) {
      try { if (await this.modules.isEnabled(row.guildId, 'giveaways'))
        await (await this.gateway(row.guildId)).refresh(row, await this.repository.entryCount(row.id)); }
      catch { this.logger.warn({ giveawayId: row.id }, 'Giveaway message refresh pending retry'); }
      finally { await this.repository.markRefreshAttempt(row.id); }
    }
    return rows.length + pending.length + missing.length + refreshes.length;
  }
}
