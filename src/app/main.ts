import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { guilds, moderationCases, moderatorNotes, verificationSettings, memberVerifications, antiraidSettings, joinHistory,
  roleMenus, roleMenuOptions, ticketSettings, tickets as ticketRows, ticketParticipants, reports as reportRows, appeals,
  suggestionSettings, suggestions as suggestionRows, suggestionVotes,
  levelsSettings, memberLevels, levelRewards, levelIgnoredChannels, reputationSettings, memberReputation,
  reputationGrants, starboardSettings, starboardMessages, starboardIgnoredChannels,
  communityEvents, eventParticipants, eventAttendance, eventReminders, giveaways as giveawayRows,
  giveawayEntries, giveawayDraws, giveawayWinners, tempvoiceSettings, tempvoiceRooms, memberAchievements,
  analyticsSettings, analyticsGuildHourly, analyticsChannelHourly, analyticsCommandHourly, analyticsEventDedupe,
  analyticsMemberState, analyticsActiveVoiceSessions, dashboardSessions, dashboardAuditLog } from '../core/database/schema.js';
import { createLogger } from '../core/logger/logger.js';
import { registerCommands } from '../core/commands/dispatcher.js';
import { registerComponents, registerSelects } from '../core/components/component.js';
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
import { RoleMenuRepository } from '../modules/roles/repository.js';
import { RoleMenuService } from '../modules/roles/service.js';
import { TicketRepository } from '../modules/tickets/repository.js';
import { TicketService } from '../modules/tickets/service.js';
import { DiscordTicketGateway } from '../modules/tickets/discord-gateway.js';
import { ReportRepository } from '../modules/reports/repository.js';
import { ReportService } from '../modules/reports/service.js';
import { SuggestionRepository } from '../modules/suggestions/repository.js';
import { SuggestionService } from '../modules/suggestions/service.js';
import { DiscordSuggestionGateway } from '../modules/suggestions/discord-gateway.js';
import { LevelsRepository } from '../modules/levels/repository.js';
import { LevelsService } from '../modules/levels/service.js';
import { ReputationRepository } from '../modules/reputation/repository.js';
import { ReputationService } from '../modules/reputation/service.js';
import { StarboardRepository } from '../modules/starboard/repository.js';
import { StarboardService } from '../modules/starboard/service.js';
import { DiscordStarboardGateway } from '../modules/starboard/discord-gateway.js';
import { ProfileService } from '../modules/profiles/service.js';
import { EventRepository } from '../modules/events/repository.js';
import { EventService } from '../modules/events/service.js';
import { DiscordEventGateway } from '../modules/events/discord-gateway.js';
import { GiveawayRepository } from '../modules/giveaways/repository.js';
import { GiveawayService } from '../modules/giveaways/service.js';
import { DiscordGiveawayGateway } from '../modules/giveaways/discord-gateway.js';
import { TempvoiceRepository } from '../modules/tempvoice/repository.js';
import { TempvoiceService } from '../modules/tempvoice/service.js';
import { DiscordTempvoiceGateway } from '../modules/tempvoice/discord-gateway.js';
import { AchievementRepository } from '../modules/achievements/repository.js';
import { AchievementsService } from '../modules/achievements/service.js';
import { V5Scheduler, ScheduledStageError } from './v5-scheduler.js';
import { AnalyticsMaintenanceError, AnalyticsRepository } from '../modules/analytics/repository.js';
import { AnalyticsService } from '../modules/analytics/service.js';
import { observedHumanVoice } from '../modules/analytics/voice-snapshot.js';
import { DashboardAuth } from '../dashboard/auth/dashboard-auth.js';
import { DashboardAccess } from '../dashboard/access/dashboard-access.js';
import { DashboardAudit } from '../dashboard/access/dashboard-audit.js';
import { DashboardReadService } from '../dashboard/data/dashboard-read-service.js';
import { createDashboardServer } from '../dashboard/web.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const { db, pool } = createDatabase(env.DATABASE_URL);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildModeration,
    ...(env.ENABLE_GUILD_MEMBERS_INTENT ? [GatewayIntentBits.GuildMembers] : [])],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.Reaction, Partials.User],
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
const roles = new RoleMenuService(new RoleMenuRepository(db), client, notifier);
const tickets = new TicketService(new TicketRepository(db), permissions, logger,
  async guildId => new DiscordTicketGateway(await client.guilds.fetch(guildId)), notifier);
