import { Events, type Message } from 'discord.js';
import type { BotEvent } from '../../core/events/event.js';

export const levelsEvents: BotEvent[] = [{
  name: Events.MessageCreate, moduleKey: 'levels',
  guildId: value => (value as Message | undefined)?.guildId ?? null,
  async handle(services, value) {
    const message = value as Message;
    if (!message?.guildId || !message.author || message.author.bot || message.system || message.webhookId) return;
    await services.levels.handleMessage({ guildId: message.guildId, userId: message.author.id,
      channelId: message.channelId, messageId: message.id, at: message.createdTimestamp,
      content: message.content, bot: message.author.bot, system: message.system, webhookId: message.webhookId });
  },
}];
