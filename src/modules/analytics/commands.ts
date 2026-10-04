import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { boundedEmbed, presentationColor, safeMentions } from '../../core/presentation/index.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';
import type { Actor } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';
import type { AnalyticsRange } from './repository.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id, guildOwnerId: interaction.guild.ownerId,
    roleIds: [...member.roles.cache.keys()] };
}
export const analyticsCommands: Command[] = [{
  data: new SlashCommandBuilder().setName('analytics').setDescription('Guild analytics and retention')
    .addSubcommand(s => s.setName('status').setDescription('Show module status'))
    .addSubcommand(s => s.setName('enable').setDescription('Enable analytics'))
    .addSubcommand(s => s.setName('disable').setDescription('Disable analytics'))
    .addSubcommand(s => s.setName('config').setDescription('Set analytics retention')
      .addIntegerOption(o => o.setName('retention_days').setDescription('30–730 days').setMinValue(30).setMaxValue(730).setRequired(true)))
    .addSubcommand(s => s.setName('summary').setDescription('Show bounded server metrics')
      .addStringOption(o => o.setName('range').setDescription('Time period').setRequired(true)
        .addChoices({ name: '24 hours', value: '24h' }, { name: '7 days', value: '7d' }, { name: '30 days', value: '30d' }, { name: '90 days', value: '90d' }))
      .addStringOption(o => o.setName('timezone').setDescription('IANA timezone for display (UTC default)'))),
  moduleKey: 'core', requiredLevel: interaction => ['enable', 'disable', 'config'].includes(interaction.options.getSubcommand()) ? 'ADMIN' : 'HELPER',
  async execute(interaction, services: Services) {
    const actor = await actorFor(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'summary') {
      if (!(await services.analytics.status(actor)).enabled) {
        await interaction.editReply({ content: 'Analytics is disabled. Historical aggregates may remain until retention cleanup.', allowedMentions: safeMentions });
        return;
      }
      const result = await services.analytics.summaryFor(actor, interaction.options.getString('range', true) as AnalyticsRange,
        interaction.options.getString('timezone') ?? 'UTC');
      const { messages, joins, leaves, net, voiceSeconds } = result.totals;
      await interaction.editReply({ embeds: [boundedEmbed({ title: `Analytics · ${result.range}`, color: presentationColor('INFO'),
        description: `Timezone label: ${result.timezone}\n${messages} messages · ${joins} joins · ${leaves} leaves (net ${net}) · ${voiceSeconds}s voice.`,
        fields: [
          { name: 'Top channels', value: result.channels.map(x => `${x.channelId}: ${x.messages}`).join(', ') || 'none' },
          { name: 'Top commands', value: result.commands.map(x => `${x.commandName}: ${x.invocations}`).join(', ') || 'none' },
          { name: 'Business', value: JSON.stringify(result.business) },
        ],
      })], allowedMentions: safeMentions });
      return;
    }
    const status = sub === 'enable' || sub === 'disable' ? await services.analytics.setEnabled(actor, sub === 'enable')
      : sub === 'config' ? await services.analytics.configure(actor, interaction.options.getInteger('retention_days', true))
        : await services.analytics.status(actor);
    await interaction.editReply({ content: `Analytics ${status.enabled ? 'enabled' : 'disabled'}; retention ${status.retentionDays} days.`, allowedMentions: safeMentions });
  },
}];
