import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, type Guild } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { CommunityEvent } from './repository.js';
import { boundedEmbed, discordTimestamp, presentationColor, safeMentions } from '../../core/presentation/index.js';

export const eventTimestamp = (date: Date) => discordTimestamp(date);
export function eventPost(row: CommunityEvent, participants: number) {
  const embed = new EmbedBuilder(boundedEmbed({
    title: row.title, description: row.description || 'Community event',
    color: presentationColor(row.status === 'CANCELLED' ? 'DISABLED' : row.status === 'COMPLETED' ? 'SUCCESS' : 'INFO'),
    fields: [{ name: 'Event', value: `#${row.id} · ${row.status}` },
      { name: 'Starts', value: eventTimestamp(row.startAt) },
      { name: 'Organizer', value: `<@${row.creatorId}>` },
      { name: 'Attendees', value: `${participants}${row.maxParticipants ? ` / ${row.maxParticipants}` : ''}` },
      ...(row.endAt ? [{ name: 'Ends', value: eventTimestamp(row.endAt) }] : [])],
  }));
  const components = row.status === 'SCHEDULED' ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`event:join:${row.id}`).setLabel('Join').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`event:leave:${row.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary))] : [];
  return { embeds: [embed], components, allowedMentions: safeMentions };
}
export interface EventGateway {
  validateChannel(channelId: string): Promise<void>;
  post(channelId: string, event: CommunityEvent, participants: number): Promise<string>;
  update(channelId: string, messageId: string, event: CommunityEvent, participants: number): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
  remind(channelId: string, event: CommunityEvent, offsetSeconds: number): Promise<string>;
  isMissing(error: unknown): boolean;
}
export class DiscordEventGateway implements EventGateway {
  constructor(private readonly guild: Guild) {}
  private async channel(id: string) {
    const channel = await this.guild.channels.fetch(id);
    if (!channel || !channel.isTextBased() || !('send' in channel) || !('messages' in channel)) throw new AppError('VALIDATION', 'Event channel is not available.');
    return channel;
  }
  async validateChannel(channelId: string) {
    const channel = await this.channel(channelId);
    if (!('permissionsFor' in channel) || typeof channel.permissionsFor !== 'function') throw new AppError('VALIDATION', 'Cannot post in this channel.');
    const bot = await this.guild.members.fetchMe();
    if (!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
      throw new AppError('PERMISSION', 'Bot needs View Channel, Send Messages and Embed Links permissions.');
  }
  isMissing(error: unknown) { return !!error && typeof error === 'object' && 'code' in error && error.code === 10008; }
  async post(channelId: string, event: CommunityEvent, participants: number) { return (await (await this.channel(channelId)).send(eventPost(event, participants))).id; }
  async update(channelId: string, messageId: string, event: CommunityEvent, participants: number) { await (await this.channel(channelId)).messages.edit(messageId, eventPost(event, participants)); }
  async remove(channelId: string, messageId: string) { await (await this.channel(channelId)).messages.delete(messageId); }
  async remind(channelId: string, event: CommunityEvent, offsetSeconds: number) {
    const label = offsetSeconds === 86400 ? '24 hours' : offsetSeconds === 3600 ? '1 hour' : '10 minutes';
    return (await (await this.channel(channelId)).send({ content: `Event #${event.id} (${event.title.slice(0, 256)}) starts in ${label}: ${eventTimestamp(event.startAt)}`,
      allowedMentions: safeMentions })).id;
  }
}
