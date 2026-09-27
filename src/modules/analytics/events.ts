import { Events, type GuildMember, type Message, type VoiceState } from 'discord.js';
import type { BotEvent } from '../../core/events/event.js';

export const analyticsEvents: BotEvent[] = [
  { name: Events.MessageCreate, moduleKey: 'analytics', guildId: value => (value as Message | undefined)?.guildId ?? null,
    async handle(services, value) {
      const message = value as Message;
      if (!message?.guildId || !message.author || message.author.bot || message.system || message.webhookId) return;
      await services.analytics.recordMessage(message.guildId, message.id, message.channelId, message.createdAt,
        message.author.bot, message.system, Boolean(message.webhookId));
    } },
  ...([Events.GuildMemberAdd, Events.GuildMemberRemove] as const).map(name => ({
    name, moduleKey: 'analytics', guildId: (value: unknown) => (value as GuildMember | undefined)?.guild?.id ?? null,
    async handle(services: Parameters<BotEvent['handle']>[0], value: unknown) {
      const member = value as GuildMember;
      if (!member?.guild?.id || !member.user || member.user.bot) return;
      await services.analytics.recordMember(member.guild.id, member.id, name === Events.GuildMemberAdd, new Date());
    },
  })),
  { name: Events.VoiceStateUpdate, moduleKey: 'analytics', guildId: value => (value as VoiceState | undefined)?.guild?.id ?? null,
    async handle(services, before, after) {
      const previous = before as VoiceState;
      const next = after as VoiceState;
      if (!next?.guild?.id || !next.id) return;
      // Capture ingress before any targeted REST lookup; delayed classification cannot invent later activity.
      const observedAt = new Date();
      let member = next.member ?? previous?.member;
      if (!member) {
        try { member = await next.guild.members.fetch({ user: next.id, force: true }); }
        catch { await services.analytics.fenceUnknownVoice(next.guild.id, next.id, observedAt); return; }
        // Unknown identity is fenced as absent; it is never classified or credited as human.
      }
      if (!member) { await services.analytics.fenceUnknownVoice(next.guild.id, next.id, observedAt); return; }
      if (member.user.bot) return;
      // AFK channel time is not activity; self-muted/deafened humans are still connected.
      const channelId = next.channelId === next.guild.afkChannelId ? null : next.channelId;
      if ((previous.channelId === next.guild.afkChannelId ? null : previous.channelId) === channelId) return;
      await services.analytics.recordVoice(next.guild.id, next.id, channelId, observedAt);
    } },
];
