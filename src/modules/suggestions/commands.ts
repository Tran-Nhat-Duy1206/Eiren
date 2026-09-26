import { ChannelType, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';
import type { Actor } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';
import { statuses } from './repository.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id,
    guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
}
const suggest: Command = {
  data: new SlashCommandBuilder().setName('suggest').setDescription('Submit a suggestion')
    .addStringOption(option => option.setName('content').setDescription('Your suggestion').setRequired(true).setMaxLength(2000)),
  moduleKey: 'suggestions', requiredLevel: 'MEMBER',
  async execute(interaction, services: Services) {
    const { row, posted } = await services.suggestions.create(interaction.guildId!, interaction.user.id, interaction.options.getString('content', true));
    await interaction.editReply({ content: posted ? `Suggestion #${row.id} posted.` :
      `Suggestion #${row.id} saved, but the post is pending staff reconciliation.`, allowedMentions: { parse: [] } });
  },
};
const suggestion: Command = {
  data: new SlashCommandBuilder().setName('suggestion').setDescription('Review and configure suggestions')
    .addSubcommand(sub => sub.setName('view').setDescription('View a suggestion')
      .addIntegerOption(o => o.setName('id').setDescription('Suggestion ID').setRequired(true).setMinValue(1)))
    .addSubcommand(sub => sub.setName('status').setDescription('Set suggestion status')
      .addIntegerOption(o => o.setName('id').setDescription('Suggestion ID').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('status').setDescription('New status').setRequired(true)
        .addChoices(...statuses.map(value => ({ name: value, value })))))
    .addSubcommand(sub => sub.setName('respond').setDescription('Add a staff response')
      .addIntegerOption(o => o.setName('id').setDescription('Suggestion ID').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('response').setDescription('Staff response').setRequired(true).setMaxLength(1000)))
    .addSubcommand(sub => sub.setName('config').setDescription('Configure the suggestion channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel (omit to view configuration)').addChannelTypes(ChannelType.GuildText))),
  moduleKey: 'suggestions',
  requiredLevel: interaction => interaction.options.getSubcommand() === 'view' ? 'MEMBER' :
    interaction.options.getSubcommand() === 'config' ? 'ADMIN' : 'MODERATOR',
  async execute(interaction, services: Services) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'view') {
      const { row, counts } = await services.suggestions.view(interaction.guildId!, interaction.options.getInteger('id', true));
      const summary = `#${row.id} (${row.status}) — ${row.content}\n👍 ${counts.up} · 👎 ${counts.down}${row.staffResponse ? `\nStaff: ${row.staffResponse}` : ''}`;
      await interaction.editReply({ content: summary.length > 2000 ? `${summary.slice(0, 1997)}...` : summary,
        allowedMentions: { parse: [] } });
    } else if (sub === 'config') {
      const actor = await actorFor(interaction);
      const channel = interaction.options.getChannel('channel');
      const settings = channel ? await services.suggestions.configure(actor, channel.id) : await services.suggestions.settings(actor);
      await interaction.editReply({ content: `Suggestion channel: ${settings?.channelId ? `<#${settings.channelId}>` : 'not configured'}.` });
    } else {
      const actor = await actorFor(interaction);
      const id = interaction.options.getInteger('id', true);
      const row = sub === 'status'
        ? await services.suggestions.status(actor, id, interaction.options.getString('status', true))
        : await services.suggestions.respond(actor, id, interaction.options.getString('response', true));
      await interaction.editReply({ content: `Suggestion #${row.id} updated (${row.status}).` });
    }
  },
};
export const suggestionCommands: Command[] = [suggest, suggestion];
