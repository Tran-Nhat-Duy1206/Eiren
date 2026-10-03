import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';
import { SCOPE_WARNING, WORKFLOW_EVIDENCE_WARNING, type SubjectRequestView } from './contracts.js';

/** An explicit metadata whitelist: never format inventories, source rows or arbitrary service objects. */
export function ownRequestContent(request: SubjectRequestView | null): string {
  const summary = request
    ? `Your privacy request: ${request.id}\nStatus: ${request.status}\nRequested: ${request.requestedAt}${request.terminalAt ? `\nTerminal: ${request.terminalAt}` : ''}${request.denialCode ? `\nDenial code: ${request.denialCode}` : ''}`
    : 'No privacy request was found for you in this server.';
  return `${summary}\n\n${SCOPE_WARNING}\n\n${WORKFLOW_EVIDENCE_WARNING}`;
}

export const privacyCommand: Command = {
  moduleKey: 'core', requiredLevel: 'MEMBER',
  data: new SlashCommandBuilder().setName('privacy').setDescription('Request reviewed handling of your own Eiren data')
    .addSubcommand(sub => sub.setName('request').setDescription('Create a request for yourself in this server'))
    .addSubcommand(sub => sub.setName('status').setDescription('View your own request status in this server')),
  async execute(interaction, services) {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild)
      throw new AppError('VALIDATION', 'Use this command in a server.');
    const action = interaction.options.getSubcommand();
    let request: SubjectRequestView | null;
    try {
      if (action === 'request') {
        // The service verifies fresh current membership from this authenticated interaction.
        // There is intentionally no target user, guild override or free-form narrative option.
        request = await services.subjectRequests.createSelfRequest(interaction);
      } else if (action === 'status') {
        request = await services.subjectRequests.ownStatus({ guildId: interaction.guildId, userId: interaction.user.id });
      } else throw new AppError('VALIDATION', 'Invalid privacy action.');
    } catch (error) {
      if (error instanceof AppError) throw error;
      // DATABASE is the existing sanitized dispatcher boundary; never attach raw cause/SQL/text.
      throw new AppError('DATABASE', 'Privacy request service is temporarily unavailable.');
    }
    await interaction.editReply({ content: ownRequestContent(request), allowedMentions: { parse: [] } });
  },
};
export const subjectRequestCommands: Command[] = [privacyCommand];
