import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import { parseDuration } from '../../core/time/duration.js';
import type { Command } from '../../core/commands/command.js';
import type { Actor, PermissionLevel } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id,
    guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
}
function formatAge(seconds: number | null) {
  if (seconds === null) return 'not required';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.ceil(seconds / 60)}m`;
}
function parseAccountAge(value: string): number | null {
  const input = value.trim().toLowerCase();
  if (['none', 'off', 'clear', '0'].includes(input)) return null;
  return parseDuration(input);
}

const data = new SlashCommandBuilder().setName('verification').setDescription('Member verification configuration and review')
  .addSubcommand(sub => sub.setName('status').setDescription('Show verification configuration, or one member state')
    .addUserOption(option => option.setName('target').setDescription('Inspect one member').setRequired(false)))
  .addSubcommand(sub => sub.setName('enable').setDescription('Enable member verification'))
  .addSubcommand(sub => sub.setName('disable').setDescription('Disable member verification'))
  .addSubcommand(sub => sub.setName('mode').setDescription('Set how members verify')
    .addStringOption(option => option.setName('mode').setDescription('Verification mode').setRequired(true)
      .addChoices(
        { name: 'Button', value: 'BUTTON' },
        { name: 'Manual staff approval', value: 'MANUAL' },
        { name: 'Button with minimum account age', value: 'BUTTON_AND_ACCOUNT_AGE' })))
  .addSubcommand(sub => sub.setName('channel').setDescription('Set the verification channel')
    .addChannelOption(option => option.setName('channel').setDescription('Verification channel').setRequired(true)))
  .addSubcommand(sub => sub.setName('verified-role').setDescription('Set the role granted after verification')
    .addRoleOption(option => option.setName('role').setDescription('Verified role').setRequired(true)))
  .addSubcommand(sub => sub.setName('quarantine-role').setDescription('Set the role applied to new members')
    .addRoleOption(option => option.setName('role').setDescription('Quarantine role').setRequired(true)))
  .addSubcommand(sub => sub.setName('min-account-age').setDescription('Set the minimum account age for automatic verification')
    .addStringOption(option => option.setName('value').setDescription('e.g. 7d, 12h, or none').setRequired(true)))
  .addSubcommand(sub => sub.setName('rules-ack').setDescription('Require acknowledging the rules before verifying')
    .addBooleanOption(option => option.setName('enabled').setDescription('Require rule acknowledgement').setRequired(true)))
  .addSubcommand(sub => sub.setName('panel').setDescription('Post a fresh verification panel in the configured channel'))
  .addSubcommand(sub => sub.setName('approve').setDescription('Manually approve a pending member')
    .addUserOption(option => option.setName('member').setDescription('Member to approve').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('Optional approval note').setRequired(false)))
  .addSubcommand(sub => sub.setName('reject').setDescription('Reject a pending member (no ban or kick)')
    .addUserOption(option => option.setName('member').setDescription('Member to reject').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('Reason for the member record').setRequired(true)));

export const verificationCommand: Command = {
  data,
  moduleKey: 'verification',
  requiredLevel: interaction => {
    const sub = interaction.options.getSubcommand();
    if (sub === 'approve' || sub === 'reject') return 'MODERATOR';
    if (sub === 'status') return interaction.options.getUser('target') ? 'MODERATOR' : 'ADMIN';
    return 'ADMIN';
  },
  async execute(interaction, services: Services) {
    const actor = await actorFor(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      const target = interaction.options.getUser('target');
      if (target) {
        const { settings, member } = await services.verification.memberStatus(actor, target.id);
        await interaction.editReply({ content: member
          ? `Member ${target.id}: ${member.status}${member.method ? ` (${member.method})` : ''}; account age gate: ${formatAge(settings.minAccountAgeSeconds)}${member.reason ? `\nReason: ${member.reason}` : ''}`
          : `Member ${target.id}: no verification record. Enabled: ${settings.enabled}; mode: ${settings.mode}.` });
        return;
      }
      const settings = await services.verification.settings(actor);
      await interaction.editReply({ content: [
        `enabled: ${settings.enabled}`,
        `mode: ${settings.mode}`,
        `verification_channel: ${settings.verificationChannelId ?? 'not set'}`,
        `verified_role: ${settings.verifiedRoleId ?? 'not set'}`,
        `quarantine_role: ${settings.quarantineRoleId ?? 'not set'}`,
        `min_account_age: ${formatAge(settings.minAccountAgeSeconds)}`,
        `rules_ack: ${settings.requireRulesAck}`,
        `panel_message: ${settings.panelMessageId ?? 'not posted'}`,
      ].join('\n') });
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const settings = await services.verification.setEnabled(actor, sub === 'enable');
      await interaction.editReply({ content: `Verification ${settings.enabled ? 'enabled' : 'disabled'}.` });
      return;
    }
    if (sub === 'mode') {
      const settings = await services.verification.setMode(actor, interaction.options.getString('mode', true));
      await interaction.editReply({ content: `Verification mode set to ${settings.mode}.` });
      return;
    }
    if (sub === 'channel') {
      const channel = interaction.options.getChannel('channel', true);
      const settings = await services.verification.setChannel(actor, channel.id);
      await interaction.editReply({ content: `Verification channel set to <#${settings.verificationChannelId}>.` });
      return;
    }
    if (sub === 'verified-role' || sub === 'quarantine-role') {
      const role = interaction.options.getRole('role', true);
      const settings = await services.verification.setRole(actor, sub === 'verified-role' ? 'verified' : 'quarantine', role.id);
      await interaction.editReply({ content: `${sub === 'verified-role' ? 'Verified' : 'Quarantine'} role set to <@&${sub === 'verified-role' ? settings.verifiedRoleId : settings.quarantineRoleId}>.` });
      return;
    }
    if (sub === 'min-account-age') {
      const seconds = parseAccountAge(interaction.options.getString('value', true));
      const settings = await services.verification.setMinAccountAge(actor, seconds);
      await interaction.editReply({ content: `Minimum account age: ${formatAge(settings.minAccountAgeSeconds)}.` });
      return;
    }
    if (sub === 'rules-ack') {
      const settings = await services.verification.setRulesAck(actor, interaction.options.getBoolean('enabled', true));
      await interaction.editReply({ content: `Rules acknowledgement required: ${settings.requireRulesAck}.` });
      return;
    }
    if (sub === 'panel') {
      const { messageId, channelId } = await services.verification.publishPanel(actor);
      await interaction.editReply({ content: `Verification panel posted in <#${channelId}> (message ${messageId}).` });
      return;
    }
    if (sub === 'approve') {
      const member = interaction.options.getUser('member', true);
      const reason = interaction.options.getString('reason') ?? undefined;
      const result = await services.verification.approve(actor, member.id, reason);
      await interaction.editReply({ content: result.alreadyVerified
        ? `Member ${member.id} is already verified.`
        : `Member ${member.id} approved and verified.` });
      return;
    }
    if (sub === 'reject') {
      const member = interaction.options.getUser('member', true);
      const reason = interaction.options.getString('reason', true);
      await services.verification.reject(actor, member.id, reason);
      await interaction.editReply({ content: `Member ${member.id} rejected. They remain restricted; no ban was applied.` });
    }
  },
};
export const verificationCommands = [verificationCommand];
