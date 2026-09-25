import type { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import type { PermissionLevel } from '../permissions/permission-service.js';
import type { Services } from '../../app/services.js';

export type SlashDefinition = SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
export interface Command {
  data: SlashDefinition;
  moduleKey: string;
  requiredLevel: PermissionLevel | ((interaction: ChatInputCommandInteraction) => PermissionLevel);
  execute(interaction: ChatInputCommandInteraction, services: Services): Promise<void>;
}
