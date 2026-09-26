import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { Command } from '../../core/commands/command.js';
import type { Actor, PermissionLevel } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';
import { antiraidConfigFields } from './service.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id,
    guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
}
function summarize(settings: Awaited<ReturnType<Services['antiraid']['status']>>) {
  return [
    `enabled: ${settings.enabled}`,
    `emergency_mode: ${settings.emergencyMode}${settings.emergencyReason ? ` (${settings.emergencyReason})` : ''}`,
    `join_window_seconds: ${settings.joinWindowSeconds}`,
    `join_threshold: ${settings.joinThreshold}`,
    `young_account_age_seconds: ${settings.youngAccountAgeSeconds}`,
    `young_account_weight: ${settings.youngAccountWeight}`,
    `auto_quarantine: ${settings.autoQuarantine}`,
    `alert_channel: ${settings.alertChannelId ?? 'not set'}`,
    `message_spam_threshold: ${settings.messageSpamThreshold} in ${settings.messageSpamWindowSeconds}s`,
    `mention_threshold: ${settings.mentionThreshold}`,
  ].join('\n');
}

const data = new SlashCommandBuilder().setName('antiraid').setDescription('Anti-raid protection and emergency mode')
  .addSubcommand(sub => sub.setName('status').setDescription('Show anti-raid protection status'))
  .addSubcommand(sub => sub.setName('enable').setDescription('Enable anti-raid protection'))
  .addSubcommand(sub => sub.setName('disable').setDescription('Disable anti-raid protection'))
  .addSubcommand(sub => sub.setName('config').setDescription('Show or update anti-raid settings')
    .addStringOption(option => option.setName('field').setDescription('Setting to change').setRequired(false)
      .addChoices(...antiraidConfigFields.map(field => ({ name: field, value: field }))))
    .addStringOption(option => option.setName('value').setDescription('New value; clear for alert_channel').setRequired(false)))
  .addSubcommand(sub => sub.setName('emergency').setDescription('Enable or disable emergency mode')
    .addStringOption(option => option.setName('action').setDescription('Emergency action').setRequired(true)
      .addChoices({ name: 'Enable', value: 'enable' }, { name: 'Disable', value: 'disable' }))
    .addStringOption(option => option.setName('reason').setDescription('Reason recorded in the audit log').setRequired(false)));

export const antiraidCommand: Command = {
  data,
  moduleKey: 'antiraid',
  requiredLevel: interaction => {
    const sub = interaction.options.getSubcommand();
    if (sub === 'emergency') return 'SENIOR_MODERATOR';
    if (sub === 'status') return 'MODERATOR';
    return 'ADMIN';
  },
  async execute(interaction, services: Services) {
    const actor = await actorFor(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      const settings = await services.antiraid.status(actor);
      await interaction.editReply({ content: summarize(settings) });
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const settings = await services.antiraid.setEnabled(actor, sub === 'enable');
      await interaction.editReply({ content: `Anti-raid ${settings.enabled ? 'enabled' : 'disabled'}.` });
      return;
    }
    if (sub === 'config') {
      const field = interaction.options.getString('field');
      const value = interaction.options.getString('value');
      if (!field) {
        const settings = await services.antiraid.status(actor);
        await interaction.editReply({ content: summarize(settings) });
        return;
      }
      if (value === null) throw new AppError('VALIDATION', 'Provide a value when changing a setting.');
      const settings = await services.antiraid.configure(actor, field, value);
      await interaction.editReply({ content: `Anti-raid setting updated.\n${summarize(settings)}` });
      return;
    }
    const enabled = interaction.options.getString('action', true) === 'enable';
    const reason = interaction.options.getString('reason') ?? undefined;
    const settings = await services.antiraid.emergency(actor, enabled, reason);
    await interaction.editReply({ content: `Emergency mode ${settings.emergencyMode ? 'enabled' : 'disabled'}${settings.emergencyReason ? ` (${settings.emergencyReason})` : ''}. New joins ${settings.emergencyMode ? 'now require manual verification review.' : 'return to normal handling.'}` });
  },
};
export const antiraidCommands = [antiraidCommand];
