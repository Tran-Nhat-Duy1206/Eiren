import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { Command } from '../../core/commands/command.js';
import type { Actor, PermissionLevel } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';
import { DiscordModerationGateway } from './discord-gateway.js';
import type { ModerationAction } from './repository.js';

export { parseDuration } from '../../core/time/duration.js';
import { parseDuration } from '../../core/time/duration.js';

const levels: Record<string, PermissionLevel> = {
  warn: 'MODERATOR', timeout: 'MODERATOR', kick: 'MODERATOR', ban: 'SENIOR_MODERATOR',
  tempban: 'SENIOR_MODERATOR', unban: 'SENIOR_MODERATOR', purge: 'MODERATOR',
  note: 'MODERATOR', history: 'MODERATOR', case: 'MODERATOR',
};
async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id,
    guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
}
function target(interaction: ChatInputCommandInteraction) {
  return interaction.options.getUser('target', true).id;
}
const data = new SlashCommandBuilder().setName('mod').setDescription('Moderation actions and staff records')
  .addSubcommand(sub => sub.setName('warn').setDescription('Record a warning')
    .addUserOption(o => o.setName('target').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
  .addSubcommand(sub => sub.setName('timeout').setDescription('Temporarily timeout a member')
    .addUserOption(o => o.setName('target').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('30m, 2h, 1d (maximum 28d)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
  .addSubcommand(sub => sub.setName('kick').setDescription('Kick a member')
    .addUserOption(o => o.setName('target').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
  .addSubcommand(sub => sub.setName('ban').setDescription('Ban a user')
    .addUserOption(o => o.setName('target').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
  .addSubcommand(sub => sub.setName('tempban').setDescription('Ban a user until expiration')
    .addUserOption(o => o.setName('target').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('30m, 2h, 1d (maximum 365d)').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
  .addSubcommand(sub => sub.setName('unban').setDescription('Unban a user by Discord ID')
    .addStringOption(o => o.setName('user_id').setDescription('Banned user ID').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
  .addSubcommand(sub => sub.setName('purge').setDescription('Delete recent messages in this channel')
    .addIntegerOption(o => o.setName('count').setDescription('Number of recent messages (1–100)').setMinValue(1).setMaxValue(100).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
  .addSubcommand(sub => sub.setName('note').setDescription('Add or privately view staff notes')
    .addUserOption(o => o.setName('target').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('Note to add; omit to list existing notes')))
  .addSubcommand(sub => sub.setName('history').setDescription('View moderation cases for a user')
    .addUserOption(o => o.setName('target').setDescription('User').setRequired(true)))
  .addSubcommand(sub => sub.setName('case').setDescription('View a case by ID')
    .addIntegerOption(o => o.setName('id').setDescription('Case ID').setRequired(true).setMinValue(1)));

export const modCommand: Command = {
  data, moduleKey: 'moderation',
  requiredLevel: interaction => levels[interaction.options.getSubcommand()] ?? 'SENIOR_MODERATOR',
  async execute(interaction, services: Services) {
    if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
    const actor = await actorFor(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'case') {
      const record = await services.moderation.getCase(actor, interaction.options.getInteger('id', true));
      await interaction.editReply({ content: `Case #${record.id} — ${record.action} (${record.status})\nTarget: ${record.targetId}\nModerator: ${record.moderatorId}\nReason: ${record.reason}\nCreated: ${record.createdAt.toISOString()}${record.expiresAt ? `\nExpires: ${record.expiresAt.toISOString()}` : ''}` });
      return;
    }
    if (sub === 'history') {
      const records = await services.moderation.history(actor, target(interaction));
      await interaction.editReply({ content: records.length ? records.map(record => `#${record.id} ${record.action} ${record.status}: ${record.reason.slice(0, 100)}`).join('\n') : 'No cases for that user.' });
      return;
    }
    if (sub === 'note') {
      const userId = target(interaction);
      const text = interaction.options.getString('text');
      if (!text) {
        const notes = await services.moderation.notes(actor, userId);
        await interaction.editReply({ content: notes.length ? notes.map(note => `#${note.id} (${note.moderatorId}): ${note.content.slice(0, 140)}`).join('\n') : 'No staff notes for that user.' });
      } else {
        const note = await services.moderation.addNote(actor, userId, text);
        await interaction.editReply({ content: `Private staff note #${note.id} saved.` });
      }
      return;
    }
    const action = sub.toUpperCase() as ModerationAction;
    const targetId = sub === 'purge' ? actor.userId : sub === 'unban' ? interaction.options.getString('user_id', true) : target(interaction);
    const duration = sub === 'timeout' || sub === 'tempban' ? parseDuration(interaction.options.getString('duration', true)) : undefined;
    const metadata = sub === 'purge' ? { channelId: interaction.channelId, count: interaction.options.getInteger('count', true) } : undefined;
    const record = await services.moderation.perform({ actor, action, targetId, reason: interaction.options.getString('reason', true), durationSeconds: duration, metadata },
      new DiscordModerationGateway(interaction.guild, actor.userId));
    await interaction.editReply({ content: `Case #${record.id}: ${record.action} ${record.status}${record.metadata.deletedCount !== undefined ? `; deleted ${record.metadata.deletedCount} messages` : ''}.` });
  },
};
export const moderationCommands = [modCommand];