const reports = new ReportService(new ReportRepository(db), permissions, notifier);
const suggestions = new SuggestionService(new SuggestionRepository(db), permissions,
  async guildId => new DiscordSuggestionGateway(await client.guilds.fetch(guildId)), logger, { send: notifier });
const levelsRepository = new LevelsRepository(db);
const reputationRepository = new ReputationRepository(db);
const achievements = new AchievementsService(new AchievementRepository(db), modules, {
  level: levelsRepository, reputation: reputationRepository,
  eventJoin: async (guildId, userId) => Boolean((await db.select({ userId: eventParticipants.userId }).from(eventParticipants)
    .innerJoin(communityEvents, eq(eventParticipants.eventId, communityEvents.id))
    .where(and(eq(communityEvents.guildId, guildId), eq(eventParticipants.userId, userId))).limit(1))[0]),
  eventAttend: async (guildId, userId) => Boolean((await db.select({ userId: eventAttendance.userId }).from(eventAttendance)
    .innerJoin(communityEvents, eq(eventAttendance.eventId, communityEvents.id))
    .where(and(eq(communityEvents.guildId, guildId), eq(eventAttendance.userId, userId))).limit(1))[0]),
  giveawayWin: async (guildId, userId) => Boolean((await db.select({ userId: giveawayWinners.userId }).from(giveawayWinners)
    .innerJoin(giveawayRows, eq(giveawayWinners.giveawayId, giveawayRows.id))
    .where(and(eq(giveawayRows.guildId, guildId), eq(giveawayWinners.userId, userId))).limit(1))[0]),
});
async function achievementHook(guildId: string, userId: string, work: () => Promise<unknown>) {
  try { await work(); }
  catch (error) { logger.error({ guildId, userId, errorType: error instanceof Error ? error.name : 'unknown' },
    'Optional achievement evaluation failed after domain state committed'); }
}
const levels = new LevelsService(levelsRepository, client, notifier,
  (guildId, userId, level, messageCount) => achievementHook(guildId, userId,
    () => achievements.onLevel(guildId, userId, level, messageCount)));
const reputation = new ReputationService(reputationRepository, permissions, client, 3600,
  (guildId, userId, score) => achievementHook(guildId, userId,
    () => achievements.onReputation(guildId, userId, score)));
const starboard = new StarboardService(new StarboardRepository(db), permissions,
  async guildId => new DiscordStarboardGateway(await client.guilds.fetch(guildId)), logger);
const profiles = new ProfileService(modules, (guildId, userId) => levels.rank(guildId, userId),
  (guildId, userId) => reputation.score(guildId, userId));
const events = new EventService(new EventRepository(db), permissions,
  async guildId => new DiscordEventGateway(await client.guilds.fetch(guildId)), logger, {
    onJoined: (guildId, userId) => achievementHook(guildId, userId, () => achievements.onEventJoin(guildId, userId)),
    onAttended: (guildId, userId) => achievementHook(guildId, userId, () => achievements.onEventAttend(guildId, userId)),
  }, guildId => modules.isEnabled(guildId, 'events'));
const giveaways = new GiveawayService(new GiveawayRepository(db), permissions, modules,
  async guildId => new DiscordGiveawayGateway(client, guildId), logger,
  (guildId, userId) => achievementHook(guildId, userId, () => achievements.onGiveawayWin(guildId, userId)));
const tempvoice = new TempvoiceService(new TempvoiceRepository(db), permissions, logger,
  async guildId => new DiscordTempvoiceGateway(await client.guilds.fetch(guildId)));
const analytics = new AnalyticsService(new AnalyticsRepository(db), permissions, modules);
const dashboardAuth = env.DASHBOARD && new DashboardAuth(db, {
  baseUrl: env.DASHBOARD.DASHBOARD_BASE_URL, sessionSecret: env.DASHBOARD.DASHBOARD_SESSION_SECRET,
  discordClientId: env.DISCORD_CLIENT_ID, discordClientSecret: env.DASHBOARD.DISCORD_CLIENT_SECRET,
  secureCookies: new URL(env.DASHBOARD.DASHBOARD_BASE_URL).protocol === 'https:',
});
let dashboard: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
const services = { logger, repository, guildConfig, permissions, modules, guildLogs, moderation, verification, antiraid,
  roles, tickets, reports, suggestions, levels, reputation, starboard, profiles, events, giveaways, tempvoice, achievements, analytics };
