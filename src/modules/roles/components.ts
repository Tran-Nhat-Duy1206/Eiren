import { MessageFlags, type ButtonInteraction, type StringSelectMenuInteraction } from 'discord.js';
import type { ButtonHandler, SelectMenuHandler } from '../../core/components/component.js';
import type { Services } from '../../app/services.js';
import { BUTTON_PREFIX, SELECT_PREFIX, parsePanelId } from './service.js';

export const roleMenuButtons: ButtonHandler[] = [{
  customId: BUTTON_PREFIX, moduleKey: 'roles', matches: customId => customId.startsWith(BUTTON_PREFIX),
  async handle(services: Services, interaction: ButtonInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { menuId, optionId, action } = parsePanelId(interaction.customId, BUTTON_PREFIX);
    const result = await services.roles.interact(interaction.guildId!, menuId, interaction.user.id, interaction.channelId, interaction.message.id, 'BUTTON', [optionId!], action);
    await interaction.editReply({ content: result.added ? 'Role assigned.' : result.removed ? 'Role removed.' : 'Roles already up to date.' });
  },
}];
export const roleMenuSelects: SelectMenuHandler[] = [{
  customId: SELECT_PREFIX, moduleKey: 'roles', matches: customId => customId.startsWith(SELECT_PREFIX),
  async handle(services: Services, interaction: StringSelectMenuInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { menuId } = parsePanelId(interaction.customId, SELECT_PREFIX);
    if (new Set(interaction.values).size !== interaction.values.length || interaction.values.some(value => !/^[1-9]\d*$/.test(value)))
      throw new Error('Invalid option values');
    const result = await services.roles.interact(interaction.guildId!, menuId, interaction.user.id, interaction.channelId, interaction.message.id, 'SELECT', interaction.values.map(Number));
    await interaction.editReply({ content: `Roles updated (${result.added} added, ${result.removed} removed).` });
  },
}];
