import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, type Guild } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { Suggestion } from './repository.js';

export function suggestionPost(row: Suggestion, counts: { up: number; down: number }) {
  const embed = new EmbedBuilder().setTitle(`Suggestion #${row.id}`).setDescription(row.content)
    .addFields({ name: 'Status', value: row.status }, { name: 'Votes', value: `👍 ${counts.up} · 👎 ${counts.down}` });
  if (row.staffResponse) embed.addFields({ name: 'Staff response', value: row.staffResponse });
  const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`suggest:up:${row.id}`).setStyle(ButtonStyle.Success).setLabel('Upvote'),
    new ButtonBuilder().setCustomId(`suggest:down:${row.id}`).setStyle(ButtonStyle.Danger).setLabel('Downvote'))];
  return { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
}
export interface SuggestionGateway {
  validateChannel(channelId: string): Promise<void>;
  post(channelId: string, row: Suggestion, counts: { up: number; down: number }): Promise<string>;
  remove(channelId: string, messageId: string): Promise<void>;
  update(channelId: string, messageId: string, row: Suggestion, counts: { up: number; down: number }): Promise<void>;
}
export class DiscordSuggestionGateway implements SuggestionGateway {
  constructor(private readonly guild: Guild) {}
  private async channel(id: string) {
    const channel = await this.guild.channels.fetch(id);
    if (!channel || !channel.isTextBased() || !('send' in channel) || !('messages' in channel))
      throw new AppError('VALIDATION', 'The suggestion channel is not available for messages.');
    return channel;
  }
  async validateChannel(channelId: string) {
    const channel = await this.channel(channelId);
    if (!('permissionsFor' in channel) || typeof channel.permissionsFor !== 'function')
      throw new AppError('VALIDATION', 'The suggestion channel cannot be used for posts.');
    const bot = await this.guild.members.fetchMe();
    const permissions = channel.permissionsFor(bot);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
      throw new AppError('PERMISSION', 'The bot needs View Channel, Send Messages, and Embed Links permissions.');
  }
  async remove(channelId: string, messageId: string) {
    const channel = await this.channel(channelId);
    await channel.messages.delete(messageId);
  }
  async post(channelId: string, row: Suggestion, counts: { up: number; down: number }) {
    const channel = await this.channel(channelId);
    return (await channel.send(suggestionPost(row, counts))).id;
  }
  async update(channelId: string, messageId: string, row: Suggestion, counts: { up: number; down: number }) {
    const channel = await this.channel(channelId);
    await channel.messages.edit(messageId, suggestionPost(row, counts));
  }
}
