import { AppError } from '../../core/errors/errors.js';
import type { Logger } from '../../core/logger/logger.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import { TempvoiceRepository, type TempvoiceRoom } from './repository.js';
import type { TempvoiceGateway } from './discord-gateway.js';

const idPattern = /^\d{17,20}$/;
export const EMPTY_GRACE_MS = 60_000;
export function roomName(name: string) { const trimmed = name.trim(); if (!trimmed || trimmed.length > 100 || /[\r\n]/.test(trimmed)) throw new AppError('VALIDATION', 'Room name must be 1–100 characters on one line.'); return trimmed; }
export function roomLimit(limit: number) { if (!Number.isInteger(limit) || limit < 0 || limit > 99) throw new AppError('VALIDATION', 'User limit must be between 0 and 99.'); return limit; }
export class TempvoiceService {
  constructor(private readonly repository: TempvoiceRepository, private readonly permissions: PermissionService, private readonly logger: Logger,
    private readonly gatewayForGuild: (guildId: string) => Promise<TempvoiceGateway>) {}
  async settings(actor: Actor) { await this.permissions.require(actor, 'ADMIN'); return this.repository.settings(actor.guildId); }
  async setup(actor: Actor, lobbyChannelId: string, categoryId: string, userLimit = 0, defaultPrivate = true) {
    await this.permissions.require(actor, 'ADMIN');
    if (!idPattern.test(lobbyChannelId) || !idPattern.test(categoryId) || lobbyChannelId === categoryId) throw new AppError('VALIDATION', 'Choose a valid lobby and category.');
    roomLimit(userLimit);
    await (await this.gatewayForGuild(actor.guildId)).validate(lobbyChannelId, categoryId);
    return this.repository.configure(actor.guildId, { enabled: true, lobbyChannelId, categoryId, userLimit, defaultPrivate });
  }
  async disable(actor: Actor) { await this.permissions.require(actor, 'ADMIN'); return this.repository.configure(actor.guildId, { enabled: false }); }
  async joinedLobby(guildId: string, ownerId: string, lobbyId: string) {
    const settings = await this.repository.settings(guildId);
    if (!settings?.enabled || settings.lobbyChannelId !== lobbyId || !settings.categoryId) return;
    const gateway = await this.gatewayForGuild(guildId);
    if (!await gateway.inChannel(ownerId, lobbyId)) return;
    const { row, created } = await this.repository.reserve(guildId, ownerId);
    if (!created) {
      if (row.status === 'ACTIVE' && row.channelId && await gateway.exists(row.channelId) && await gateway.inChannel(ownerId, lobbyId)) {
        await this.repository.rejoin(guildId, ownerId, row.channelId, () => gateway.move(ownerId, row.channelId!));
      }
      return;
    }
    let channelId: string | undefined;
    let moved = false;
    try {
      await gateway.validate(lobbyId, settings.categoryId);
      channelId = await gateway.create(settings.categoryId, ownerId, row.id, roomName(`Room ${ownerId}`), roomLimit(settings.userLimit), settings.defaultPrivate);
      const attached = await this.repository.attach(row.id, channelId);
      if (!attached) throw new AppError('CONFLICT', 'Voice room reservation changed.');
      if (!await gateway.inChannel(ownerId, lobbyId)) throw new AppError('CONFLICT', 'Member left the lobby during room creation.');
      await gateway.move(ownerId, channelId);
      moved = true;
      if (!await this.repository.activate(row.id)) throw new AppError('CONFLICT', 'Voice room reservation changed.');
    } catch (error) {
      if (moved) {
        this.logger.error({ guildId, roomId: row.id, channelId }, 'Moved occupant needs voice room reconciliation');
        try { await this.repository.activate(row.id); } catch { /* reservation remains recoverable */ }
      } else if (channelId) {
        try {
          if ((await gateway.occupants(channelId)).length) { this.logger.error({ guildId, roomId: row.id, channelId }, 'Occupied room requires reconciliation'); }
          else { await gateway.delete(channelId); await this.repository.close(row.id); }
        } catch { this.logger.error({ guildId, roomId: row.id, channelId }, 'Temporary voice orphan requires reconciliation'); }
      } else {
        // A Discord create may succeed but its response fail; retain the reservation until marker recovery.
        this.logger.error({ guildId, roomId: row.id }, 'Creation outcome unknown; marker reconciliation required');
      }
      if (!(error instanceof AppError && error.code === 'CONFLICT')) throw error;
    }
  }
  async voiceChanged(guildId: string, userId: string, before: string | null, after: string | null) {
    if (before === after) return;
    const gateway = await this.gatewayForGuild(guildId);
    if (before) {
      const row = await this.repository.byChannel(guildId, before);
      if (row?.status === 'ACTIVE') {
        try { await this.repository.markEmpty(guildId, before, (await gateway.occupants(before)).length === 0); }
        catch (error) { if (error instanceof AppError && error.code === 'NOT_FOUND') await this.repository.close(row.id); else throw error; }
      }
    }
    if (after) {
      const room = await this.repository.byChannel(guildId, after);
      if (room?.status === 'ACTIVE') await this.repository.markEmpty(guildId, after, false);
      await this.joinedLobby(guildId, userId, after);
    }
  }
  async channelDeleted(guildId: string, channelId: string) {
    const room = await this.repository.byChannel(guildId, channelId);
    if (room) await this.repository.close(room.id);
  }
  async control(actor: Actor, channelId: string | null, action: 'rename' | 'lock' | 'unlock' | 'limit' | 'kick' | 'allow' | 'deny' | 'transfer' | 'status', value?: string | number) {
    if (!channelId) throw new AppError('VALIDATION', 'Join your active voice room first.');
    const gateway = await this.gatewayForGuild(actor.guildId);
    if (action === 'transfer') {
      const target = String(value);
      if (!await gateway.inChannel(actor.userId, channelId)) throw new AppError('PERMISSION', 'Join your room before transferring ownership.');
      if (!idPattern.test(target) || target === actor.userId || target === actor.guildId || target === actor.guildOwnerId || !await gateway.humanMember(target) || !await gateway.inChannel(target, channelId)) throw new AppError('VALIDATION', 'New owner must be another member in this room.');
      try { return await this.repository.transfer(actor.guildId, channelId, actor.userId, target, async row => {
        if (!await gateway.inChannel(actor.userId, row.channelId!) || !await gateway.inChannel(target, row.channelId!)) throw new AppError('CONFLICT', 'Both members must remain in the voice room during transfer.');
        return gateway.transfer(row.channelId!, row.ownerId, target);
      }); }
      catch (error) { this.logger.error({ guildId: actor.guildId, channelId, previousOwnerId: actor.userId, newOwnerId: target }, 'Voice transfer failed; check overwrites against database owner'); throw error; }
    }
    return this.repository.withActive(actor.guildId, channelId, actor.userId, async room => {
      const id = room.channelId!;
      if (!await gateway.inChannel(actor.userId, id)) throw new AppError('PERMISSION', 'Join your room before changing its controls.');
      if (!await gateway.exists(id)) throw new AppError('NOT_FOUND', 'Room was deleted; reconciliation will close it.');
      if (action === 'rename') await gateway.rename(id, roomName(String(value)));
      else if (action === 'limit') await gateway.limit(id, roomLimit(Number(value)));
      else if (action === 'lock' || action === 'unlock') await gateway.lock(id, action === 'lock');
      else if (action !== 'status') {
        const target = String(value);
        if (!idPattern.test(target) || target === actor.userId || target === actor.guildId || target === actor.guildOwnerId || !await gateway.humanMember(target)) throw new AppError('VALIDATION', 'Choose another server member.');
        if (action === 'kick') await gateway.kick(id, target);
        else await gateway.access(id, target, action === 'allow');
      }
      return room;
    });
  }
  private async reconcile(row: TempvoiceRoom, now: Date, startup = false) {
    const gateway = await this.gatewayForGuild(row.guildId);
    if (row.status === 'CREATING' && !row.channelId && row.createdAt.getTime() <= now.getTime() - EMPTY_GRACE_MS) {
      // Settings.categoryId can change after Discord creates a room but before attachment.
      // Search every guild voice channel; never conclude that an uncertain create produced no channel.
      const matches = await gateway.findReservation(row.id, row.ownerId);
      if (matches.length !== 1) {
        this.logger.error({ guildId: row.guildId, roomId: row.id, matchCount: matches.length }, 'Unresolved room reservation requires manual reconciliation');
        return;
      }
      if (!await this.repository.attach(row.id, matches[0]!)) return;
    }
    await this.repository.cleanup(row.id, current => current.status === 'DELETING' || current.status === 'CREATING' && current.createdAt.getTime() <= now.getTime() - EMPTY_GRACE_MS || current.status === 'ACTIVE' && !!current.emptySince && current.emptySince.getTime() <= now.getTime() - EMPTY_GRACE_MS,
      async current => {
        if (!current.channelId || !await gateway.exists(current.channelId)) return true;
        let restore: (() => Promise<void>) | undefined;
        try {
          restore = await gateway.seal(current.channelId!);
          // Discord has no atomic join/delete API; seal reduces but cannot eliminate external joins
          // by members with elevated or explicit Connect permissions.
          if ((await gateway.occupants(current.channelId!)).length) { await restore(); return 'occupied'; }
          await gateway.delete(current.channelId!); return true;
        } catch {
          if (restore) { try { await restore(); } catch { this.logger.error({ guildId: current.guildId, roomId: current.id, channelId: current.channelId }, 'Failed to restore temporary voice overwrite'); } }
          this.logger.error({ guildId: current.guildId, roomId: current.id, channelId: current.channelId }, 'Temporary voice deletion pending reconciliation'); return false;
        }
      });
  }
  async runDue(now = new Date()) {
    for (const room of await this.repository.pending(now, EMPTY_GRACE_MS)) await this.reconcile(room, now);
    for (const room of await this.repository.outstanding()) if (room.status === 'DELETING' || room.status === 'CREATING' && room.createdAt.getTime() <= now.getTime() - EMPTY_GRACE_MS) await this.reconcile(room, now);
  }
  async reconcileActive(now = new Date()) {
    for (const row of await this.repository.outstanding()) {
      const gateway = await this.gatewayForGuild(row.guildId);
      if (row.status === 'ACTIVE' && row.channelId) {
        if (!await gateway.exists(row.channelId)) { await this.repository.close(row.id); continue; }
        await this.repository.markEmpty(row.guildId, row.channelId, (await gateway.occupants(row.channelId)).length === 0);
      } else await this.reconcile(row, now, true);
    }
    await this.runDue(now);
  }
}
