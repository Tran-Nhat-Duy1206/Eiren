import { DiscordAPIError, PermissionFlagsBits, type ActionRowBuilder, type ButtonBuilder, type EmbedBuilder, type Guild, type GuildMember } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';

function unknownDiscordObject(error: unknown, code: number) {
  return error instanceof DiscordAPIError && error.code === code;
}
export interface PanelMessage { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }

export interface VerificationGateway {
  assertRoleUsable(roleId: string): Promise<{ id: string; name: string }>;
  applyQuarantine(memberId: string, roleId: string): Promise<void>;
  removeVerifiedRole(memberId: string, roleId: string): Promise<void>;
  completeVerification(memberId: string, verifiedRoleId: string, quarantineRoleId: string | null): Promise<{ quarantineRemoved: boolean }>;
  memberExists(memberId: string): Promise<boolean>;
  sendPanel(channelId: string, panel: PanelMessage): Promise<string>;
}

export class DiscordVerificationGateway implements VerificationGateway {
  constructor(private readonly guild: Guild, private readonly botId: string) {}
  private async memberOrNull(userId: string) {
    try { return await this.guild.members.fetch(userId); }
    catch (error) { if (unknownDiscordObject(error, 10007) || unknownDiscordObject(error, 10013)) return null; throw error; }
  }
  /** Role safety: exists, not a managed integration role, and manageable by the bot. */
  async assertRoleUsable(roleId: string) {
    const role = await this.guild.roles.fetch(roleId).catch(error => {
      if (unknownDiscordObject(error, 10011)) return null;
      throw error;
    });
    if (!role) throw new AppError('NOT_FOUND', 'A configured verification role no longer exists. Ask staff to reconfigure it.');
    if (role.managed) throw new AppError('VALIDATION', 'Managed or integration roles cannot be used for verification.');
    const bot = await this.guild.members.fetchMe();
    if (!bot.permissions.has(PermissionFlagsBits.ManageRoles))
      throw new AppError('PERMISSION', 'The bot lacks the Manage Roles permission for verification.');
    if (bot.roles.highest.comparePositionTo(role) <= 0)
      throw new AppError('PERMISSION', 'The bot role must be higher than the configured verification role.');
    return { id: role.id, name: role.name };
  }
  private async requireMember(userId: string, action: string): Promise<GuildMember> {
    const member = await this.memberOrNull(userId);
    if (!member) throw new AppError('NOT_FOUND', `The member is no longer available for ${action}.`);
    return member;
  }
  async memberExists(userId: string) {
    return (await this.memberOrNull(userId)) !== null;
  }
  async applyQuarantine(memberId: string, roleId: string) {
    const member = await this.requireMember(memberId, 'quarantine');
    if (member.roles.cache.has(roleId)) return;
    await member.roles.add(roleId, 'Eiren verification quarantine');
  }
  async removeVerifiedRole(memberId: string, roleId: string) {
    const member = await this.requireMember(memberId, 'emergency review');
    if (member.roles.cache.has(roleId))
      await member.roles.remove(roleId, 'Eiren emergency review');
  }
  async completeVerification(memberId: string, verifiedRoleId: string, quarantineRoleId: string | null) {
    const member = await this.requireMember(memberId, 'verification');
    if (!member.roles.cache.has(verifiedRoleId)) {
      await member.roles.add(verifiedRoleId, 'Eiren verification completed');
    }
    let quarantineRemoved = true;
    if (quarantineRoleId && member.roles.cache.has(quarantineRoleId)) {
      try { await member.roles.remove(quarantineRoleId, 'Eiren verification completed'); }
      catch { quarantineRemoved = false; }
    }
    return { quarantineRemoved };
  }
  async sendPanel(channelId: string, panel: PanelMessage) {
    const channel = await this.guild.channels.fetch(channelId).catch(error => {
      if (unknownDiscordObject(error, 10003)) return null;
      throw error;
    });
    if (!channel || !channel.isTextBased() || !('send' in channel) || typeof channel.send !== 'function')
      throw new AppError('VALIDATION', 'The configured verification channel is missing or not sendable.');
    const message = await channel.send({ ...panel, allowedMentions: { parse: [] } });
    return message.id;
  }
}
