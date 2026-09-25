import { Events, type GuildMember, type GuildChannel, type Message, type VoiceState } from 'discord.js';
import type { BotEvent } from '../../core/events/event.js';
import type { LogCategory, LogField } from './guild-log-service.js';

function guildId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  if ('guildId' in value && typeof value.guildId === 'string') return value.guildId;
  if ('guild' in value && value.guild && typeof value.guild === 'object' && 'id' in value.guild && typeof value.guild.id === 'string') return value.guild.id;
  return null;
}
const id = (name: string, value: string): LogField => ({ name, value });
const label = (value: string | null | undefined) => value || 'None';

/** Optional module adapters; the dispatcher gates every event on moduleKey. */
export const loggingEvents: BotEvent[] = [
  {
    name: Events.GuildMemberAdd, moduleKey: 'logging', guildId,
    async handle(services, value) {
      const member = value as GuildMember;
      await services.guildLogs.send(member.guild.id, 'general', 'Member joined', [], { targetId: member.id });
    },
  },
  {
    name: Events.GuildMemberRemove, moduleKey: 'logging', guildId,
    async handle(services, value) {
      const member = value as GuildMember;
      await services.guildLogs.send(member.guild.id, 'general', 'Member left', [], { targetId: member.id });
    },
  },
  {
    name: Events.GuildMemberUpdate, moduleKey: 'logging', guildId,
    async handle(services, before, after) {
      const oldMember = before as GuildMember;
      const member = after as GuildMember;
      const fields: LogField[] = [];
      if (oldMember.nickname !== member.nickname) {
        fields.push(id('Previous nickname', label(oldMember.nickname)), id('New nickname', label(member.nickname)));
      }
      const oldRoles = new Set(oldMember.roles.cache.keys());
      const newRoles = new Set(member.roles.cache.keys());
      const added = [...newRoles].filter(role => !oldRoles.has(role));
      const removed = [...oldRoles].filter(role => !newRoles.has(role));
      if (added.length) fields.push(id('Role IDs added', added.join(', ')));
      if (removed.length) fields.push(id('Role IDs removed', removed.join(', ')));
      if (fields.length) await services.guildLogs.send(member.guild.id, 'moderation', 'Member updated', fields, { targetId: member.id });
    },
  },
  {
    name: Events.ChannelCreate, moduleKey: 'logging', guildId,
    async handle(services, value) {
      const channel = value as GuildChannel;
      await services.guildLogs.send(channel.guildId, 'general', 'Channel created', [id('Channel ID', channel.id), id('Name', channel.name)]);
    },
  },
  {
    name: Events.ChannelDelete, moduleKey: 'logging', guildId,
    async handle(services, value) {
      const channel = value as GuildChannel;
      await services.guildLogs.send(channel.guildId, 'general', 'Channel deleted', [id('Channel ID', channel.id), id('Name', channel.name)]);
    },
  },
  {
    name: Events.ChannelUpdate, moduleKey: 'logging', guildId,
    async handle(services, before, after) {
      const oldChannel = before as GuildChannel;
      const channel = after as GuildChannel;
      const fields: LogField[] = [];
      if (oldChannel.name !== channel.name) fields.push(id('Previous name', oldChannel.name), id('New name', channel.name));
      if (oldChannel.type !== channel.type) fields.push(id('Previous type', String(oldChannel.type)), id('New type', String(channel.type)));
      // Do not include channel topics, permission overwrites or other potentially sensitive data.
      if (fields.length) await services.guildLogs.send(channel.guildId, 'general', 'Channel updated', [id('Channel ID', channel.id), ...fields]);
    },
  },
  {
    name: Events.VoiceStateUpdate, moduleKey: 'logging', guildId,
    async handle(services, before, after) {
      const oldState = before as VoiceState;
      const state = after as VoiceState;
      if (oldState.channelId === state.channelId) return;
      const title = !oldState.channelId ? 'Voice joined' : !state.channelId ? 'Voice left' : 'Voice moved';
      await services.guildLogs.send(state.guild.id, 'general', title, [
        id('Previous channel ID', label(oldState.channelId)), id('New channel ID', label(state.channelId)),
      ], { targetId: state.id });
    },
  },
  {
    name: Events.MessageDelete, moduleKey: 'logging', guildId,
    async handle(services, value) {
      const message = value as Message;
      if (!message.guildId) return;
      await services.guildLogs.send(message.guildId, 'general', 'Message deleted', [
        id('Channel ID', message.channelId), id('Message ID', message.id),
      ], { targetId: message.author?.id });
    },
  },
  {
    name: Events.MessageUpdate, moduleKey: 'logging', guildId: (_before, after) => guildId(after),
    async handle(services, _before, after) {
      const message = after as Message;
      if (!message.guildId) return;
      // Partial messages can lack content or author. Never fetch or expose original/new text.
      await services.guildLogs.send(message.guildId, 'general', 'Message edited', [
        id('Channel ID', message.channelId), id('Message ID', message.id),
      ], { targetId: message.author?.id });
    },
  },
];
