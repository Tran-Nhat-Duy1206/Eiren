import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { PanelMessage } from './discord-gateway.js';
import type { VerificationSettings } from './repository.js';
import { boundedEmbed, presentationColor } from '../../core/presentation/index.js';

// Stable custom IDs: persistent panels keep working after restarts and re-posts.
export const VERIFY_BUTTON_ID = 'eiren:v2:verify';
export const RULES_ACK_BUTTON_ID = 'eiren:v2:ack';

export function buildVerificationPanel(settings: Pick<VerificationSettings,
  'mode' | 'minAccountAgeSeconds' | 'requireRulesAck'>): PanelMessage {
  const lines = [
    'Click **Verify** below to confirm you are a real member and unlock the server.',
  ];
  if (settings.requireRulesAck) lines.push('Read the server rules first, then press **Acknowledge rules**.');
  if (settings.mode === 'MANUAL') lines.push('This server uses manual review: after joining, staff will approve you.');
  if (settings.mode === 'BUTTON_AND_ACCOUNT_AGE' && settings.minAccountAgeSeconds)
    lines.push(`Accounts newer than ${formatAge(settings.minAccountAgeSeconds)} are held for staff review.`);
  lines.push('Already verified? Nothing happens when you press the button again.');
  const embed = new EmbedBuilder(boundedEmbed({
    title: 'Verification', color: presentationColor('INFO'), description: lines.join('\n'),
  }));
  const buttons: ButtonBuilder[] = [];
  if (settings.requireRulesAck) {
    buttons.push(new ButtonBuilder().setCustomId(RULES_ACK_BUTTON_ID).setLabel('Acknowledge rules').setStyle(ButtonStyle.Secondary));
  }
  if (settings.mode !== 'MANUAL') {
    buttons.push(new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID).setLabel('Verify').setStyle(ButtonStyle.Success));
  }
  const components = buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [];
  return { embeds: [embed], components };
}

function formatAge(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  return `${Math.ceil(seconds / 60)} minute(s)`;
}
