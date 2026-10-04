import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { safeMentions } from '../../core/presentation/index.js';
import { AppError } from '../../core/errors/errors.js';
import type { Command } from '../../core/commands/command.js';
import type { Actor, PermissionLevel } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id,
    guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
}
const reportData = new SlashCommandBuilder().setName('report').setDescription('Submit a private report or manage reports')
  .addSubcommand(s => s.setName('submit').setDescription('Privately report an incident')
    .addStringOption(o => o.setName('category').setDescription('Incident category').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('What happened?').setRequired(true))
    .addUserOption(o => o.setName('user').setDescription('Reported user'))
    .addStringOption(o => o.setName('evidence_url').setDescription('HTTPS evidence link')))
  .addSubcommand(s => s.setName('list').setDescription('List reports (staff only)'))
  .addSubcommand(s => s.setName('view').setDescription('View a report (staff only)').addIntegerOption(o => o.setName('id').setDescription('Report ID').setRequired(true).setMinValue(1)))
  .addSubcommand(s => s.setName('close').setDescription('Close a report (senior staff only)')
    .addIntegerOption(o => o.setName('id').setDescription('Report ID').setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName('note').setDescription('Resolution note').setRequired(true)));

const appealData = new SlashCommandBuilder().setName('appeal').setDescription('Submit a private appeal or review appeals')
  .addSubcommand(s => s.setName('submit').setDescription('Privately appeal a moderation action')
    .addStringOption(o => o.setName('reason').setDescription('Why should this be reviewed?').setRequired(true))
    .addIntegerOption(o => o.setName('case_id').setDescription('Optional moderation case ID').setMinValue(1)))
  .addSubcommand(s => s.setName('list').setDescription('List appeals (staff only)'))
  .addSubcommand(s => s.setName('view').setDescription('View an appeal (staff only)').addIntegerOption(o => o.setName('id').setDescription('Appeal ID').setRequired(true).setMinValue(1)))
  .addSubcommand(s => s.setName('review').setDescription('Decide an appeal (senior staff only)')
    .addIntegerOption(o => o.setName('id').setDescription('Appeal ID').setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName('decision').setDescription('Decision').setRequired(true)
      .addChoices({ name: 'Accept', value: 'ACCEPTED' }, { name: 'Reject', value: 'REJECTED' }))
    .addStringOption(o => o.setName('note').setDescription('Review note').setRequired(true)));
function required(interaction: ChatInputCommandInteraction): PermissionLevel {
  switch (interaction.options.getSubcommand()) {
    case 'submit': return 'MEMBER';
    case 'list': case 'view': return 'MODERATOR';
    default: return 'SENIOR_MODERATOR';
  }
}
const safe = (value: string) => value.replace(/@/g, '@\u200b').replace(/`/g, '\u02cb');
export const reportCommands: Command[] = [
  { data: reportData, moduleKey: 'reports', requiredLevel: required,
    async execute(interaction, services: Services) {
      const actor = await actorFor(interaction);
      const sub = interaction.options.getSubcommand();
      if (sub === 'submit') {
        const item = await services.reports.submitReport(actor, { category: interaction.options.getString('category', true),
          description: interaction.options.getString('description', true), reportedUserId: interaction.options.getUser('user')?.id,
          evidenceUrl: interaction.options.getString('evidence_url') });
        await interaction.editReply({ allowedMentions: safeMentions, content: `Private report #${item.id} submitted for staff review.` });
      } else if (sub === 'list') {
        const items = await services.reports.listReports(actor);
        await interaction.editReply({ allowedMentions: safeMentions, content: items.length ? items.map(item => `#${item.id} ${safe(item.status)} · ${safe(item.category.slice(0, 60))}`).join('\n') : 'No reports.' });
      } else if (sub === 'view') {
        const item = await services.reports.getReport(actor, interaction.options.getInteger('id', true));
        const redacted = item.narrativeRedactedAt !== null;
        await interaction.editReply({ allowedMentions: safeMentions, content: `Report #${item.id} (${item.status})\nReporter: ${item.reporterId}\nReported user: ${item.reportedUserId ?? 'Not specified'}\nCategory: ${safe(item.category)}\nDescription: ${redacted ? 'Content redacted by retention policy.' : safe((item.description ?? '').slice(0, 1200))}\nEvidence: ${redacted ? 'Content redacted by retention policy.' : safe((item.evidenceUrl ?? 'None').slice(0, 200))}\nResolution: ${redacted ? 'Content redacted by retention policy.' : safe((item.resolutionNote ?? 'None').slice(0, 200))}` });
      } else {
        const item = await services.reports.closeReport(actor, interaction.options.getInteger('id', true), interaction.options.getString('note', true));
        await interaction.editReply({ allowedMentions: safeMentions, content: `Report #${item.id} closed. No automatic moderation action was taken.` });
      }
    } },
  { data: appealData, moduleKey: 'reports', requiredLevel: required,
    async execute(interaction, services: Services) {
      const actor = await actorFor(interaction);
      const sub = interaction.options.getSubcommand();
      if (sub === 'submit') {
        const item = await services.reports.submitAppeal(actor, { reason: interaction.options.getString('reason', true), caseId: interaction.options.getInteger('case_id') });
        await interaction.editReply({ allowedMentions: safeMentions, content: `Private appeal #${item.id} submitted for staff review.` });
      } else if (sub === 'list') {
        const items = await services.reports.listAppeals(actor);
        await interaction.editReply({ allowedMentions: safeMentions, content: items.length ? items.map(item => `#${item.id} ${item.status} · case ${item.caseId ?? 'not specified'}`).join('\n') : 'No appeals.' });
      } else if (sub === 'view') {
        const item = await services.reports.getAppeal(actor, interaction.options.getInteger('id', true));
        const redacted = item.narrativeRedactedAt !== null;
        await interaction.editReply({ allowedMentions: safeMentions, content: `Appeal #${item.id} (${item.status})\nAppellant: ${item.appellantId}\nCase: ${item.caseId ?? 'Not specified'}\nReason: ${redacted ? 'Content redacted by retention policy.' : safe((item.reason ?? '').slice(0, 1400))}\nReview note: ${redacted ? 'Content redacted by retention policy.' : safe((item.reviewNote ?? 'None').slice(0, 300))}` });
      } else {
        const decision = interaction.options.getString('decision', true);
        if (decision !== 'ACCEPTED' && decision !== 'REJECTED') throw new AppError('VALIDATION', 'Invalid decision.');
        const item = await services.reports.reviewAppeal(actor, interaction.options.getInteger('id', true), decision, interaction.options.getString('note', true));
        await interaction.editReply({ allowedMentions: safeMentions, content: `Appeal #${item.id} marked ${item.status}. No automatic reversal was performed.` });
      }
    } },
];
