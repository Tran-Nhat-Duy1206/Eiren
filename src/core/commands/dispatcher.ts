import { MessageFlags, type ChatInputCommandInteraction, type Client } from 'discord.js';
import { AppError, handleError } from '../errors/errors.js';
import type { Command } from './command.js';
import type { Services } from '../../app/services.js';
import type { AnalyticsIngressReservation } from '../../modules/analytics/repository.js';
import type { AiIngressToken } from '../../modules/ai/repository.js';

export async function dispatchCommand(interaction: ChatInputCommandInteraction, commands: ReadonlyMap<string, Command>, services: Services) {
  const command = commands.get(interaction.commandName);
  if (!command) return;
  const startedAt = new Date();
  const started = performance.now();
  // AI ingress is authoritative and must precede *every* unrelated dispatcher await.
  // Never refresh this token after an opt-out/re-enable, even when the module is on again.
  const aiStatus = command.moduleKey === 'ai' && interaction.options.getSubcommand(false) === 'status';
  let aiIngress: AiIngressToken | null = null;
  if (command.moduleKey === 'ai' && !aiStatus && interaction.guildId) {
    try { aiIngress = await services.ai.reserveIngress(interaction.guildId); }
    catch (error) {
      try { services.logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'AI ingress failed'); }
      catch { /* Failed optional logging does not authorize an ingress. */ }
    }
  }
  // Optional telemetry is reserved before the first dispatcher await. Its epoch is never refreshed.
  let analyticsIngress: AnalyticsIngressReservation | null = null;
  if (interaction.guildId) {
    try { analyticsIngress = await services.analytics.reserveIngestion(interaction.guildId); }
    catch (error) {
      try { services.logger.warn({ command: interaction.commandName, errorType: error instanceof Error ? error.name : 'unknown' },
        'Optional command analytics ingress failed'); } catch { /* Optional telemetry never changes command outcomes. */ }
    }
  }
  let failed = false;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) throw new AppError('VALIDATION', 'Use this command in a server.');
    if (command.moduleKey !== 'core' && !aiStatus && !await services.modules.isEnabled(interaction.guildId, command.moduleKey))
      throw new AppError('DISABLED', 'This module is disabled in this server.');
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const actor = {
      userId: interaction.user.id, guildId: interaction.guildId,
      guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()],
    };
    await services.permissions.require(actor, typeof command.requiredLevel === 'function' ? command.requiredLevel(interaction) : command.requiredLevel);
    await command.execute(interaction, services, { actor, aiIngress });
  } catch (error) {
    failed = true;
    let message: string;
    if (command.moduleKey === 'ai') {
      // Provider and driver errors may contain text or credentials; never pass them to handleError.
      message = error instanceof AppError && error.code !== 'DATABASE' ? error.message : 'AI is temporarily unavailable.';
      try { services.logger.warn({ command: interaction.commandName,
        errorType: error instanceof Error ? error.name : 'unknown' }, 'AI command rejected safely'); }
      catch { /* Logging failure must not replace a safe user result. */ }
    } else message = handleError(error, services.logger, {
      guildId: interaction.guildId, userId: interaction.user.id,
      command: interaction.commandName, module: command.moduleKey,
    });
    try {
      const mentionGuard = command.moduleKey === 'ai' ? { allowedMentions: { parse: [] as [] } } : {};
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: message, ...mentionGuard });
      else if (interaction.replied) await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral, ...mentionGuard });
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral, ...mentionGuard });
    } catch (replyError) {
      if (command.moduleKey === 'ai') {
        try { services.logger.error({ errorType: replyError instanceof Error ? replyError.name : 'unknown',
          command: interaction.commandName }, 'Unable to send safe AI response'); } catch { /* Never surface raw AI text. */ }
      } else services.logger.error({ err: replyError, command: interaction.commandName }, 'Unable to send safe command response');
    }
  } finally {
    // Analytics is optional telemetry: a failed write never changes a command's outcome.
    if (analyticsIngress) {
      try {
        await services.analytics.recordCommand(analyticsIngress, interaction.id, interaction.commandName,
          failed, Math.max(0, Math.min(86_400_000, Math.round(performance.now() - started))), startedAt);
      } catch (error) {
        try { services.logger.warn({ command: interaction.commandName, errorType: error instanceof Error ? error.name : 'unknown' },
          'Optional command analytics failed'); } catch { /* Optional telemetry never changes command outcomes. */ }
      }
    }
  }
}

export function registerCommands(client: Client, commands: ReadonlyMap<string, Command>, services: Services) {
  client.on('interactionCreate', interaction => {
    if (interaction.isChatInputCommand()) void dispatchCommand(interaction, commands, services);
  });
}
