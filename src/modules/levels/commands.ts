import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { boundedEmbed, presentationColor, safeMentions } from '../../core/presentation/index.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';

const guild = (id: string | null): string => { if (!id) throw new AppError('VALIDATION', 'Use this in a server.'); return id; };
export const rankCommand: Command = {
  moduleKey: 'levels', requiredLevel: 'MEMBER',
  data: new SlashCommandBuilder().setName('rank').setDescription('Show your level or another member’s')
    .addUserOption(o => o.setName('user').setDescription('Member to view')),
  async execute(interaction, services) {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const rank = await services.levels.rank(guild(interaction.guildId), user.id);
    await interaction.editReply({ content: rank ? `<@${user.id}>: level ${rank.level}, ${rank.xp} XP, ${rank.nextLevelXp === null ? 'maximum safe XP level' : `${rank.progress}/${rank.nextLevelXp} toward next level`}, rank ${rank.rank === null ? 'unranked' : `#${rank.rank}`} (${rank.messageCount} XP-worthy messages).` : 'No XP earned yet.', allowedMentions: safeMentions });
  },
};
export const leaderboardCommand: Command = {
  moduleKey: 'levels', requiredLevel: 'MEMBER',
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('Show the top 10 members by XP'),
  async execute(interaction, services) {
    const rows = await services.levels.leaderboard(guild(interaction.guildId));
    await interaction.editReply(rows.length
      ? { embeds: [boundedEmbed({ title: 'XP leaderboard', color: presentationColor('INFO'), description: rows.map(row => `#${row.rank} <@${row.userId}> — level ${row.level}, ${row.xp} XP`).join('\n') })], allowedMentions: safeMentions }
      : { content: 'No XP earned yet.', allowedMentions: safeMentions });
  },
};
export const levelsCommand: Command = {
  moduleKey: 'levels', requiredLevel: 'ADMIN',
  data: new SlashCommandBuilder().setName('levels').setDescription('Configure levels')
    .addSubcommand(s => s.setName('status').setDescription('Show level settings'))
    .addSubcommand(s => s.setName('config').setDescription('Update XP settings')
      .addIntegerOption(o => o.setName('cooldown-seconds').setDescription('Cooldown (5–3600 seconds)').setMinValue(5).setMaxValue(3600))
      .addIntegerOption(o => o.setName('xp-per-message').setDescription('XP per message (1–100)').setMinValue(1).setMaxValue(100))
      .addIntegerOption(o => o.setName('min-length').setDescription('Minimum content length (0–1000)').setMinValue(0).setMaxValue(1000))
      .addChannelOption(o => o.setName('level-up-channel').setDescription('Announcement channel').addChannelTypes(ChannelType.GuildText))
      .addBooleanOption(o => o.setName('clear-level-up-channel').setDescription('Stop level-up announcements')))
    .addSubcommandGroup(g => g.setName('reward').setDescription('Manage reward roles')
      .addSubcommand(s => s.setName('add').setDescription('Add reward').addIntegerOption(o => o.setName('level').setDescription('Level').setRequired(true).setMinValue(1).setMaxValue(10000))
        .addRoleOption(o => o.setName('role').setDescription('Safe reward role').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Remove reward').addIntegerOption(o => o.setName('level').setDescription('Level').setRequired(true).setMinValue(1).setMaxValue(10000))
        .addRoleOption(o => o.setName('role').setDescription('Reward role').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List rewards')))
    .addSubcommand(s => s.setName('ignore-channel').setDescription('Exclude a channel from XP').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('allow-channel').setDescription('Restore XP in a channel').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true))),
  async execute(interaction, services) {
    const id = guild(interaction.guildId), o = interaction.options, sub = o.getSubcommand();
    let text: string;
    if (sub === 'status') {
      const s = await services.levels.settings(id);
      const ignored = await services.levels.ignoredChannels(id);
      text = `XP/message: ${s.xpPerMessage}; cooldown: ${s.cooldownSeconds}s; minimum length: ${s.minLength} (when content available); announcement channel: ${s.levelUpChannelId ?? 'none'}; ignored channels: ${ignored.length}.`;
    } else if (sub === 'config') {
      if (o.getChannel('level-up-channel') && o.getBoolean('clear-level-up-channel'))
        throw new AppError('VALIDATION', 'Choose a level-up channel or clear it, not both.');
      const patch = { ...(o.getInteger('cooldown-seconds') !== null ? { cooldownSeconds: o.getInteger('cooldown-seconds')! } : {}),
        ...(o.getInteger('xp-per-message') !== null ? { xpPerMessage: o.getInteger('xp-per-message')! } : {}),
        ...(o.getInteger('min-length') !== null ? { minLength: o.getInteger('min-length')! } : {}),
        ...(o.getChannel('level-up-channel') ? { levelUpChannelId: o.getChannel('level-up-channel')!.id } : {}),
        ...(o.getBoolean('clear-level-up-channel') ? { levelUpChannelId: null } : {}) };
      if (!Object.keys(patch).length) throw new AppError('VALIDATION', 'Provide at least one setting.');
      await services.levels.configure(id, patch); text = 'Level settings updated.';
    } else if (sub === 'add') {
      await services.levels.addReward(id, o.getInteger('level', true), o.getRole('role', true).id); text = 'Reward added.';
    } else if (sub === 'remove') {
      await services.levels.removeReward(id, o.getInteger('level', true), o.getRole('role', true).id); text = 'Reward removed.';
    } else if (sub === 'list') {
      const rewards = await services.levels.rewards(id);
      text = rewards.length ? rewards.map(r => `Level ${r.level}: <@&${r.roleId}>`).join('\n').slice(0, 1900) : 'No level rewards.';
    } else if (sub === 'ignore-channel') {
      await services.levels.ignore(id, o.getChannel('channel', true).id); text = 'Channel ignored.';
    } else if (sub === 'allow-channel') {
      await services.levels.allow(id, o.getChannel('channel', true).id); text = 'Channel allowed.';
    } else throw new AppError('VALIDATION', 'Unknown levels command.');
    await interaction.editReply({ content: text, allowedMentions: safeMentions });
  },
};
export const levelsCommands: Command[] = [rankCommand, leaderboardCommand, levelsCommand];
