import { MessageFlags } from 'discord.js';
import type { ButtonHandler } from '../../core/components/component.js';

export const suggestionButtons: ButtonHandler[] = [{
  customId: 'suggest:', moduleKey: 'suggestions',
  matches: (customId: string) => /^suggest:(up|down):[1-9]\d*$/.test(customId),
  async handle(services, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const match = /^suggest:(up|down):([1-9]\d*)$/.exec(interaction.customId);
    const id = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(id)) {
      await interaction.editReply({ content: 'Invalid suggestion button.' }); return;
    }
    const changed = await services.suggestions.vote(interaction.guildId!, id, interaction.user.id,
      match[1] === 'up' ? 1 : -1, interaction.channelId!, interaction.message.id, interaction.user.bot);
    await interaction.editReply({ content: changed ? 'Vote saved.' : 'Your vote is already recorded.' });
  },
}];
