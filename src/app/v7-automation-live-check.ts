// Development-only, opt-in live check. Review before running; never run beside the production scheduler.
import { randomUUID } from 'node:crypto';
import { Client, ChannelType, GatewayIntentBits, PermissionFlagsBits, type TextChannel } from 'discord.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { automations, automationActions, automationExecutions, automationExecutionActions,
  automationExecutionAttempts, automationActionRuns, guildModules, guilds } from '../core/database/schema.js';
import { PermissionService, type Actor } from '../core/permissions/permission-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { AutomationRepository } from '../modules/automation/repository.js';
import { AutomationService, type AutomationRuleDraft } from '../modules/automation/service.js';
import { createAutomationDiscordGateway } from '../modules/automation/discord-gateway.js';

function assert(condition: unknown, label: string): asserts condition { if (!condition) throw new Error(label); }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main() {
  // An explicit human-verified scheduler stop is essential: runDue claims globally, not per guild.
  if (process.env.V7_AUTOMATION_LIVE_TEST !== 'private-channel-only' ||
      process.env.V7_AUTOMATION_RUNTIME_STOPPED !== 'true') {
    console.log('SKIPPED: explicit live-test opt-in and stopped-runtime confirmation required'); return;
  }
  const env = loadEnv();
  if (!env.DISCORD_DEV_GUILD_ID) { console.log('SKIPPED: dev guild not configured'); return; }
  const guildId = env.DISCORD_DEV_GUILD_ID;
  const { db, pool } = createDatabase(env.DATABASE_URL);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let channel: TextChannel | undefined;
  let ruleId: number | undefined;
  let executionId: string | undefined;
  let previousModule: typeof guildModules.$inferSelect | undefined;
  let ownerId: string | undefined;
  let changedModule = false;
  let insertedGuild = false;
  let liveRunStarted = false;
  let liveRunVerified = false;
  try {
    // Global guard is stricter than the dev-guild guard because repository.runDue is global.
    const active = await db.select({ id: automations.id }).from(automations)
      .where(and(eq(automations.enabled, true), isNull(automations.deletedAt))).limit(1);
    const unfinished = await db.select({ id: automationExecutions.id }).from(automationExecutions)
      .where(inArray(automationExecutions.status, ['PENDING', 'RUNNING'])).limit(1);
    if (active.length || unfinished.length) { console.log('SKIPPED: existing enabled automation or pending execution'); return; }
    const [guildRow] = await db.select({ id: guilds.id }).from(guilds).where(eq(guilds.id, guildId));
    await client.login(env.DISCORD_TOKEN);
    const guild = await client.guilds.fetch({ guild: guildId, force: true });
    assert(guild.id === guildId, 'Guild mismatch');
    const botId = client.user?.id;
    if (!botId) { console.log('SKIPPED: bot unavailable'); return; }
    const bot = await guild.members.fetch({ user: botId, force: true });
    const owner = await guild.members.fetch({ user: guild.ownerId, force: true });
    ownerId = owner.id;
    if (!bot.permissions.has(PermissionFlagsBits.ManageChannels) ||
        !bot.permissions.has(PermissionFlagsBits.ViewChannel) ||
        !bot.permissions.has(PermissionFlagsBits.SendMessages) || owner.id !== guild.ownerId) {
      console.log('SKIPPED: bot or owner preflight failed'); return;
    }
    const guildRepo = new GuildRepository(db);
    const permissions = new PermissionService(guildRepo);
    const actor: Actor = { guildId, userId: owner.id, guildOwnerId: guild.ownerId, roleIds: [...owner.roles.cache.keys()] };
    await permissions.require(actor, 'ADMIN');
    previousModule = (await db.select().from(guildModules).where(and(eq(guildModules.guildId, guildId),
      eq(guildModules.moduleKey, 'automation'))))[0];
    // Do not alter a module already in use; restore disabled state without rewinding its fencing epoch.
    channel = await guild.channels.create({ name: `v7-private-check-${randomUUID().slice(0, 8)}`,
      type: ChannelType.GuildText, permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: owner.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ], reason: 'Disposable private V7 automation development check' });
    const scoped = await guild.channels.fetch(channel.id, { force: true });
    if (!scoped || scoped.guildId !== guildId || scoped.type !== ChannelType.GuildText ||
        !scoped.permissionOverwrites.cache.get(guild.roles.everyone.id)?.deny.has(PermissionFlagsBits.ViewChannel) ||
        scoped.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ||
        !scoped.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) ||
        !scoped.permissionsFor(owner)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) {
      console.log('SKIPPED: private-channel verification failed'); return;
    }
    // Recheck immediately before enabling dispatch. Never use a global channel lookup.
    if ((await db.select({ id: automations.id }).from(automations).where(and(eq(automations.enabled, true), isNull(automations.deletedAt))).limit(1)).length ||
        (await db.select({ id: automationExecutions.id }).from(automationExecutions).where(inArray(automationExecutions.status, ['PENDING', 'RUNNING'])).limit(1)).length) {
      console.log('SKIPPED: concurrent automation detected'); return;
    }
    if (!guildRow) {
      // The configured dev guild may not yet have been initialized by the bot. Register
      // this *verified* guild only after proving a private target exists; retain this
      // legitimate registration rather than risk cascading any unrelated future data.
      const [created] = await db.insert(guilds).values({ id: guildId }).onConflictDoNothing().returning({ id: guilds.id });
      if (!created) { console.log('SKIPPED: concurrent dev-guild registration'); return; }
      insertedGuild = true;
    }
    if (!previousModule?.enabled) {
      await guildRepo.setModuleState(guildId, 'automation', true, owner.id);
      changedModule = true;
    }
    const repo = new AutomationRepository(db);
    const service = new AutomationService(repo, permissions, async (requestedGuild, userId) => {
      if (requestedGuild !== guildId || userId !== owner.id) return null;
      const fresh = await guild.members.fetch({ user: userId, force: true });
      return { guildId, userId: fresh.id, guildOwnerId: guild.ownerId, roleIds: [...fresh.roles.cache.keys()] };
    }, { debug() {}, error() {} } as never, createAutomationDiscordGateway(client));
    const tag = randomUUID().slice(0, 8);
    const draft: AutomationRuleDraft = { name: `v7-private-${tag}`, timezone: 'UTC', cooldownSeconds: 0,
      config: { schemaVersion: 1, enabled: true,
        trigger: { id: 'SCHEDULED', version: 1, config: { kind: 'daily', time: '23:59', timezone: 'UTC' } },
        actions: [
          { id: 'STATIC_MESSAGE', version: 1, config: { channelId: scoped.id, message: `Private automation check ${tag}: static.` } },
          { id: 'STAFF_LOG', version: 1, config: { channelId: scoped.id, message: `Private automation check ${tag}: staff log.` } },
        ] } };
    const rule = await service.create(actor, draft);
    ruleId = rule.id;
    // Keep scheduling inert: only the explicitly enqueued synthetic execution may dispatch.
    await db.update(automations).set({ nextRunAt: null }).where(and(eq(automations.id, rule.id), eq(automations.guildId, guildId)));
    const execution = await service.createExecution(actor, rule.id, `live:${tag}`);
    executionId = execution.id;
    liveRunStarted = true;
    const first = await service.runDue();
    assert(first.claimed === 1 && first.failures === 0, 'First scheduler tick failed');
    const runs = await db.select().from(automationActionRuns).where(eq(automationActionRuns.executionId, execution.id));
    const ids = runs.map(run => run.discordMessageId);
    assert(runs.length === 2 && runs.every(run => run.status === 'SUCCEEDED' && !!run.discordMessageId) &&
      new Set(ids).size === 2, 'Exactly two successful action receipts required');
    for (const id of ids) {
      const message = await scoped.messages.fetch(id!);
      assert(message.channelId === scoped.id && message.guildId === guildId && message.author.id === botId,
        'Guild-scoped message receipt mismatch');
    }
    await pause(30_100);
    const second = await service.runDue();
    assert(second.claimed === 0 && second.generated === 0 && second.failures === 0, 'Duplicate scheduler dispatch');
    await pause(30_100);
    const third = await service.runDue();
    assert(third.claimed === 0 && third.generated === 0 && third.failures === 0, 'Duplicate scheduler dispatch');
    // Only read the disposable channel; ensure no unrecorded third/fourth message appeared.
    const messages = await scoped.messages.fetch({ limit: 10 });
    assert(messages.size === 2 && ids.every(id => messages.has(id!)), 'Unexpected disposable-channel message count');
    liveRunVerified = true; // Only a fully verified outcome permits deleting disposable evidence.
    console.log(`PASS: two private messages, no duplicates across two 30-second ticks; dev guild newly registered=${insertedGuild}`);
  } catch {
    console.log('SKIPPED/FAILED: prerequisite or check failed; no raw error details logged');
    process.exitCode = 1;
  } finally {
    const preserveEvidence = liveRunStarted && !liveRunVerified;
    let canDeleteChannel = !preserveEvidence && ruleId === undefined;
    if (preserveEvidence) {
      // A late send may still succeed after a timeout. Never erase the private channel,
      // action runs, execution snapshots, receipts or UNCERTAIN evidence on a failed test.
      console.log('MANUAL REVIEW REQUIRED: private channel and synthetic execution retained');
      process.exitCode = 1;
      try { if (ruleId !== undefined) await new AutomationRepository(db).setEnabled(guildId, ruleId, false); }
      catch { console.log('MANUAL REVIEW REQUIRED: failed to disable synthetic rule'); }
    }
    try {
      if (!preserveEvidence && ruleId !== undefined) {
        await db.transaction(async tx => {
          if (executionId) {
            await tx.delete(automationActionRuns).where(eq(automationActionRuns.executionId, executionId));
            await tx.delete(automationExecutionAttempts).where(eq(automationExecutionAttempts.executionId, executionId));
            await tx.delete(automationExecutionActions).where(eq(automationExecutionActions.executionId, executionId));
            await tx.delete(automationExecutions).where(and(eq(automationExecutions.id, executionId), eq(automationExecutions.guildId, guildId)));
          }
          await tx.delete(automationActions).where(eq(automationActions.automationId, ruleId!));
          await tx.delete(automations).where(and(eq(automations.id, ruleId!), eq(automations.guildId, guildId)));
        });
        canDeleteChannel = true;
      }
      if (changedModule) {
        if (previousModule) await new GuildRepository(db).setModuleState(guildId, 'automation', false, ownerId ?? previousModule.updatedBy);
        else await db.delete(guildModules).where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, 'automation')));
      }
    } catch { console.log('CLEANUP FAILED: synthetic database rows/module require manual inspection'); process.exitCode = 1; }
    try { if (canDeleteChannel && channel) await channel.delete('Disposable private V7 automation development check cleanup'); }
    catch { console.log('CLEANUP FAILED: disposable channel requires manual inspection'); process.exitCode = 1; }
    client.destroy();
    await pool.end();
  }
}

void main().catch(() => { console.log('SKIPPED/FAILED: environment or database unavailable'); process.exitCode = 1; });
