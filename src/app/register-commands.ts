import { REST, Routes } from 'discord.js';
import { loadEnv } from '../core/config/env.js';
import { createLogger } from '../core/logger/logger.js';
import { buildRegistry, manifests } from './registry.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
const body = [...buildRegistry(manifests).commands.values()].map(command => command.data.toJSON());
const route = env.DISCORD_DEV_GUILD_ID
  ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_DEV_GUILD_ID)
  : Routes.applicationCommands(env.DISCORD_CLIENT_ID);
try {
  await rest.put(route, { body });
  logger.info({ count: body.length, scope: env.DISCORD_DEV_GUILD_ID ? 'guild' : 'global' }, 'Slash commands registered');
} catch (error) {
  logger.error({ err: error }, 'Command registration failed');
  process.exitCode = 1;
}
