import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';
import type { AchievementsService } from './service.js';

export const achievementsCommand: Command = {
  moduleKey: 'achievements', requiredLevel: 'MEMBER',
  data: new SlashCommandBuilder().setName('achievements').setDescription('View your achievements or another member’s')
    .addUserOption(option => option.setName('user').setDescription('Member to view')),
  async execute(interaction, services) {
    if (!interaction.guildId) throw new AppError('VALIDATION', 'Use this in a server.');
    const user = interaction.options.getUser('user') ?? interaction.user;
    const rows = await (services as typeof services & { achievements: AchievementsService }).achievements.listMember(interaction.guildId, user.id);
    const content = rows.length
      ? `<@${user.id}> achievements:\n${rows.map(row => `• ${row.name} — ${row.description}`).join('\n')}`
      : `<@${user.id}> has no achievements yet.`;
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  },
};
export const achievementsCommands: Command[] = [achievementsCommand];
