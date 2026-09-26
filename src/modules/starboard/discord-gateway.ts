import { ChannelType, DiscordAPIError, EmbedBuilder, PermissionFlagsBits, type Guild, type Message, type MessageReaction } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';

export type StarSource = { guildId: string; channelId: string; messageId: string; authorId: string; createdAt: Date; content?: string; nsfw: boolean; public: boolean; bot?: boolean };
export interface StarboardGateway {
  validateChannel(channelId: string): Promise<void>;
  source(channelId: string, messageId: string): Promise<StarSource | null>;
  count(channelId: string, messageId: string, emoji: string, allowSelf: boolean, authorId: string): Promise<number>;
  post(channelId: string, source: StarSource, count: number, emoji: string): Promise<string>;
  update(channelId: string, messageId: string, source: StarSource, count: number, emoji: string): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
  isNsfw(channelId: string): Promise<boolean>;
}

export function starboardPost(source: StarSource, count: number, emoji: string) {
  const embed = new EmbedBuilder().setTitle(`${emoji} ${count} · #${source.channelId}`)
    .setDescription(`[Jump to message](https://discord.com/channels/${source.guildId}/${source.channelId}/${source.messageId})`)
    .addFields({ name: 'Author', value: `<@${source.authorId}>` }, { name: 'Channel', value: `<#${source.channelId}>` })
    .setTimestamp(source.createdAt);
  if (source.content) embed.addFields({ name: 'Message', value: source.content.slice(0, 1024) });
  return { embeds: [embed], allowedMentions: { parse: [] as [] } };
}
export class DiscordStarboardGateway implements StarboardGateway {
  constructor(private readonly guild: Guild) {}
  private async channel(id: string) {
    const channel = await this.guild.channels.fetch(id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) throw new AppError('VALIDATION', 'Channel is unavailable or not a server text channel.');
    return channel;
  }
  async validateChannel(id: string) {
    const channel = await this.channel(id);
    const bot = await this.guild.members.fetchMe();
    if (!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]))
      throw new AppError('PERMISSION', 'Bot requires View Channel, Send Messages, Embed Links and Read Message History.');
  }
  async isNsfw(id: string) { return (await this.channel(id)).nsfw; }
  async source(channelId: string, messageId: string): Promise<StarSource | null> {
    const channel = await this.guild.channels.fetch(channelId).catch(error => {
      if (error instanceof DiscordAPIError && [10003, 50001, 50013].includes(Number(error.code))) return null;
      throw error;
    });
    if (!channel || channel.type !== ChannelType.GuildText || !channel.permissionsFor(this.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) return null;
    const message = await channel.messages.fetch({ message: messageId, force: true }).catch(error => {
      if (error instanceof DiscordAPIError && [10008, 50001, 50013].includes(Number(error.code))) return null;
      throw error;
    });
    if (!message || !message.author) return null;
    return { guildId: this.guild.id, channelId, messageId, authorId: message.author.id, createdAt: message.createdAt,
      content: message.content || undefined, nsfw: channel.nsfw, public: true, bot: message.author.bot };
  }
  async count(channelId: string, messageId: string, emoji: string, allowSelf: boolean, authorId: string): Promise<number> {
    const channel = await this.channel(channelId);
    const message: Message = await channel.messages.fetch({ message: messageId, force: true });
    const reaction: MessageReaction | undefined = message.reactions.cache.find(value => value.emoji.id === emoji || value.emoji.toString() === emoji || value.emoji.name === emoji);
    if (!reaction) return 0;
    const ids = new Set<string>();
    let after: string | undefined;
    while (true) {
      const page = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
      for (const user of page.values()) if (!user.bot && (allowSelf || user.id !== authorId)) ids.add(user.id);
      if (page.size < 100) break;
      after = page.last()?.id;
      if (!after) break;
    }
    return ids.size;
  }
  async post(channelId: string, source: StarSource, count: number, emoji: string) {
    return (await (await this.channel(channelId)).send(starboardPost(source, count, emoji))).id;
  }
  async update(channelId: string, messageId: string, source: StarSource, count: number, emoji: string) {
    await (await this.channel(channelId)).messages.edit(messageId, starboardPost(source, count, emoji));
  }
  async remove(channelId: string, messageId: string) {
    // A destination channel deleted by a guild admin has no post left to remove.
    const channel = await this.guild.channels.fetch(channelId).catch(error => {
      if (error instanceof DiscordAPIError && Number(error.code) === 10003) return null;
      throw error;
    });
    if (!channel) return;
    if (channel.type !== ChannelType.GuildText) throw new AppError('VALIDATION', 'Starboard destination is no longer a text channel.');
    try { await channel.messages.delete(messageId); }
    catch (error) {
      if (error instanceof DiscordAPIError && Number(error.code) === 10008) return; // Already deleted.
      throw error;
    }
  }
}
