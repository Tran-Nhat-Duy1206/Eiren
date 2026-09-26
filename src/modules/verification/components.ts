import { MessageFlags, type ButtonInteraction } from 'discord.js';
import type { ButtonHandler } from '../../core/components/component.js';
import type { Services } from '../../app/services.js';
import { RULES_ACK_BUTTON_ID, VERIFY_BUTTON_ID } from './panel.js';

export const verificationButtons: ButtonHandler[] = [
  {
    customId: VERIFY_BUTTON_ID,
    moduleKey: 'verification',
    async handle(services: Services, interaction: ButtonInteraction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await services.verification.validatePanelInteraction(interaction.guildId!, interaction.message.id, interaction.channelId!, interaction.user.id);
      const result = await services.verification.verifyWithButton({
        guildId: interaction.guildId!,
        userId: interaction.user.id,
        accountCreatedAt: interaction.user.createdAt ?? null,
      });
      await interaction.editReply({
        content: result.alreadyVerified
          ? 'You are already verified. Nothing else to do.'
          : 'Verification complete. Welcome to the server!',
      });
    },
  },
  {
    customId: RULES_ACK_BUTTON_ID,
    moduleKey: 'verification',
    async handle(services: Services, interaction: ButtonInteraction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await services.verification.validatePanelInteraction(interaction.guildId!, interaction.message.id, interaction.channelId!, interaction.user.id);
      await services.verification.acknowledgeRules(interaction.guildId!, interaction.user.id);
      await interaction.editReply({ content: 'Rules acknowledged. You can now press Verify.' });
    },
  },
];
