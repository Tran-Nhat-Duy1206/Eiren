import { ChannelType, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import type { Actor } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';
import { AppError } from '../../core/errors/errors.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id, guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
}
export const giveawayCommands: Command[] = [{
  data: new SlashCommandBuilder().setName('giveaway').setDescription('Create and manage giveaways')
    .addSubcommand(s => s.setName('create').setDescription('Start a giveaway')
      .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(256))
      .addIntegerOption(o => o.setName('duration_minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(525600))
      .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(20))
      .addChannelOption(o => o.setName('channel').setDescription('Announcement channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addRoleOption(o => o.setName('role').setDescription('Required role'))
      .addIntegerOption(o => o.setName('account_age_days').setDescription('Minimum account age in days').setMinValue(0).setMaxValue(365))
      .addIntegerOption(o => o.setName('guild_age_days').setDescription('Minimum server membership in days').setMinValue(0).setMaxValue(365))
      .addBooleanOption(o => o.setName('verified').setDescription('Require verified membership'))
      .addIntegerOption(o => o.setName('level').setDescription('Minimum level').setMinValue(0).setMaxValue(10000)))
    .addSubcommand(s => s.setName('view').setDescription('View a giveaway').addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('end').setDescription('End and draw now').addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('reroll').setDescription('Draw new winners').addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('cancel').setDescription('Cancel a giveaway').addIntegerOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true).setMinValue(1))),
  moduleKey: 'giveaways', requiredLevel: interaction => interaction.options.getSubcommand() === 'view' ? 'MEMBER' : 'MODERATOR',
  async execute(interaction, services: Services) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') {
      const input = { channelId: interaction.options.getChannel('channel', true).id, prize: interaction.options.getString('prize', true),
        endAt: new Date(Date.now() + interaction.options.getInteger('duration_minutes', true) * 60000),
        winnerCount: interaction.options.getInteger('winners', true), requiredRoleId: interaction.options.getRole('role')?.id,
        minAccountAgeSeconds: (interaction.options.getInteger('account_age_days') ?? 0) * 86400,
        minGuildAgeSeconds: (interaction.options.getInteger('guild_age_days') ?? 0) * 86400,
        requireVerified: interaction.options.getBoolean('verified') ?? false, minLevel: interaction.options.getInteger('level') ?? 0 };
      const result = await services.giveaways.create(await actorFor(interaction), input);
      await interaction.editReply({ content: `Giveaway #${result.row.id} ${result.posted ? 'posted.' : 'saved; announcement pending reconciliation.'}`, allowedMentions: { parse: [] } });
      return;
    }
    const id = interaction.options.getInteger('id', true);
    if (sub === 'view') {
      const { row, entries, draws } = await services.giveaways.view(interaction.guildId!, id);
      await interaction.editReply({ content: `Giveaway #${id} (${row.status}) — ${row.prize}\nEntries: ${entries} · Draws: ${draws.length}`, allowedMentions: { parse: [] } });
      return;
    }
    if (sub === 'cancel') { await services.giveaways.cancel(await actorFor(interaction), id);
      await interaction.editReply({ content: `Giveaway #${id} cancelled.`, allowedMentions: { parse: [] } }); return; }
    const result = sub === 'end' ? await services.giveaways.end(await actorFor(interaction), id) : await services.giveaways.reroll(await actorFor(interaction), id);
    await interaction.editReply({ content: result.state === 'DRAWN' ? `Giveaway #${id}: ${result.winners.length} winner(s) drawn.` : `Giveaway #${id}: ${result.state}.`, allowedMentions: { parse: [] } });
  },
}];
