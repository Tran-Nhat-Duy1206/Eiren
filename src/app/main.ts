import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { guilds, moderationCases, moderatorNotes, verificationSettings, memberVerifications, antiraidSettings, joinHistory } from '../core/database/schema.js';
import { createLogger } from '../core/logger/logger.js';
import { registerCommands } from '../core/commands/dispatcher.js';
import { registerComponents } from '../core/components/component.js';
import { registerEvents } from '../core/events/event.js';
import { PermissionService } from '../core/permissions/permission-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { GuildConfigService } from '../services/guild-config-service.js';
import { createGuildLogNotifier } from '../services/log-notifier.js';
import { ModuleService } from '../services/module-service.js';
import { buildRegistry, manifests } from './registry.js';
import { createBotLifecycle } from './lifecycle.js';
import { GuildLogService } from '../modules/logging/guild-log-service.js';
import { AntiRaidRepository } from '../modules/antiraid/repository.js';
import { AntiRaidService } from '../modules/antiraid/service.js';
import { ModerationRepository } from '../modules/moderation/repository.js';
import { ModerationService } from '../modules/moderation/service.js';
import { DiscordModerationGateway } from '../modules/moderation/discord-gateway.js';
import { ModerationScheduler } from '../modules/moderation/scheduler.js';
import { DiscordVerificationGateway } from '../modules/verification/discord-gateway.js';
import { VerificationRepository } from '../modules/verification/repository.js';
import { VerificationService } from '../modules/verification/service.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const { db, pool } = createDatabase(env.DATABASE_URL);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildModeration,
    ...(env.ENABLE_GUILD_MEMBERS_INTENT ? [GatewayIntentBits.GuildMembers] : [])],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});
const repository = new GuildRepository(db);
const registry = buildRegistry(manifests);
const guildConfig = new GuildConfigService(repository);
const permissions = new PermissionService(repository);
const modules = new ModuleService(repository, registry.definitions,
  env.ENABLE_GUILD_MEMBERS_INTENT ? new Set() : new Set(['logging', 'verification', 'antiraid']));
const guildLogs = new GuildLogService(client, guildConfig, logger);
const moderation = new ModerationService(new ModerationRepository(db), permissions, logger, async record => {
  if (await modules.isEnabled(record.guildId, 'logging')) {
    await guildLogs.send(record.guildId, 'moderation', `Case #${record.id}: ${record.action}`, [
      { name: 'Target ID', value: record.targetId },
      { name: 'Moderator ID', value: record.moderatorId },
      { name: 'Reason', value: record.reason },
    ]);
  }
});
const notifier = createGuildLogNotifier(modules, guildLogs);
const verificationGatewayForGuild = async (guildId: string) => {
  const guild = await client.guilds.fetch(guildId);
  if (!client.user) throw new Error('Bot not logged in');
  return new DiscordVerificationGateway(guild, client.user.id);
};
const antiRaidRepository = new AntiRaidRepository(db);
const verification = new VerificationService(new VerificationRepository(db), permissions, logger,
  verificationGatewayForGuild, notifier, async guildId => {
    if (!await modules.isEnabled(guildId, 'antiraid')) return false;
    const settings = await antiRaidRepository.getSettings(guildId);
    return settings?.enabled === true && settings.emergencyMode;
  });
const antiraid = new AntiRaidService(antiRaidRepository, permissions, logger, notifier,
  verification, { sendTo: (guildId, channelId, category, title, fields) => guildLogs.sendTo(guildId, channelId, category, title, fields) },
  undefined, async guildId => {
    if (!await modules.isEnabled(guildId, 'logging')) return false;
    const settings = await guildConfig.get(guildId);
    return Boolean(settings?.securityLogChannelId);
  });
const services = { logger, repository, guildConfig, permissions, modules, guildLogs, moderation, verification, antiraid };
const scheduler = new ModerationScheduler(moderation, async guildId => {
  const guild = await client.guilds.fetch(guildId);
  if (!client.user) throw new Error('Bot not logged in');
  return new DiscordModerationGateway(guild, client.user.id);
}, logger);
let retentionTimer: NodeJS.Timeout | undefined;
async function pruneHistory() {
  try { await antiRaidRepository.pruneExpired(); }
  catch (error) { logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Anti-raid history pruning failed'); }
}
const lifecycle = createBotLifecycle({
  async probe() {
    // Verify both connectivity and migrations before connecting to Discord.
    await db.select({ id: guilds.id }).from(guilds).limit(1);
    await db.select({ id: moderationCases.id }).from(moderationCases).limit(1);
    await db.select({ id: moderatorNotes.id }).from(moderatorNotes).limit(1);
    await db.select({ id: verificationSettings.guildId }).from(verificationSettings).limit(1);
    await db.select({ id: memberVerifications.id }).from(memberVerifications).limit(1);
    await db.select({ id: antiraidSettings.guildId }).from(antiraidSettings).limit(1);
    await db.select({ id: joinHistory.id }).from(joinHistory).limit(1);
  },
  register() {
    registerCommands(client, registry.commands, services);
    registerEvents(client, registry.events, services);
    registerComponents(client, registry.components, services);
    client.once(Events.ClientReady, () => {
      scheduler.start();
      void pruneHistory();
      retentionTimer = setInterval(() => { void pruneHistory(); }, 60 * 60_000);
      retentionTimer.unref();
    });
  },
  login: () => client.login(env.DISCORD_TOKEN),
  destroy: () => client.destroy(),
  closeDatabase: async () => { if (retentionTimer) clearInterval(retentionTimer); await scheduler.stop(); await pool.end(); },
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
