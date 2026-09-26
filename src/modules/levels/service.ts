import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { GuildLogNotifier } from '../../services/log-notifier.js';
import { levelForXp, progressForXp } from './formula.js';
import { LevelsRepository } from './repository.js';

const dangerous = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageWebhooks | PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageThreads | PermissionFlagsBits.ManageEvents | PermissionFlagsBits.ManageNicknames |
  PermissionFlagsBits.ViewAuditLog | PermissionFlagsBits.MentionEveryone | PermissionFlagsBits.ManageGuildExpressions;
export type LevelMessage = { guildId: string; userId: string; channelId: string; messageId: string;
  at: number; content?: string | null; bot?: boolean; system?: boolean; webhookId?: string | null };
export class LevelsService {
  constructor(readonly repository: LevelsRepository, private readonly client: Client, private readonly notify?: GuildLogNotifier) {}
  private async safeRole(guild: Guild, roleId: string) {
    const role = await guild.roles.fetch(roleId);
    if (!role || role.id === guild.id || role.managed || !role.editable || role.permissions.any(dangerous) ||
      await this.repository.mappedRole(guild.id, roleId))
      throw new AppError('VALIDATION', 'Reward role is missing, dangerous, managed, internal staff, or above the bot.');
    return role;
  }
  async addReward(guildId: string, level: number, roleId: string) {
    if (!Number.isSafeInteger(level) || level < 1 || level > 10000)
      throw new AppError('VALIDATION', 'Reward level must be between 1 and 10000.');
    await this.safeRole(await this.client.guilds.fetch(guildId), roleId);
    await this.repository.addReward(guildId, level, roleId);
  }
  async removeReward(guildId: string, level: number, roleId: string) { await this.repository.removeReward(guildId, level, roleId); }
  async handleMessage(message: LevelMessage) {
    if (!message.guildId || !message.userId || !message.channelId || !message.messageId || message.bot || message.system || message.webhookId ||
      !Number.isFinite(message.at) || message.at < 0) return null;
    const settings = await this.repository.settings(message.guildId);
    if (await this.repository.ignored(message.guildId, message.channelId)) return null;
    // Content may be unavailable without privileged Message Content intent. Never persist content.
    const content = message.content?.trim();
    if (content && (content.length < settings.minLength || /^[!/.?]\S/.test(content))) return null;
    const fingerprint = content ? createHash('sha256').update(content.toLowerCase()).digest('hex').slice(0, 24) : null;
    const result = await this.repository.award({ guildId: message.guildId, userId: message.userId,
      messageId: message.messageId, at: message.at, fingerprint }, settings);
    if (!result || result.after <= result.before || (!result.rewards.length && !settings.levelUpChannelId)) return result;
    try {
      const guild = await this.client.guilds.fetch(message.guildId);
      const member = await guild.members.fetch({ user: message.userId, force: true });
      for (const reward of result.rewards) {
        try {
          await this.safeRole(guild, reward.roleId);
          if (!member.roles.cache.has(reward.roleId)) await member.roles.add(reward.roleId, 'Level reward');
        } catch (error) {
          try { await this.notify?.(message.guildId, 'security', 'Level reward assignment failed', [
            { name: 'Member ID', value: message.userId }, { name: 'Role ID', value: reward.roleId },
            { name: 'Level', value: String(reward.level) },
            { name: 'Error type', value: error instanceof Error ? error.name : 'unknown' },
          ]); } catch { /* Logging must not corrupt committed XP. */ }
        }
      }
      if (settings.levelUpChannelId) {
        const channel = await guild.channels.fetch(settings.levelUpChannelId);
        if (channel?.isTextBased() && 'send' in channel) await channel.send({
          content: `<@${message.userId}> reached level ${result.after}!`, allowedMentions: { users: [message.userId] },
        });
      }
    } catch (error) {
      try { await this.notify?.(message.guildId, 'security', 'Level reward or announcement delivery failed', [
        { name: 'Member ID', value: message.userId }, { name: 'Level', value: String(result.after) },
        { name: 'Error type', value: error instanceof Error ? error.name : 'unknown' },
      ]); } catch { /* Logging must not corrupt committed XP. */ }
    }
    return result;
  }
  async rank(guildId: string, userId: string) {
    const row = await this.repository.member(guildId, userId);
    if (!row) return { guildId, userId, xp: 0, messageCount: 0, ...progressForXp(0), rank: null };
    return { ...row, ...progressForXp(row.xp), rank: await this.repository.rank(guildId, userId, row.xp) };
  }
  async leaderboard(guildId: string) {
    return (await this.repository.top(guildId, 10)).map((row, index) => ({ ...row, level: levelForXp(row.xp), rank: index + 1 }));
  }
  settings(guildId: string) { return this.repository.settings(guildId); }
  async configure(guildId: string, patch: Parameters<LevelsRepository['configure']>[1]) {
    if (patch.levelUpChannelId) {
      const guild = await this.client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(patch.levelUpChannelId);
      if (!channel || channel.type !== ChannelType.GuildText) throw new AppError('VALIDATION', 'Choose a server text channel for level-ups.');
      const me = await guild.members.fetchMe();
      if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
        throw new AppError('PERMISSION', 'Bot cannot view or send to the level-up channel.');
    }
    return this.repository.configure(guildId, patch);
  }
  rewards(guildId: string) { return this.repository.rewards(guildId); }
  ignoredChannels(guildId: string) { return this.repository.ignoredChannels(guildId); }
  ignore(guildId: string, channelId: string) { return this.repository.ignore(guildId, channelId); }
  allow(guildId: string, channelId: string) { return this.repository.allow(guildId, channelId); }
}