const scheduler = new ModerationScheduler(moderation, async guildId => {
  const guild = await client.guilds.fetch(guildId);
  if (!client.user) throw new Error('Bot not logged in');
  return new DiscordModerationGateway(guild, client.user.id);
}, logger);
let analyticsGuildCursor = 0;
let analyticsReady = false;
let analyticsReconcile: Promise<void> | undefined;
const voiceReconciled = new Set<string>();
async function reconcileAnalyticsVoice() {
  try {
    for (const guild of [...client.guilds.cache.values()].slice(0, 5)) {
      try {
        const live = await observedHumanVoice(guild);
        if (live !== null && await modules.isEnabled(guild.id, 'analytics')) {
          await analytics.reconcileVoice(guild.id, live);
          voiceReconciled.add(guild.id);
        } else if (live === null) logger.warn({ guildId: guild.id }, 'Incomplete voice snapshot; analytics recovery deferred');
      } catch (error) { logger.warn({ guildId: guild.id, errorType: error instanceof Error ? error.name : 'unknown' },
        'Voice analytics restart reconciliation failed; stale time is not counted'); }
    }
  } finally { analyticsReady = true; }
}
async function analyticsDue() {
  if (!analyticsReady) return;
  const runStage = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) { throw new ScheduledStageError(error instanceof AnalyticsMaintenanceError ? `${stage}.${error.stage}` : stage, error); }
  };
  await runStage('analytics.runDue', () => analytics.runDue());
  if (dashboardAuth) await runStage('dashboardAuth.cleanupExpired', () => dashboardAuth.cleanupExpired());
  // V5 scheduler bounds the number of guilds sampled per tick; Discord's observed
  // voice-state cache is proof of current presence, never assume stale DB sessions are live.
  const guildList = [...client.guilds.cache.values()];
  if (!guildList.length) return;
  for (let i = 0; i < Math.min(5, guildList.length); i++) {
    const guild = guildList[analyticsGuildCursor++ % guildList.length]!;
    const enabled = await runStage('analytics.moduleCheck', () => modules.isEnabled(guild.id, 'analytics'));
    if (!enabled) continue;
    const live = await runStage('analytics.observedHumanVoice', () => observedHumanVoice(guild));
    if (live === null) continue;
    if (!voiceReconciled.has(guild.id)) {
      await runStage('analytics.reconcileVoice', () => analytics.reconcileVoice(guild.id, live));
      voiceReconciled.add(guild.id);
    } else await runStage('analytics.heartbeat', () => analytics.heartbeat(guild.id, live, new Date(), 1000));
  }
}
const v5Scheduler = new V5Scheduler([
  { name: 'events', runDue: async () => { await events.runDue(); } },
  { name: 'giveaways', runDue: async () => { await giveaways.runDue(); } },
  { name: 'tempvoice', runDue: async () => { await tempvoice.runDue(); } },
  { name: 'analytics', runDue: analyticsDue },
], logger);
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
    await db.select({ id: roleMenus.id }).from(roleMenus).limit(1);
    await db.select({ id: roleMenuOptions.id }).from(roleMenuOptions).limit(1);
    await db.select({ id: ticketSettings.guildId }).from(ticketSettings).limit(1);
    await db.select({ id: ticketRows.id }).from(ticketRows).limit(1);
    await db.select({ id: ticketParticipants.ticketId }).from(ticketParticipants).limit(1);
    await db.select({ id: reportRows.id }).from(reportRows).limit(1);
    await db.select({ id: appeals.id }).from(appeals).limit(1);
    await db.select({ id: suggestionSettings.guildId }).from(suggestionSettings).limit(1);
    await db.select({ id: suggestionRows.id }).from(suggestionRows).limit(1);
    await db.select({ id: suggestionVotes.suggestionId }).from(suggestionVotes).limit(1);
    await db.select({ id: levelsSettings.guildId }).from(levelsSettings).limit(1);
    await db.select({ id: memberLevels.guildId }).from(memberLevels).limit(1);
    await db.select({ id: levelRewards.guildId }).from(levelRewards).limit(1);
    await db.select({ id: levelIgnoredChannels.guildId }).from(levelIgnoredChannels).limit(1);
    await db.select({ id: reputationSettings.guildId }).from(reputationSettings).limit(1);
    await db.select({ id: memberReputation.guildId }).from(memberReputation).limit(1);
    await db.select({ id: reputationGrants.id }).from(reputationGrants).limit(1);
    await db.select({ id: starboardSettings.guildId }).from(starboardSettings).limit(1);
    await db.select({ id: starboardMessages.id }).from(starboardMessages).limit(1);
    await db.select({ id: starboardIgnoredChannels.guildId }).from(starboardIgnoredChannels).limit(1);
    await db.select({ id: communityEvents.id }).from(communityEvents).limit(1);
    await db.select({ id: eventParticipants.eventId }).from(eventParticipants).limit(1);
    await db.select({ id: eventAttendance.eventId }).from(eventAttendance).limit(1);
    await db.select({ id: eventReminders.eventId }).from(eventReminders).limit(1);
    await db.select({ id: giveawayRows.id }).from(giveawayRows).limit(1);
    await db.select({ id: giveawayEntries.giveawayId }).from(giveawayEntries).limit(1);
    await db.select({ id: giveawayDraws.id }).from(giveawayDraws).limit(1);
    await db.select({ id: giveawayWinners.drawId }).from(giveawayWinners).limit(1);
    await db.select({ id: tempvoiceSettings.guildId }).from(tempvoiceSettings).limit(1);
    await db.select({ id: tempvoiceRooms.id }).from(tempvoiceRooms).limit(1);
    await db.select({ id: memberAchievements.guildId }).from(memberAchievements).limit(1);
    await db.select({ id: analyticsSettings.guildId }).from(analyticsSettings).limit(1);
    await db.select({ id: analyticsGuildHourly.guildId }).from(analyticsGuildHourly).limit(1);
    await db.select({ id: analyticsChannelHourly.guildId }).from(analyticsChannelHourly).limit(1);
    await db.select({ id: analyticsCommandHourly.guildId }).from(analyticsCommandHourly).limit(1);
    await db.select({ id: analyticsEventDedupe.guildId }).from(analyticsEventDedupe).limit(1);
    await db.select({ id: analyticsMemberState.guildId }).from(analyticsMemberState).limit(1);
    await db.select({ id: analyticsActiveVoiceSessions.guildId }).from(analyticsActiveVoiceSessions).limit(1);
    if (dashboardAuth) {
      await db.select({ id: dashboardSessions.tokenHash }).from(dashboardSessions).limit(1);
      await db.select({ id: dashboardAuditLog.id }).from(dashboardAuditLog).limit(1);
    }
  },
  register() {
    registerCommands(client, registry.commands, services);
    registerEvents(client, registry.events, services);
    registerComponents(client, registry.components, services);
    registerSelects(client, registry.selects, services);
    client.once(Events.ClientReady, () => {
      scheduler.start();
      void tempvoice.reconcileActive().catch(error => logger.error({ errorType: error instanceof Error ? error.name : 'unknown' },
        'Temporary voice startup reconciliation failed'));
      analyticsReconcile = reconcileAnalyticsVoice().catch(error => logger.warn({ errorType: error instanceof Error ? error.name : 'unknown' },
        'Voice analytics startup recovery failed'));
      v5Scheduler.start();
      void pruneHistory();
      retentionTimer = setInterval(() => { void pruneHistory(); }, 60 * 60_000);
      retentionTimer.unref();
    });
  },
  login: async () => {
    await client.login(env.DISCORD_TOKEN);
    if (env.DASHBOARD && dashboardAuth) {
      dashboard = await createDashboardServer({
        client, services, auth: dashboardAuth, access: new DashboardAccess(client, permissions),
        read: new DashboardReadService(db), audit: new DashboardAudit(db), analytics,
        baseUrl: env.DASHBOARD.DASHBOARD_BASE_URL, trustProxy: env.DASHBOARD.DASHBOARD_TRUST_PROXY,
        secureCookies: new URL(env.DASHBOARD.DASHBOARD_BASE_URL).protocol === 'https:', logger,
        moderationGatewayForGuild: async guildId => {
          const guild = await client.guilds.fetch(guildId);
          if (!client.user) throw new Error('Bot is unavailable');
          return new DiscordModerationGateway(guild, client.user.id);
        },
      });
      await dashboard.listen({ host: env.DASHBOARD.DASHBOARD_HOST, port: env.DASHBOARD.DASHBOARD_PORT });
      logger.info({ host: env.DASHBOARD.DASHBOARD_HOST, port: env.DASHBOARD.DASHBOARD_PORT }, 'Dashboard listening');
    }
  },
  destroy: () => client.destroy(),
  closeDatabase: async () => {
    if (retentionTimer) clearInterval(retentionTimer);
    await dashboard?.close();
    await analyticsReconcile;
    await scheduler.stop(); await v5Scheduler.stop(); await pool.end();
  },
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
