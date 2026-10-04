import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, DiscordAPIError, type Client, type TextChannel } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { Giveaway } from './repository.js';
import type { GiveawayGateway } from './service.js';

import { discordTimestamp, safeMentions } from '../../core/presentation/index.js';

const noMentions = safeMentions;
function buttons(row: Giveaway) { return [new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(`giveaway:enter:${row.id}`).setLabel('Enter').setStyle(ButtonStyle.Success).setDisabled(row.status !== 'ACTIVE'),
  new ButtonBuilder().setCustomId(`giveaway:leave:${row.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary).setDisabled(row.status !== 'ACTIVE'))]; }
export function giveawayContent(row: Giveaway, entries: number) {
  const requirements = [row.requiredRoleId ? `Role: <@&${row.requiredRoleId}>` : null,
    row.minAccountAgeSeconds ? `Account age: ${row.minAccountAgeSeconds}s` : null,
    row.minGuildAgeSeconds ? `Server age: ${row.minGuildAgeSeconds}s` : null,
    row.requireVerified ? 'Verified account' : null, row.minLevel ? `Level ${row.minLevel}+` : null]
    .filter(Boolean).join(' · ') || 'None';
  const content = `Giveaway #${row.id} — ${row.prize}\nCreated by: <@${row.creatorId}>\nStatus: ${row.status}` +
    `\n${row.status === 'ACTIVE' ? `Ends: ${discordTimestamp(row.endAt, 'R')}` : `Ended: ${discordTimestamp(row.endAt)}`}` +
    `\nWinners: ${row.winnerCount}\nEntries: ${entries}\nEligibility: ${requirements}`;
  if (content.length > 2000) throw new AppError('VALIDATION', 'Giveaway announcement exceeds Discord message limits.');
  return content;
}
export class DiscordGiveawayGateway implements GiveawayGateway {
  constructor(private readonly client: Client, private readonly guildId: string) {}
  private async channel(id: string): Promise<TextChannel> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const channel = await guild.channels.fetch(id);
    if (!channel || channel.type !== ChannelType.GuildText) throw new AppError('VALIDATION', 'Giveaway channel must be a server text channel.');
    return channel;
  }
  async validateChannel(id: string) { await this.channel(id); }
  async post(row: Giveaway, entries: number) { const message = await (await this.channel(row.channelId)).send({ content: giveawayContent(row, entries), components: buttons(row), allowedMentions: noMentions }); return message.id; }
  async remove(channelId: string, messageId: string) { await (await this.channel(channelId)).messages.delete(messageId); }
  isMissingMessage(error: unknown) { return error instanceof DiscordAPIError && error.code === 10008; }
  async refresh(row: Giveaway, entries: number) { if (row.messageId) await (await this.channel(row.channelId)).messages.edit(row.messageId, { content: giveawayContent(row, entries), components: buttons(row), allowedMentions: noMentions }); }
  async announce(row: Giveaway, winners: string[], drawId: number) { const message = await (await this.channel(row.channelId)).send({ content: `Giveaway #${row.id} draw #${drawId} results — ${row.prize}\n${winners.length ? winners.map(id => `<@${id}>`).join(', ') : 'No eligible winners.'}`, allowedMentions: noMentions }); return message.id; }
  async findAnnouncement(row: Giveaway, drawId: number) {
    const channel = await this.channel(row.channelId);
    const recent = await channel.messages.fetch({ limit: 100 });
    return recent.find(message => message.author.id === this.client.user?.id && message.content.startsWith(`Giveaway #${row.id} draw #${drawId} results — `))?.id ?? null;
  }
  async member(userId: string) { try { const member = await (await this.client.guilds.fetch(this.guildId)).members.fetch(userId);
    return { bot: member.user.bot, createdAt: member.user.createdAt, joinedAt: member.joinedAt, roleIds: [...member.roles.cache.keys()] };
  } catch (error) { if (error instanceof DiscordAPIError && error.code === 10007) return null; throw error; } }
}
