import { MessageFlags } from 'discord.js';
import type { ButtonHandler } from '../../core/components/component.js';
export const eventButtons: ButtonHandler[] = [{
  customId: 'event:', moduleKey: 'events',
  matches: id => /^event:(join|leave):[1-9]\d*$/.test(id) && id.length <= 100,
  async handle(services, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const match = /^event:(join|leave):([1-9]\d*)$/.exec(interaction.customId);
    const id = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(id)) { await interaction.editReply({ content: 'Invalid event button.' }); return; }
    const changed = await services.events.button(interaction.guildId!, id, interaction.user.id, interaction.user.bot,
      match[1] as 'join' | 'leave', interaction.channelId!, interaction.message.id);
    await interaction.editReply({ content: changed ? (match[1] === 'join' ? 'Joined event.' : 'Left event.') : 'No change.' });
  },
}];
