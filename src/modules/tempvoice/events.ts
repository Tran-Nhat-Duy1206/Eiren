import { Events, type GuildChannel, type VoiceState } from 'discord.js';
import type { BotEvent } from '../../core/events/event.js';

export const tempvoiceEvents: BotEvent[] = [
  { name: Events.VoiceStateUpdate, moduleKey: 'tempvoice', guildId: (_old, current) => (current as VoiceState).guild.id,
    async handle(services, before, after) {
      const oldState = before as VoiceState; const state = after as VoiceState;
      if (state.member?.user.bot || oldState.channelId === state.channelId) return;
      await services.tempvoice.voiceChanged(state.guild.id, state.id, oldState.channelId, state.channelId);
    } },
  { name: Events.ChannelDelete, moduleKey: 'tempvoice', guildId: value => (value as GuildChannel).guildId,
    async handle(services, value) { const channel = value as GuildChannel; await services.tempvoice.channelDeleted(channel.guildId, channel.id); } },
];
