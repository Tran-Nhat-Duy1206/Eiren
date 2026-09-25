import { Events } from 'discord.js';
import type { BotEvent } from '../../core/events/event.js';

export const coreEvents: BotEvent[] = [{
  name: Events.ClientReady, moduleKey: 'core', guildId: () => null,
  async handle(services, client) {
    services.logger.info({ botId: (client as { user: { id: string } }).user.id }, 'Discord gateway ready');
  },
}];
