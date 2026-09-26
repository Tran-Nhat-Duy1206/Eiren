import { ChannelType, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import type { Actor } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';
import { AppError } from '../../core/errors/errors.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id, guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
}
export const starboardCommands: Command[] = [{
  data: new SlashCommandBuilder().setName('starboard').setDescription('Configure the starboard')
    .addSubcommand(s => s.setName('status').setDescription('Show starboard settings'))
    .addSubcommand(s => s.setName('enable').setDescription('Enable starboard'))
    .addSubcommand(s => s.setName('disable').setDescription('Disable starboard'))
    .addSubcommand(s => s.setName('channel').setDescription('Select the starboard destination').addChannelOption(o => o.setName('channel').setDescription('Destination channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('threshold').setDescription('Set the required unique stars').addIntegerOption(o => o.setName('count').setDescription('Required stars').setRequired(true).setMinValue(1).setMaxValue(25)))
    .addSubcommand(s => s.setName('emoji').setDescription('Set reaction emoji').addStringOption(o => o.setName('emoji').setDescription('Emoji').setRequired(true).setMaxLength(100)))
    .addSubcommand(s => s.setName('self-star').setDescription('Allow stars from the message author').addBooleanOption(o => o.setName('allow').setDescription('Allow self stars').setRequired(true)))
    .addSubcommand(s => s.setName('ignore-channel').setDescription('Ignore a source channel').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('allow-channel').setDescription('Remove a source channel ignore').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))),
  moduleKey: 'starboard', requiredLevel: 'ADMIN',
  async execute(interaction, services: Services) {
    const actor = await actorFor(interaction);
    const action = interaction.options.getSubcommand();
    if (action === 'ignore-channel' || action === 'allow-channel') {
      await services.starboard.ignore(actor, interaction.options.getChannel('channel', true).id, action === 'ignore-channel');
      await interaction.editReply({ content: 'Starboard channel filter updated.' });
      return;
    }
    const changes = action === 'enable' ? { enabled: true } : action === 'disable' ? { enabled: false } :
      action === 'channel' ? { channelId: interaction.options.getChannel('channel', true).id } :
      action === 'threshold' ? { threshold: interaction.options.getInteger('count', true) } :
      action === 'emoji' ? { emoji: interaction.options.getString('emoji', true) } :
      action === 'self-star' ? { allowSelf: interaction.options.getBoolean('allow', true) } : null;
    const settings = changes ? await services.starboard.configure(actor, changes) : await services.starboard.settings(actor);
    await interaction.editReply({ content: settings ? `Starboard ${settings.enabled ? 'enabled' : 'disabled'} · channel ${settings.channelId ? `<#${settings.channelId}>` : 'none'} · ${settings.emoji} ${settings.threshold} · self-stars ${settings.allowSelf ? 'on' : 'off'}` : 'Starboard not configured.', allowedMentions: { parse: [] } });
  },
}];
