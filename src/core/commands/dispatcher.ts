import type { ChatInputCommandInteraction, Client } from 'discord.js';
import { AppError, handleError } from '../errors/errors.js';
import type { Command } from './command.js';
import type { Services } from '../../app/services.js';

export async function dispatchCommand(interaction: ChatInputCommandInteraction, commands: ReadonlyMap<string, Command>, services: Services) {
  const command = commands.get(interaction.commandName);
  if (!command) return;
  try {
    await interaction.deferReply({ ephemeral: true });
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
    const message = handleError(error, services.logger, {
      guildId: interaction.guildId, userId: interaction.user.id,
      command: interaction.commandName, module: command.moduleKey,
    });
    try {
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: message });
      else if (interaction.replied) await interaction.followUp({ content: message, ephemeral: true });
      else await interaction.reply({ content: message, ephemeral: true });
    } catch (replyError) {
      services.logger.error({ err: replyError, command: interaction.commandName }, 'Unable to send safe command response');
    }
  }
}

export function registerCommands(client: Client, commands: ReadonlyMap<string, Command>, services: Services) {
  client.on('interactionCreate', interaction => {
    if (interaction.isChatInputCommand()) void dispatchCommand(interaction, commands, services);
  });
}
