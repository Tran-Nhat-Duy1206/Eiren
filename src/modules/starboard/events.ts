import { Events, type GuildChannel, type Message, type MessageReaction } from 'discord.js';
import type { BotEvent } from '../../core/events/event.js';

function guild(value: unknown) { return (value as { guildId?: string } | undefined)?.guildId ?? null; }
async function reaction(services: Parameters<BotEvent['handle']>[0], value: unknown) {
  let reaction = value as MessageReaction;
  if (reaction.partial) reaction = await reaction.fetch();
  const message = reaction.message;
  if (!message.guildId || !message.channelId) return;
  await services.starboard.reconcile(message.guildId, message.channelId, message.id);
}
export const starboardEvents: BotEvent[] = [
  { name: Events.MessageReactionAdd, moduleKey: 'starboard', guildId: value => guild((value as MessageReaction | undefined)?.message), handle: reaction },
  { name: Events.MessageReactionRemove, moduleKey: 'starboard', guildId: value => guild((value as MessageReaction | undefined)?.message), handle: reaction },
  { name: Events.MessageUpdate, moduleKey: 'starboard', guildId: (_old, current) => guild(current),
    async handle(services, _old, current) { const message = current as Message; if (message.guildId) await services.starboard.reconcile(message.guildId, message.channelId, message.id); } },
  { name: Events.MessageDelete, moduleKey: 'starboard', guildId: guild,
    async handle(services, value) { const message = value as Message; if (message.guildId) await services.starboard.reconcile(message.guildId, message.channelId, message.id, true); } },
  { name: Events.ChannelDelete, moduleKey: 'starboard', guildId: guild,
    async handle(services, value) { const channel = value as GuildChannel; if (channel.guildId) await services.starboard.sourceChannelDeleted(channel.guildId, channel.id); } },
];
