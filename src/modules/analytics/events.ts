import { Events, type GuildMember, type Message, type VoiceState } from 'discord.js';
import type { BotEvent } from '../../core/events/event.js';

export const analyticsEvents: BotEvent[] = [
  { name: Events.MessageCreate, moduleKey: 'analytics', databaseGatedAtIngress: true,
    guildId: value => (value as Message | undefined)?.guildId ?? null,
    async handle(services, value) {
      const message = value as Message;
      if (!message?.guildId || !message.author || message.author.bot || message.system || message.webhookId) return;
      const reservation = await services.analytics.reserveIngestion(message.guildId);
      if (!reservation) return;
      await services.analytics.recordMessage(reservation, message.id, message.channelId, message.createdAt,
        message.author.bot, message.system, Boolean(message.webhookId));
    } },
  ...([Events.GuildMemberAdd, Events.GuildMemberRemove] as const).map(name => ({
    name, moduleKey: 'analytics', databaseGatedAtIngress: true,
    guildId: (value: unknown) => (value as GuildMember | undefined)?.guild?.id ?? null,
    async handle(services: Parameters<BotEvent['handle']>[0], value: unknown) {
      const member = value as GuildMember;
      if (!member?.guild?.id || !member.user || member.user.bot) return;
      const observedAt = new Date();
      const reservation = await services.analytics.reserveIngestion(member.guild.id);
      if (!reservation) return;
      await services.analytics.recordMember(reservation, member.id, name === Events.GuildMemberAdd, observedAt);
    },
  })),
  // Every analytics gateway collector reserves under the DB module lock before other awaits.
  // Voice additionally fences each user's pending state before identity classification.
  { name: Events.VoiceStateUpdate, moduleKey: 'analytics', databaseGatedAtIngress: true,
    guildId: value => (value as VoiceState | undefined)?.guild?.id ?? null,
    async handle(services, before, after) {
      const previous = before as VoiceState;
      const next = after as VoiceState;
      if (!next?.guild?.id || !next.id) return;
      const channelId = next.channelId === next.guild.afkChannelId ? null : next.channelId;
      if ((previous?.channelId === next.guild.afkChannelId ? null : previous?.channelId) === channelId) return;
      let member = next.member ?? previous?.member;
      if (member?.user.bot) return;
      const observedAt = new Date();
      const reservation = await services.analytics.reserveVoiceObservation(next.guild.id, next.id, observedAt);
      if (!reservation) return;
      if (!member) {
        try { member = await next.guild.members.fetch({ user: next.id, force: true }); }
        catch { await services.analytics.finalizeVoiceObservation(reservation, null); return; }
      }
      // Unknown and bot identities are disconnected no-credit fences, not participants.
      await services.analytics.finalizeVoiceObservation(reservation, member && !member.user.bot ? channelId : null);
    } },
];
