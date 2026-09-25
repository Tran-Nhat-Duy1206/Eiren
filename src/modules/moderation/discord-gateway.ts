import { DiscordAPIError, PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { ModerationAction, ModerationCase } from './repository.js';
import type { ModerationGateway } from './service.js';

function unknownDiscordObject(error: unknown, code: number) {
  return error instanceof DiscordAPIError && error.code === code;
}
export class DiscordModerationGateway implements ModerationGateway {
  constructor(private readonly guild: Guild, private readonly actorId: string) {}
  private async memberOrNull(userId: string) {
    try { return await this.guild.members.fetch(userId); }
    catch (error) { if (unknownDiscordObject(error, 10007)) return null; throw error; }
  }
  private async hierarchy(targetId: string) {
    if (targetId === this.guild.ownerId || targetId === this.guild.client.user?.id)
      throw new AppError('PERMISSION', 'The guild owner or bot cannot be moderated.');
    const target = await this.memberOrNull(targetId);
    if (!target) return null;
    if (this.actorId !== this.guild.ownerId) {
      const actor = await this.guild.members.fetch(this.actorId);
      if (actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)
        throw new AppError('PERMISSION', 'Your Discord role must be higher than the target role.');
    }
    return target;
  }
  private async assertNotBanned(targetId: string) {
    try {
      await this.guild.bans.fetch(targetId);
      throw new AppError('CONFLICT', 'This user is already banned; refusing to replace an existing ban.');
    } catch (error) {
      if (unknownDiscordObject(error, 10026)) return; // Discord Unknown Ban
      throw error;
    }
  }
  private async botCan(target: GuildMember | null, permission: bigint) {
    const bot = await this.guild.members.fetchMe();
    if (!bot.permissions.has(permission)) throw new AppError('PERMISSION', 'The bot lacks the required Discord permission.');
    if (target && bot.roles.highest.comparePositionTo(target.roles.highest) <= 0)
      throw new AppError('PERMISSION', 'The bot role must be higher than the target role.');
  }
  async assertCan(action: ModerationAction, targetId: string) {
    if (action === 'PURGE') {
      await this.botCan(null, PermissionFlagsBits.ManageMessages);
      return;
    }
    const member = await this.hierarchy(targetId);
    if (action === 'TIMEOUT') {
      if (!member) throw new AppError('NOT_FOUND', 'The target must be a server member to receive a timeout.');
      if (member.permissions.has(PermissionFlagsBits.Administrator)) throw new AppError('PERMISSION', 'Discord cannot timeout an administrator.');
      await this.botCan(member, PermissionFlagsBits.ModerateMembers);
    } else if (action === 'KICK') {
      if (!member) throw new AppError('NOT_FOUND', 'The target must be a server member to be kicked.');
      await this.botCan(member, PermissionFlagsBits.KickMembers);
    } else if (action === 'BAN' || action === 'TEMPBAN' || action === 'UNBAN') {
      await this.botCan(member, PermissionFlagsBits.BanMembers);
      if (action === 'BAN' || action === 'TEMPBAN') await this.assertNotBanned(targetId);
    }
  }
  async apply(action: ModerationAction, targetId: string, reason: string, caseId: number,
    durationSeconds?: number, metadata: Record<string, string | number | boolean | null> = {}) {
    const auditReason = `[Eiren case #${caseId}] ${reason}`;
    if (action === 'TIMEOUT') {
      const member = await this.guild.members.fetch(targetId);
      await member.timeout(durationSeconds! * 1000, auditReason);
    } else if (action === 'KICK') {
      const member = await this.guild.members.fetch(targetId);
      await member.kick(auditReason);
    } else if (action === 'BAN' || action === 'TEMPBAN') {
      // Repeat the check immediately before PUT: Discord would otherwise replace a pre-existing ban.
      await this.assertNotBanned(targetId);
      await this.guild.bans.create(targetId, { reason: auditReason, deleteMessageSeconds: 0 });
    } else if (action === 'UNBAN') {
      await this.guild.bans.remove(targetId, auditReason);
    } else if (action === 'PURGE') {
      const channelId = metadata.channelId;
      const count = metadata.count;
      if (typeof channelId !== 'string' || !/^\d{17,20}$/.test(channelId) || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100)
        throw new AppError('VALIDATION', 'Purge requires a channel and 1–100 messages.');
      const channel = await this.guild.channels.fetch(channelId);
      if (!channel || !('bulkDelete' in channel) || typeof channel.bulkDelete !== 'function')
        throw new AppError('VALIDATION', 'Purge requires a text channel supporting bulk deletion.');
      const deleted = await channel.bulkDelete(count, true);
      return { channelId, deletedCount: deleted.size };
    }
    return metadata;
  }
  async expire(record: ModerationCase): Promise<'EXPIRED' | 'SUPERSEDED'> {
    if (record.action === 'TIMEOUT') {
      const member = await this.memberOrNull(record.targetId);
      const current = member?.communicationDisabledUntilTimestamp;
      // Discord clears timed-out status itself; do not cancel a later manual extension.
      return current && record.expiresAt && current > record.expiresAt.getTime() + 5000 ? 'SUPERSEDED' : 'EXPIRED';
    }
    if (record.action !== 'TEMPBAN') return 'SUPERSEDED';
    let ban;
    try { ban = await this.guild.bans.fetch(record.targetId); }
    catch (error) { if (unknownDiscordObject(error, 10026)) return 'EXPIRED'; throw error; }
    if (!ban.reason?.includes(`[Eiren case #${record.id}]`)) return 'SUPERSEDED';
    await this.guild.bans.remove(record.targetId, `[Eiren case #${record.id}] Temporary ban expired`);
    return 'EXPIRED';
  }
}
