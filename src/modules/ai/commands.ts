import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';
import type { AiMode, AiRuntimeResult } from './runtime.js';

const messageFor = (result: AiRuntimeResult): string => {
  switch (result.kind) {
    case 'ok': return result.text;
    case 'disabled': return 'AI is disabled or this request began before AI was re-enabled.';
    case 'unavailable': return 'AI is unavailable or this request is no longer authorized.';
    case 'too_large': return 'AI input exceeds the safe character or estimated-token limit.';
    case 'limited': return 'AI is busy or a request, cooldown, or spending limit was reached.';
    case 'timeout': return 'AI timed out. Please try again later.';
    case 'failed': return 'AI could not complete this request. Please try again later.';
  }
};

export const aiCommands: Command[] = [{
  data: new SlashCommandBuilder().setName('ai').setDescription('Explicit, private AI requests (provider unavailable until configured)')
    .addSubcommand(sub => sub.setName('ask').setDescription('Ask about text you explicitly supply')
      .addStringOption(option => option.setName('prompt').setDescription('Your explicit request')
        .setRequired(true).setMaxLength(4000)))
    .addSubcommand(sub => sub.setName('summarize').setDescription('Summarize only text you paste')
      .addStringOption(option => option.setName('text').setDescription('Text to summarize')
        .setRequired(true).setMaxLength(4000)))
    .addSubcommand(sub => sub.setName('status').setDescription('Show private AI availability without credentials')),
  moduleKey: 'ai', requiredLevel: 'MEMBER',
  async execute(interaction, services, context) {
    if (!interaction.guildId || !context) throw new AppError('VALIDATION', 'Use this command in a server.');
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'status') {
      const enabled = await services.modules.isEnabled(interaction.guildId, 'ai');
      const { providerAvailable, config } = services.aiRuntime.status();
      const provider = providerAvailable ? 'available' : 'unavailable';
      const approved = config ? ` Approved provider/model: ${config.providerId}/${config.modelId}.` : '';
      await interaction.editReply({ content: `AI module ${enabled ? 'enabled' : 'disabled'}; provider ${provider}.${approved}`,
        allowedMentions: { parse: [] } });
      return;
    }
    if (subcommand !== 'ask' && subcommand !== 'summarize') throw new AppError('VALIDATION', 'Unknown AI request.');
    const mode: AiMode = subcommand;
    const text = interaction.options.getString(mode === 'ask' ? 'prompt' : 'text', true);
    const result = await services.aiRuntime.run({ ingress: context.aiIngress, actor: context.actor,
      requestKey: interaction.id, mode, text });
    // Dispatcher defer is always ephemeral; edit never posts publicly or attaches content.
    await interaction.editReply({ content: messageFor(result), allowedMentions: { parse: [] } });
  },
}];
