import { ChannelType, DiscordAPIError, PermissionFlagsBits, type Guild, type TextChannel } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';

export interface TicketGateway {
  create(categoryId: string, staffRoleId: string, creatorId: string, id: number, type: string): Promise<string>;
  delete(channelId: string): Promise<void>;
  setParticipant(channelId: string, userId: string, allow: boolean): Promise<void>;
  transcript(channelId: string): Promise<string>;
  memberExists(userId: string): Promise<boolean>;
  botId(): string | undefined;
  memberRoleIds(userId: string): Promise<string[]>;
  assertConfiguration(categoryId: string, staffRoleId: string): Promise<void>;
}
export class DiscordTicketGateway implements TicketGateway {
  constructor(private readonly guild: Guild) {}
  botId() { return this.guild.client.user?.id; }
  async memberRoleIds(userId: string) { return [...(await this.guild.members.fetch(userId)).roles.cache.keys()]; }
  async assertConfiguration(categoryId: string, staffRoleId: string) {
    const category = await this.guild.channels.fetch(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== this.guild.id)
      throw new AppError('VALIDATION', 'Configure a valid ticket category in this server.');
    const staffRole = staffRoleId === this.guild.id ? null : await this.guild.roles.fetch(staffRoleId);
    if (!staffRole || staffRole.permissions.has(PermissionFlagsBits.Administrator))
      throw new AppError('VALIDATION', 'Configure a dedicated ticket staff role without Administrator, not @everyone.');
    const bot = await this.guild.members.fetchMe();
    if (!bot.permissions.has(PermissionFlagsBits.ManageChannels) || !bot.permissions.has(PermissionFlagsBits.ViewChannel) || !bot.permissions.has(PermissionFlagsBits.ManageRoles))
      throw new AppError('PERMISSION', 'Bot requires Manage Channels, Manage Roles and View Channel.');
  }
  async memberExists(userId: string) {
    try { return Boolean(await this.guild.members.fetch(userId)); } catch { return false; }
  }
  async create(categoryId: string, staffRoleId: string, creatorId: string, id: number, type: string) {
    await this.assertConfiguration(categoryId, staffRoleId);
    if (!await this.memberExists(creatorId)) throw new AppError('NOT_FOUND', 'Creator is no longer in this server.');
    const botId = this.guild.client.user?.id;
    if (!botId) throw new AppError('VALIDATION', 'Bot identity unavailable.');
    const allow = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory;
    const channel = await this.guild.channels.create({ name: `ticket-${id}-${type.toLowerCase().replace(/_/g, '-')}`.slice(0, 100), type: ChannelType.GuildText, parent: categoryId,
      permissionOverwrites: [
        { id: this.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: creatorId, allow }, { id: staffRoleId, allow }, { id: botId, allow },
      ], reason: `Eiren ticket #${id}` });
    // Never use lockPermissions: inherited category overwrites could expose the ticket.
    try {
      await channel.send({ content: `Ticket #${id} · ${type}\nOpened by <@${creatorId}>. Staff may use /ticket claim, /ticket add, /ticket remove, /ticket transfer and /ticket close. The creator may close their own ticket.`, allowedMentions: { parse: [] } });
    } catch (error) {
      try { await channel.delete('Ticket header could not be created'); }
      catch { throw new AppError('CONFLICT', `Ticket #${id} header failed and channel ${channel.id} requires manual cleanup.`); }
      throw error;
    }
    return channel.id;
  }
  private async channel(id: string): Promise<TextChannel> {
    const channel = await this.guild.channels.fetch(id);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== this.guild.id)
      throw new AppError('NOT_FOUND', 'Ticket channel is unavailable.');
    return channel;
  }
  async delete(id: string) {
    try { await (await this.channel(id)).delete('Eiren ticket closed'); }
    catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return;
      if (error instanceof DiscordAPIError && error.code === 10003) return;
      throw error;
    }
  }
  async setParticipant(id: string, userId: string, allow: boolean) {
    const channel = await this.channel(id);
    if (allow) {
      if (!await this.memberExists(userId)) throw new AppError('NOT_FOUND', 'Member not found.');
      await channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    } else await channel.permissionOverwrites.delete(userId);
  }
  async transcript(id: string) {
    const channel = await this.channel(id);
    const messages: Array<{ id: string; createdTimestamp: number; author: { id: string; username: string }; content: string; attachments: { values(): IterableIterator<{ url: string }> } }> = [];
    let before: string | undefined;
    while (true) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      for (const message of batch.values()) messages.push(message);
      before = batch.last()!.id;
      if (batch.size < 100) break;
    }
    messages.reverse();
    return [`Ticket channel ${id} | ${new Date().toISOString()} | ${messages.length} messages`,
      ...messages.map(message => `[${new Date(message.createdTimestamp).toISOString()}] ${message.author.username} (${message.author.id}): ${message.content.replace(/\r/g, '')}${[...message.attachments.values()].map(a => `\n  attachment: ${a.url}`).join('')}`)].join('\n');
  }
}
