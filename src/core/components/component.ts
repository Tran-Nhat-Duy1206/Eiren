import { MessageFlags, type ButtonInteraction, type Client } from 'discord.js';
import { AppError, handleError } from '../errors/errors.js';
import type { Services } from '../../app/services.js';

export interface ButtonHandler {
  /** Exact, stable custom ID. Persistent panels must not embed per-interaction state. */
  customId: string;
  moduleKey: string;
  handle(services: Services, interaction: ButtonInteraction): Promise<void>;
}

export async function dispatchButton(interaction: ButtonInteraction, handlers: ReadonlyMap<string, ButtonHandler>, services: Services) {
  const handler = handlers.get(interaction.customId);
  if (!handler) return;
  try {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild)
      throw new AppError('VALIDATION', 'This button only works inside the server.');
    if (handler.moduleKey !== 'core' && !await services.modules.isEnabled(interaction.guildId, handler.moduleKey))
      throw new AppError('DISABLED', 'This module is disabled in this server.');
    await handler.handle(services, interaction);
  } catch (error) {
    const message = handleError(error, services.logger, {
      guildId: interaction.guildId, userId: interaction.user?.id, component: interaction.customId, module: handler.moduleKey,
    });
    try {
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: message });
      else if (interaction.replied) await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      services.logger.error({ err: replyError, component: interaction.customId }, 'Unable to send safe component response');
    }
  }
}

export function registerComponents(client: Client, handlers: ReadonlyMap<string, ButtonHandler>, services: Services) {
  client.on('interactionCreate', interaction => {
    if (interaction.isButton()) void dispatchButton(interaction, handlers, services);
  });
}
