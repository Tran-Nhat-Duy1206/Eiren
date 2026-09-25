import { Client, GatewayIntentBits } from 'discord.js';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { guilds } from '../core/database/schema.js';
import { createLogger } from '../core/logger/logger.js';
import { registerCommands } from '../core/commands/dispatcher.js';
import { registerEvents } from '../core/events/event.js';
import { PermissionService } from '../core/permissions/permission-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { GuildConfigService } from '../services/guild-config-service.js';
import { ModuleService } from '../services/module-service.js';
import { buildRegistry, manifests } from './registry.js';
import { createBotLifecycle } from './lifecycle.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const { db, pool } = createDatabase(env.DATABASE_URL);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const repository = new GuildRepository(db);
const registry = buildRegistry(manifests);
const services = {
  logger, repository,
  guildConfig: new GuildConfigService(repository),
  permissions: new PermissionService(repository),
  modules: new ModuleService(repository, registry.definitions),
};
const lifecycle = createBotLifecycle({
  async probe() {
    // Verify both connectivity and migrations before connecting to Discord.
    await db.select({ id: guilds.id }).from(guilds).limit(1);
  },
  register() {
    registerCommands(client, registry.commands, services);
    registerEvents(client, registry.events, services);
  },
  login: () => client.login(env.DISCORD_TOKEN),
  destroy: () => client.destroy(),
  closeDatabase: () => pool.end(),
});
async function shutdown() {
  logger.info('Shutting down');
  await lifecycle.shutdown();
  logger.info('Shutdown complete');
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().catch(() => {
      logger.fatal('Shutdown failed');
      process.exitCode = 1;
    });
  });
}
pool.on('error', () => {
  logger.fatal('Unexpected PostgreSQL pool error');
  process.exitCode = 1;
  void shutdown();
});
void lifecycle.start().catch(async error => {
  // Driver and API errors can carry credential-bearing URLs; don't log their raw text.
  logger.fatal({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Startup failed; verify database migrations and Discord credentials');
  process.exitCode = 1;
  await shutdown();
});
