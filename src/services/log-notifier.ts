import type { ModuleService } from './module-service.js';
import type { GuildLogService, LogCategory, LogField, LogMetadata } from '../modules/logging/guild-log-service.js';

export type GuildLogNotifier = (guildId: string, category: LogCategory, title: string,
  fields?: readonly LogField[], metadata?: LogMetadata) => Promise<void>;

/** Routes module events through the optional logging module without ever failing the caller. */
export function createGuildLogNotifier(
  modules: Pick<ModuleService, 'isEnabled'>,
  logs: Pick<GuildLogService, 'send'>,
): GuildLogNotifier {
  return async (guildId, category, title, fields = [], metadata = {}) => {
    try {
      if (!await modules.isEnabled(guildId, 'logging')) return;
      await logs.send(guildId, category, title, fields, metadata);
    } catch {
      // A logging failure must never break a moderation or verification action.
    }
  };
}
