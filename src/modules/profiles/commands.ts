import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';
import type { Services } from '../../app/services.js';

export const profileCommands: Command[] = [{
  data: new SlashCommandBuilder().setName('profile').setDescription('View a member’s public community profile')
    .addUserOption(option => option.setName('user').setDescription('Member to view (defaults to you)')),
  moduleKey: 'profiles', requiredLevel: 'MEMBER',
  async execute(interaction: ChatInputCommandInteraction, services: Services) {
    if (!interaction.guild || !interaction.guildId) throw new AppError('VALIDATION', 'Use this command in a server.');
    const user = interaction.options.getUser('user') ?? interaction.user;
    let member;
    try { member = await interaction.guild.members.fetch(user.id); }
    catch { throw new AppError('NOT_FOUND', 'Member is not in this server.'); }
    const profile = await services.profiles.get(interaction.guildId, user.id);
    const lines = [`**${member.displayName.replace(/[@*`_~|>]/g, '').slice(0, 80)}** · <@${user.id}>`,
      `Joined: ${member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>` : 'Unknown'}`];
    if ('levels' in profile) {
      const level = profile.levels;
      lines.push(level ? `Level ${level.level} · ${level.xp} XP · ${level.nextLevelXp === null ? 'maximum safe XP level' : `${level.progress}/${level.nextLevelXp} toward next level`} · Rank ${level.rank ?? 'unranked'} · ${level.messageCount} XP-worthy messages`
        : 'Level 0 · 0 XP · Unranked');
    }
    if ('reputation' in profile) lines.push(`Reputation: ${profile.reputation ?? 0}`);
    if (!('levels' in profile) && !('reputation' in profile)) lines.push('Levels and reputation are disabled in this server.');
    await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
  },
}];
