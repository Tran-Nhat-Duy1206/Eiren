import { ChannelType, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';
import { parseEventTime } from './service.js';
import type { Actor } from '../../core/permissions/permission-service.js';
import type { Services } from '../../app/services.js';
import type { CommunityEvent } from './repository.js';

export function eventListContent(rows: readonly CommunityEvent[]) {
  if (!rows.length) return 'No events found.';
  // Twenty records must fit in one Discord reply even when titles are maximal.
  return rows.map(row => {
    const clean = row.title.replace(/\s+/g, ' ').trim();
    const title = clean.length > 32 ? `${clean.slice(0, 31)}…` : clean;
    return `#${row.id} ${title} · ${row.status} · <t:${Math.floor(row.startAt.getTime() / 1000)}:f>`;
  }).join('\n');
}

export function eventViewContent(row: CommunityEvent, participants: number) {
  const header = `Event #${row.id} · ${row.status}: ${row.title}\nStarts <t:${Math.floor(row.startAt.getTime() / 1000)}:F> · ${participants}${row.maxParticipants ? `/${row.maxParticipants}` : ''} attending${row.endAt ? `\nEnds <t:${Math.floor(row.endAt.getTime() / 1000)}:F>` : ''}\n`;
  const description = row.description || '';
  const budget = 2000 - header.length;
  if (budget < 1) throw new AppError('VALIDATION', 'Event summary exceeds Discord message limits.');
  return header + (description.length > budget ? `${description.slice(0, budget - 1)}…` : description);
}

export const eventCommands: Command[] = [{
  data: new SlashCommandBuilder().setName('event').setDescription('Community events')
    .addSubcommand(s => s.setName('create').setDescription('Schedule an event')
      .addStringOption(o => o.setName('title').setDescription('Event title').setRequired(true).setMaxLength(256))
      .addStringOption(o => o.setName('start').setDescription('ISO timestamp including Z or timezone offset').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Announcement channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addStringOption(o => o.setName('description').setDescription('Description').setMaxLength(2000))
      .addStringOption(o => o.setName('end').setDescription('ISO timestamp including Z or timezone offset'))
      .addIntegerOption(o => o.setName('capacity').setDescription('Maximum attendees').setMinValue(1).setMaxValue(10000)))
    .addSubcommand(s => s.setName('edit').setDescription('Edit a scheduled event')
      .addIntegerOption(o => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('title').setDescription('New title').setMaxLength(256))
      .addStringOption(o => o.setName('description').setDescription('New description').setMaxLength(2000))
      .addStringOption(o => o.setName('start').setDescription('ISO timestamp with timezone'))
      .addStringOption(o => o.setName('end').setDescription('ISO timestamp with timezone'))
      .addIntegerOption(o => o.setName('capacity').setDescription('Maximum attendees').setMinValue(1).setMaxValue(10000)))
    .addSubcommand(s => s.setName('view').setDescription('View event').addIntegerOption(o => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('list').setDescription('List events'))
    .addSubcommand(s => s.setName('join').setDescription('Join event').addIntegerOption(o => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('leave').setDescription('Leave event').addIntegerOption(o => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('start').setDescription('Start event').addIntegerOption(o => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('close').setDescription('Close event').addIntegerOption(o => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('cancel').setDescription('Cancel event').addIntegerOption(o => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('attendance').setDescription('Mark attendance for an RSVP after event starts')
      .addIntegerOption(o => o.setName('id').setDescription('Event ID').setRequired(true).setMinValue(1))
      .addUserOption(o => o.setName('user').setDescription('Attendee').setRequired(true))),
  moduleKey: 'events',
  requiredLevel: interaction => ['create', 'edit', 'start', 'close', 'cancel', 'attendance'].includes(interaction.options.getSubcommand()) ? 'HELPER' : 'MEMBER',
  async execute(interaction, services: Services) {
    const sub = interaction.options.getSubcommand();
    const id = interaction.options.getInteger('id')!;
    const guildId = interaction.guildId!;
    let message: string;
    if (sub === 'view') {
      const { row, participants } = await services.events.view(guildId, id);
      message = eventViewContent(row, participants);
    } else if (sub === 'list') {
      const rows = await services.events.list(guildId);
      message = eventListContent(rows);
    } else if (sub === 'join' || sub === 'leave') {
      const changed = await services.events[sub](guildId, id, interaction.user.id, interaction.user.bot);
      message = changed ? `Event #${id}: ${sub === 'join' ? 'joined' : 'left'}.` : 'No change.';
    } else {
      if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const actor: Actor = { guildId, userId: interaction.user.id, guildOwnerId: interaction.guild.ownerId, roleIds: [...member.roles.cache.keys()] };
      if (sub === 'create') {
        const row = await services.events.create(actor, { title: interaction.options.getString('title', true),
          description: interaction.options.getString('description') ?? '', startAt: parseEventTime(interaction.options.getString('start', true)),
          endAt: interaction.options.getString('end') ? parseEventTime(interaction.options.getString('end', true)) : null,
          maxParticipants: interaction.options.getInteger('capacity'), channelId: interaction.options.getChannel('channel', true).id });
        message = `Event #${row.id} scheduled.`;
      } else if (sub === 'edit') {
        const changes = { title: interaction.options.getString('title') ?? undefined, description: interaction.options.getString('description') ?? undefined,
          startAt: interaction.options.getString('start') ? parseEventTime(interaction.options.getString('start', true)) : undefined,
          endAt: interaction.options.getString('end') ? parseEventTime(interaction.options.getString('end', true)) : undefined,
          maxParticipants: interaction.options.getInteger('capacity') ?? undefined };
        if (Object.values(changes).every(v => v === undefined)) throw new AppError('VALIDATION', 'Supply a field to edit.');
        await services.events.edit(actor, id, changes); message = `Event #${id} updated.`;
      } else if (sub === 'attendance') {
        const user = interaction.options.getUser('user', true);
        const changed = await services.events.attend(actor, id, user.id, user.bot);
        message = changed ? 'Attendance recorded.' : 'Attendance was already recorded.';
      } else {
        await services.events.transition(actor, id, sub as 'start' | 'close' | 'cancel');
        message = `Event #${id} ${sub === 'start' ? 'started' : sub === 'close' ? 'closed' : 'cancelled'}.`;
      }
    }
    await interaction.editReply({ content: message.slice(0, 2000), allowedMentions: { parse: [] } });
  },
}];
