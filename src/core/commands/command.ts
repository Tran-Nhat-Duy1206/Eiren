import type { ChatInputCommandInteraction, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import type { Actor, PermissionLevel } from '../permissions/permission-service.js';
import type { AiIngressToken } from '../../modules/ai/repository.js';
import type { Services } from '../../app/services.js';

export type SlashDefinition = SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
export type CommandContext = Readonly<{ actor: Actor; aiIngress: AiIngressToken | null }>;
export interface Command {
  data: SlashDefinition;
  moduleKey: string;
  requiredLevel: PermissionLevel | ((interaction: ChatInputCommandInteraction) => PermissionLevel);
  execute(interaction: ChatInputCommandInteraction, services: Services, context?: CommandContext): Promise<void>;
}
