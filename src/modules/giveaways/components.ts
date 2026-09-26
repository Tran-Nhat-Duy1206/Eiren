import { MessageFlags } from 'discord.js';
import type { ButtonHandler } from '../../core/components/component.js';
export const giveawayButtons: ButtonHandler[] = [{
  customId: 'giveaway:', moduleKey: 'giveaways',
  matches: id => /^giveaway:(enter|leave):[1-9]\d*$/.test(id),
  async handle(services, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const match = /^giveaway:(enter|leave):([1-9]\d*)$/.exec(interaction.customId);
    const id = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(id)) { await interaction.editReply('Invalid giveaway button.'); return; }
    const changed = await services.giveaways.entry(interaction.guildId!, id, interaction.user.id,
      match[1] as 'enter' | 'leave', interaction.channelId!, interaction.message.id, interaction.user.bot);
    await interaction.editReply({ content: changed ? (match[1] === 'enter' ? 'Entry saved.' : 'Entry removed.') :
      (match[1] === 'enter' ? 'Already entered.' : 'Not entered.'), allowedMentions: { parse: [] } });
  },
}];
