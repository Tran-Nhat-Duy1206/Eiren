import type { Client, ClientEvents } from 'discord.js';
import type { Services } from '../../app/services.js';

export interface BotEvent {
  name: keyof ClientEvents;
  moduleKey: string;
  /** Handler's first async gate must reserve/check this module in PostgreSQL; no dispatcher precheck. */
  databaseGatedAtIngress?: boolean;
  // Events without a guild are handled only by permanently enabled core events.
  guildId(...args: unknown[]): string | null;
  handle(services: Services, ...args: unknown[]): Promise<void>;
}

export function registerEvents(client: Client, events: readonly BotEvent[], services: Services) {
  for (const event of events) {
    client.on(event.name, (...args) => {
      void dispatchEvent(event, services, ...args);
    });
  }
}
export async function dispatchEvent(event: BotEvent, services: Services, ...args: unknown[]) {
  let guildId: string | null = null;
  try {
    guildId = event.guildId(...args);
    if (event.moduleKey !== 'core' && !event.databaseGatedAtIngress &&
      (!guildId || !await services.modules.isEnabled(guildId, event.moduleKey))) return;
    await event.handle(services, ...args);
  } catch (error) {
    services.logger.error({ err: error, module: event.moduleKey, event: event.name, guildId }, 'Event failed');
  }
}
