import { MessageFlags, type ChatInputCommandInteraction, type Client } from 'discord.js';
import { AppError, handleError } from '../errors/errors.js';
import type { Command } from './command.js';
import type { Services } from '../../app/services.js';

export async function dispatchCommand(interaction: ChatInputCommandInteraction, commands: ReadonlyMap<string, Command>, services: Services) {
  const command = commands.get(interaction.commandName);
  if (!command) return;
  const startedAt = new Date();
  const started = performance.now();
  let failed = false;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) throw new AppError('VALIDATION', 'Use this command in a server.');
    if (command.moduleKey !== 'core' && !await services.modules.isEnabled(interaction.guildId, command.moduleKey))
      throw new AppError('DISABLED', 'This module is disabled in this server.');
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const actor = {
      userId: interaction.user.id, guildId: interaction.guildId,
      guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()],
    };
    await services.permissions.require(actor, typeof command.requiredLevel === 'function' ? command.requiredLevel(interaction) : command.requiredLevel);
    await command.execute(interaction, services);
  } catch (error) {
    failed = true;
    const message = handleError(error, services.logger, {
      guildId: interaction.guildId, userId: interaction.user.id,
      command: interaction.commandName, module: command.moduleKey,
    });
    try {
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: message });
      else if (interaction.replied) await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      services.logger.error({ err: replyError, command: interaction.commandName }, 'Unable to send safe command response');
    }
  } finally {
    // Analytics is optional telemetry: a failed write never changes a command's outcome.
    if (interaction.guildId) {
      try {
        if (await services.modules.isEnabled(interaction.guildId, 'analytics'))
          await services.analytics.recordCommand(interaction.guildId, interaction.id, interaction.commandName,
            failed, Math.max(0, Math.min(86_400_000, Math.round(performance.now() - started))), startedAt);
      } catch (error) {
        services.logger.warn({ command: interaction.commandName, errorType: error instanceof Error ? error.name : 'unknown' },
          'Optional command analytics failed');
      }
    }
  }
}

export function registerCommands(client: Client, commands: ReadonlyMap<string, Command>, services: Services) {
  client.on('interactionCreate', interaction => {
    if (interaction.isChatInputCommand()) void dispatchCommand(interaction, commands, services);
  });
}
