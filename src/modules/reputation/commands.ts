import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';
import type { Actor } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id,
    guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
}
const rep: Command = {
  data: new SlashCommandBuilder().setName('rep').setDescription('Give reputation to a server member')
    .addUserOption(o => o.setName('member').setDescription('Member to thank').setRequired(true)),
  moduleKey: 'reputation', requiredLevel: 'MEMBER',
  async execute(interaction, services: Services) {
    const actor = await actorFor(interaction);
    const target = interaction.options.getUser('member', true);
    const score = await services.reputation.grant(actor, target.id, interaction.user.bot);
    await interaction.editReply({ content: `Reputation given to <@${target.id}>. Score: ${score}.`, allowedMentions: { parse: [] } });
  },
};
const reputation: Command = {
  data: new SlashCommandBuilder().setName('reputation').setDescription('Manage reputation')
    .addSubcommand(s => s.setName('status').setDescription('View reputation settings and your score'))
    .addSubcommand(s => s.setName('config').setDescription('Configure reputation cooldowns')
      .addIntegerOption(o => o.setName('global_seconds').setDescription('Seconds between any grants (60–604800)').setRequired(true).setMinValue(60).setMaxValue(604800))
      .addIntegerOption(o => o.setName('same_target_seconds').setDescription('Same-target cooldown (>= global, <= 2592000s)').setRequired(true).setMinValue(60).setMaxValue(2592000))),
  moduleKey: 'reputation', requiredLevel: 'ADMIN',
  async execute(interaction, services: Services) {
    const actor = await actorFor(interaction);
    const config = interaction.options.getSubcommand() === 'config'
      ? await services.reputation.configure(actor, { globalCooldownSeconds: interaction.options.getInteger('global_seconds', true),
        sameTargetCooldownSeconds: interaction.options.getInteger('same_target_seconds', true) })
      : await services.reputation.settings(actor);
    await interaction.editReply({ content: `Reputation cooldowns: global ${config.globalCooldownSeconds}s; same target ${config.sameTargetCooldownSeconds}s.`, allowedMentions: { parse: [] } });
  },
};
export const reputationCommands: Command[] = [rep, reputation];
