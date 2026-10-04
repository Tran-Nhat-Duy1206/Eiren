import { AttachmentBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { safeMentions } from '../../core/presentation/index.js';
import { AppError } from '../../core/errors/errors.js';
import type { Command } from '../../core/commands/command.js';
import type { Actor } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';
import { ticketTypes } from './service.js';
import { transcriptChunks } from './transcript.js';
import type { Ticket } from './repository.js';

async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { userId: interaction.user.id, guildId: interaction.guild.id, guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
}
const data = new SlashCommandBuilder().setName('ticket').setDescription('Private support tickets')
  .addSubcommand(s => s.setName('open').setDescription('Create a private ticket').addStringOption(o => o.setName('type').setDescription('Ticket type').setRequired(true).addChoices(...ticketTypes.map(type => ({ name: type, value: type })))))
  .addSubcommand(s => s.setName('close').setDescription('Close and archive a ticket').addIntegerOption(o => o.setName('id').setDescription('Ticket ID').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Closing reason')))
  .addSubcommand(s => s.setName('add').setDescription('Grant member ticket access').addIntegerOption(o => o.setName('id').setDescription('Ticket ID').setRequired(true)).addUserOption(o => o.setName('member').setDescription('Member').setRequired(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Revoke member ticket access').addIntegerOption(o => o.setName('id').setDescription('Ticket ID').setRequired(true)).addUserOption(o => o.setName('member').setDescription('Member').setRequired(true)))
  .addSubcommand(s => s.setName('claim').setDescription('Claim an unassigned ticket').addIntegerOption(o => o.setName('id').setDescription('Ticket ID').setRequired(true)))
  .addSubcommand(s => s.setName('transfer').setDescription('Transfer ticket to staff').addIntegerOption(o => o.setName('id').setDescription('Ticket ID').setRequired(true)).addUserOption(o => o.setName('member').setDescription('Staff member').setRequired(true)))
  .addSubcommand(s => s.setName('transcript').setDescription('Staff: download archived ticket transcript privately').addIntegerOption(o => o.setName('id').setDescription('Ticket ID').setRequired(true)))
  .addSubcommand(s => s.setName('status').setDescription('View ticket metadata').addIntegerOption(o => o.setName('id').setDescription('Ticket ID').setRequired(true)))
  .addSubcommand(s => s.setName('list').setDescription('List your tickets or staff queue').addBooleanOption(o => o.setName('all').setDescription('Staff: list guild tickets')))
  .addSubcommand(s => s.setName('config').setDescription('Configure ticket staff and limits').addRoleOption(o => o.setName('staff-role').setDescription('Ticket staff role')).addChannelOption(o => o.setName('transcript-channel').setDescription('Private transcript destination (never used automatically)')).addIntegerOption(o => o.setName('max-active').setDescription('Maximum active tickets per user (1-10)')));
export const ticketCommand: Command = {
  data, moduleKey: 'tickets',
  // Service performs contextual authorization: own close/status/list must remain available to members.
  requiredLevel: interaction => {
    const sub = interaction.options.getSubcommand();
    return sub === 'config' ? 'ADMIN' : sub === 'transfer' || sub === 'transcript' ? 'MODERATOR' : ['claim', 'add', 'remove'].includes(sub) || (sub === 'list' && interaction.options.getBoolean('all')) ? 'HELPER' : 'MEMBER';
  },
  async execute(interaction, services: Services) {
    const actor = await actorFor(interaction);
    const sub = interaction.options.getSubcommand();
    const tickets = services.tickets;
    const id = () => interaction.options.getInteger('id', true);
    if (sub === 'open') {
      const row = await tickets.open(actor, interaction.options.getString('type', true) as (typeof ticketTypes)[number]);
      await interaction.editReply({ allowedMentions: safeMentions, content: `Ticket #${row.id} opened: <#${row.channelId}>.` });
    } else if (sub === 'close') {
      const row = await tickets.close(actor, id(), interaction.options.getString('reason') ?? undefined);
      await interaction.editReply({ allowedMentions: safeMentions, content: `Ticket #${row.id} is closed and archived.` });
    } else if (sub === 'add' || sub === 'remove') {
      const row = await tickets.participant(actor, id(), interaction.options.getUser('member', true).id, sub === 'add');
      await interaction.editReply({ allowedMentions: safeMentions, content: `Ticket #${row.id} participant ${sub === 'add' ? 'added' : 'removed'}.` });
    } else if (sub === 'claim') {
      const row = await tickets.claim(actor, id());
      await interaction.editReply({ allowedMentions: safeMentions, content: `Ticket #${row.id} claimed.` });
    } else if (sub === 'transfer') {
      const row = await tickets.transfer(actor, id(), interaction.options.getUser('member', true).id);
      await interaction.editReply({ allowedMentions: safeMentions, content: `Ticket #${row.id} transferred.` });
    } else if (sub === 'transcript') {
      const transcript = await tickets.transcript(actor, id());
      const chunks = transcriptChunks(transcript);
      for (const [index, chunk] of chunks.entries()) {
        const files = [new AttachmentBuilder(chunk, { name: `ticket-${id()}-transcript-${index + 1}-of-${chunks.length}.txt` })];
        const content = `Private ticket #${id()} transcript part ${index + 1} of ${chunks.length}.`;
        if (index === 0) await interaction.editReply({ allowedMentions: safeMentions, content, files });
        else await interaction.followUp({ content, files, allowedMentions: safeMentions, flags: MessageFlags.Ephemeral });
      }
    } else if (sub === 'status') {
      const row = await tickets.status(actor, id());
      await interaction.editReply({ allowedMentions: safeMentions, content: `#${row.id} ${row.type} ${row.status}; creator: ${row.creatorId}; assigned: ${row.assignedStaffId ?? 'none'}; channel: ${row.channelId ? `<#${row.channelId}>` : 'pending'}.` });
    } else if (sub === 'list') {
      const rows = await tickets.list(actor, interaction.options.getBoolean('all') ?? false);
      await interaction.editReply({ allowedMentions: safeMentions, content: rows.length ? rows.map((row: Ticket) => `#${row.id} ${row.type} ${row.status}`).join('\n') : 'No tickets found.' });
    } else if (sub === 'config') {
      const role = interaction.options.getRole('staff-role');
      const channel = interaction.options.getChannel('transcript-channel');
      const maximum = interaction.options.getInteger('max-active');
      const settings = role || channel || maximum !== null
        ? await tickets.configure(actor, { ...(role ? { staffRoleId: role.id } : {}), ...(channel ? { transcriptChannelId: channel.id } : {}), ...(maximum !== null ? { maxActiveTickets: maximum } : {}) })
        : (await tickets.settings(actor)).setting;
      await interaction.editReply({ allowedMentions: safeMentions, content: `Ticket staff role: ${settings?.staffRoleId ?? 'unset'}; max active: ${settings?.maxActiveTickets ?? 'unset'}; transcript channel: ${settings?.transcriptChannelId ?? 'unset'}. Configure ticket category with guild settings.` });
    }
  },
};
export const ticketCommands = [ticketCommand];
