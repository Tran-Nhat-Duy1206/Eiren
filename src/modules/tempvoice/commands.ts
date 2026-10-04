import { ChannelType, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { safeMentions } from '../../core/presentation/index.js';
import { AppError } from '../../core/errors/errors.js';
import type { Actor } from '../../core/permissions/permission-service.js';
import type { Command } from '../../core/commands/command.js';
import type { Services } from '../../app/services.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<{ actor: Actor; channelId: string | null }> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { actor: { userId: member.id, guildId: interaction.guild.id, guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] }, channelId: member.voice.channelId };
}
export const tempvoiceCommand: Command = {
  data: new SlashCommandBuilder().setName('tempvoice').setDescription('Configure temporary voice rooms')
    .addSubcommand(s => s.setName('status').setDescription('View temporary voice setup'))
    .addSubcommand(s => s.setName('setup').setDescription('Configure and enable temporary voice rooms')
      .addChannelOption(o => o.setName('lobby').setDescription('Join-to-create voice lobby').addChannelTypes(ChannelType.GuildVoice).setRequired(true))
      .addChannelOption(o => o.setName('category').setDescription('Category for generated rooms').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
      .addIntegerOption(o => o.setName('limit').setDescription('Default member limit, 0–99').setMinValue(0).setMaxValue(99))
      .addBooleanOption(o => o.setName('private').setDescription('Hide rooms from everyone by default')))
    .addSubcommand(s => s.setName('disable').setDescription('Disable lobby room creation')),
  moduleKey: 'tempvoice', requiredLevel: 'ADMIN',
  async execute(interaction, services: Services) {
    const { actor } = await actorFor(interaction);
    const sub = interaction.options.getSubcommand();
    const service = services.tempvoice;
    const result = sub === 'setup' ? await service.setup(actor, interaction.options.getChannel('lobby', true).id, interaction.options.getChannel('category', true).id, interaction.options.getInteger('limit') ?? 0, interaction.options.getBoolean('private') ?? true)
      : sub === 'disable' ? await service.disable(actor) : await service.settings(actor);
    await interaction.editReply({ allowedMentions: safeMentions, content: `Temporary voice: ${result?.enabled ? 'enabled' : 'disabled'}; lobby: ${result?.lobbyChannelId ?? 'unset'}; category: ${result?.categoryId ?? 'unset'}; limit: ${result?.userLimit ?? 0}; private: ${result?.defaultPrivate ?? true}.` });
  },
};
const voiceData = new SlashCommandBuilder().setName('voice').setDescription('Control your temporary voice room')
  .addSubcommand(s => s.setName('rename').setDescription('Rename your room').addStringOption(o => o.setName('name').setDescription('Room name').setRequired(true).setMaxLength(100)))
  .addSubcommand(s => s.setName('lock').setDescription('Block default joins; allowed members may enter'))
  .addSubcommand(s => s.setName('unlock').setDescription('Restore default joins; private rooms stay hidden'))
  .addSubcommand(s => s.setName('limit').setDescription('Set room user limit').addIntegerOption(o => o.setName('count').setDescription('0–99; 0 means unlimited').setRequired(true).setMinValue(0).setMaxValue(99)))
  .addSubcommand(s => s.setName('kick').setDescription('Disconnect a member').addUserOption(o => o.setName('member').setDescription('Member').setRequired(true)))
  .addSubcommand(s => s.setName('allow').setDescription('Grant member voice access').addUserOption(o => o.setName('member').setDescription('Member').setRequired(true)))
  .addSubcommand(s => s.setName('deny').setDescription('Deny member voice access').addUserOption(o => o.setName('member').setDescription('Member').setRequired(true)))
  .addSubcommand(s => s.setName('transfer').setDescription('Transfer room ownership to an occupant').addUserOption(o => o.setName('member').setDescription('Member').setRequired(true)))
  .addSubcommand(s => s.setName('status').setDescription('View ownership and room status'));
export const voiceCommand: Command = {
  data: voiceData, moduleKey: 'tempvoice', requiredLevel: 'MEMBER',
  async execute(interaction, services: Services) {
    const { actor, channelId } = await actorFor(interaction);
    const action = interaction.options.getSubcommand() as 'rename' | 'lock' | 'unlock' | 'limit' | 'kick' | 'allow' | 'deny' | 'transfer' | 'status';
    const value = action === 'rename' ? interaction.options.getString('name', true) : action === 'limit' ? interaction.options.getInteger('count', true) : ['kick', 'allow', 'deny', 'transfer'].includes(action) ? interaction.options.getUser('member', true).id : undefined;
    const room = await services.tempvoice.control(actor, channelId, action, value);
    await interaction.editReply({ allowedMentions: safeMentions, content: action === 'status' ? `Room <#${room.channelId}> is ${room.status}; owner: <@${room.ownerId}>.` : `Room <#${room.channelId}> ${action} completed.` });
  },
};
export const tempvoiceCommands = [tempvoiceCommand, voiceCommand];
