import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { automationActionRuns, automationExecutionActions, automationExecutions, guilds, guildModules } from '../core/database/schema.js';
import { PermissionService, type Actor } from '../core/permissions/permission-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { AutomationRepository } from '../modules/automation/repository.js';
import { AutomationService, type AutomationRuleDraft } from '../modules/automation/service.js';
import type { AutomationDiscordGateway } from '../modules/automation/discord-gateway.js';

const connection = createDatabase(loadEnv().DATABASE_URL);
const { db } = connection;
const guildIds = Array.from({ length: 18 }, () => `v74-${randomUUID()}`);
const owner = '12345678901234567', messageId = '32345678901234567';
const at = (seconds: number) => new Date(Date.UTC(2031, 0, 1, 0, 0, seconds));
const actor = (guildId: string): Actor => ({ guildId, userId: owner, guildOwnerId: owner, roleIds: [] });
const repo = new AutomationRepository(db);
const guildRepo = new GuildRepository(db);
const checks: Record<string, boolean> = {};
function check(name: string, result: boolean) { checks[name] = result; if (!result) throw new Error(name); }
async function rejects(work: () => Promise<unknown>) { try { await work(); return false; } catch { return true; } }
function draft(count = 1): AutomationRuleDraft { return { name: 'Synthetic actions', timezone: 'UTC', cooldownSeconds: 0,
  config: { schemaVersion: 1, enabled: true, trigger: { id: 'SCHEDULED', version: 1,
    config: { kind: 'daily', time: '12:00', timezone: 'UTC' } },
  actions: Array.from({ length: count }, (_, i) => ({ id: 'STAFF_LOG', version: 1,
    config: { channelId: owner, message: `Synthetic ${i}` } })) } }; }
let sendMode: 'ok' | 'throw' = 'ok';
let onSend: (() => Promise<void>) | undefined;
const sends: string[] = [];
const gateway: AutomationDiscordGateway = { async preflight(guildId, channelId) {
  return { kind: 'READY', async send(message: string) {
    sends.push(`${guildId}:${channelId}:${message}`);
    await onSend?.();
    if (sendMode === 'throw') throw new Error('Synthetic ambiguous send');
    return messageId;
  } };
} };
const service = new AutomationService(repo, new PermissionService(guildRepo),
  async guildId => actor(guildId), { debug() {}, error() {} } as never, gateway);
async function execution(id: string) { return (await db.select().from(automationExecutions).where(eq(automationExecutions.id, id)))[0]!; }
async function runs(id: string) { return db.select().from(automationActionRuns).where(eq(automationActionRuns.executionId, id)).orderBy(automationActionRuns.position); }
async function fixture(index: number, count = 1) {
  const guildId = guildIds[index]!;
  const rule = await service.create(actor(guildId), draft(count), at(0));
  const queued = await repo.createExecution(guildId, rule.id, `action-${index}`, at(0));
  return { guildId, rule, queued };
}
async function tick() { const result = await service.runDue(at(1)); onSend = undefined; sendMode = 'ok'; return result; }
try {
  await db.insert(guilds).values(guildIds.map(id => ({ id })));
  await db.insert(guildModules).values(guildIds.map(guildId => ({ guildId, moduleKey: 'automation', enabled: true, updatedBy: owner, version: 1 })));
  const first = await fixture(0);
  onSend = async () => {
    const row = await execution(first.queued.id), evidence = await runs(first.queued.id);
    check('predispatchRunningCommittedBeforeFakeSend', row.status === 'RUNNING' && evidence[0]?.status === 'RUNNING' &&
      evidence[0].attempts === 1 && !!evidence[0].dispatchToken);
  };
  await tick();
  check('confirmedMessageId', (await runs(first.queued.id))[0]?.discordMessageId === messageId && (await execution(first.queued.id)).status === 'SUCCEEDED');
  const sentAfterFirst = sends.length;
  await tick();
  check('confirmedNeverRedispatched', sends.length === sentAfterFirst);
  const ordered = await fixture(1, 2);
  onSend = async () => {
    const current = await runs(ordered.queued.id);
    if (sends.at(-1)?.endsWith('Synthetic 0')) check('strictZeroBeforeOne', current[0]?.status === 'RUNNING' && !current[1]);
    else check('strictOneAfterZeroReceipt', current[0]?.status === 'SUCCEEDED' && current[1]?.status === 'RUNNING');
  };
  await tick();
  check('orderedTwoReceipts', (await runs(ordered.queued.id)).length === 2 && (await execution(ordered.queued.id)).status === 'SUCCEEDED');
  const stale = await fixture(2);
  const staleClaim = (await repo.claimDue(at(1))).find(item => item.id === stale.queued.id)!;
  check('staleTokenBeforeSend', (await repo.prepareAction(stale.guildId, stale.queued.id, randomUUID(), 0, true, at(2))).kind === 'LOST' &&
    !(await repo.getClaimActions(stale.guildId, stale.queued.id, randomUUID())) && (await runs(stale.queued.id)).length === 0);
  await repo.deferClaim(stale.guildId, stale.queued.id, staleClaim.claimToken!, at(2));
  const edited = await fixture(3);
  await service.update(actor(edited.guildId), edited.rule.id, draft(), at(0));
  await tick();
  check('editedConfigBeforeSendFenced', (await execution(edited.queued.id)).safeErrorCode === 'STALE_CONFIG' && (await runs(edited.queued.id))[0]?.status === 'SKIPPED');
  const editDuringPreflight = await fixture(16);
  const editingGateway: AutomationDiscordGateway = { async preflight() {
    await service.update(actor(editDuringPreflight.guildId), editDuringPreflight.rule.id, draft(), at(0));
    return { kind: 'READY', async send() { throw new Error('Never send after configuration edit'); } };
  } };
  const editingService = new AutomationService(repo, new PermissionService(guildRepo), async guildId => actor(guildId),
    { debug() {}, error() {} } as never, editingGateway);
  await editingService.runDue(at(1));
  check('configEditBetweenPreflightAndFenceNoSend', (await execution(editDuringPreflight.queued.id)).safeErrorCode === 'STALE_CONFIG' &&
    (await runs(editDuringPreflight.queued.id))[0]?.status === 'SKIPPED');
  const epoch = await fixture(4);
  await guildRepo.setModuleState(epoch.guildId, 'automation', false, owner);
  await guildRepo.setModuleState(epoch.guildId, 'automation', true, owner);
  await tick();
  check('moduleEpochBeforeSendFenced', (await execution(epoch.queued.id)).safeErrorCode === 'STALE_CONFIG' && !(await runs(epoch.queued.id))[0]?.discordMessageId);
  const duringPreflight = await fixture(15);
  const raceGateway: AutomationDiscordGateway = { async preflight() {
    await guildRepo.setModuleState(duringPreflight.guildId, 'automation', false, owner);
    return { kind: 'READY', async send() { throw new Error('Never send after module disable'); } };
  } };
  const raceService = new AutomationService(repo, new PermissionService(guildRepo), async guildId => actor(guildId),
    { debug() {}, error() {} } as never, raceGateway);
  await raceService.runDue(at(1));
  check('moduleToggleBetweenPreflightAndFenceNoSend', (await execution(duringPreflight.queued.id)).safeErrorCode === 'STALE_CONFIG' &&
    (await runs(duringPreflight.queued.id))[0]?.status === 'SKIPPED');
  const toggled = await fixture(5, 2);
  onSend = async () => { await guildRepo.setModuleState(toggled.guildId, 'automation', false, owner); };
  await tick();
  check('moduleDisabledAfterSendReceiptPreserved', (await runs(toggled.queued.id))[0]?.discordMessageId === messageId && (await execution(toggled.queued.id)).safeErrorCode === 'PARTIAL_STALE_CONFIG');
  check('moduleDisabledAfterSendNoActionOne', (await runs(toggled.queued.id))[1]?.status === 'SKIPPED' && sends.filter(item => item.startsWith(`${toggled.guildId}:`)).length === 1);
  const changed = await fixture(6, 2);
  onSend = async () => { await service.update(actor(changed.guildId), changed.rule.id, draft(2), at(0)); };
  await tick();
  check('configEditedAfterSendReceiptPreserved', (await runs(changed.queued.id))[0]?.discordMessageId === messageId && (await execution(changed.queued.id)).safeErrorCode === 'PARTIAL_STALE_CONFIG');
  check('configEditedAfterSendNoActionOne', sends.filter(item => item.startsWith(`${changed.guildId}:`)).length === 1);
  const revoked = await fixture(7, 2);
  let lookup = 0;
  const revokedService = new AutomationService(repo, new PermissionService(guildRepo), async guildId => ++lookup === 1 ? actor(guildId) : null,
    { debug() {}, error() {} } as never, gateway);
  await revokedService.runDue(at(1));
  check('revokedAdminPartialSafeCode', (await execution(revoked.queued.id)).safeErrorCode === 'PARTIAL_AUTH_REVOKED' && (await runs(revoked.queued.id))[0]?.discordMessageId === messageId);
  check('revokedAdminNoSecondSend', sends.filter(item => item.startsWith(`${revoked.guildId}:`)).length === 1);
  const thrown = await fixture(8);
  sendMode = 'throw';
  await tick();
  check('sendThrowUncertain', (await execution(thrown.queued.id)).status === 'UNCERTAIN' && (await runs(thrown.queued.id))[0]?.status === 'UNCERTAIN');
  const injected = await fixture(9);
  const failingRepo = new AutomationRepository(db);
  failingRepo.confirmAction = async () => { throw new Error('Synthetic receipt failure'); };
  const failingService = new AutomationService(failingRepo, new PermissionService(guildRepo), async guildId => actor(guildId),
    { debug() {}, error() {} } as never, gateway);
  await failingService.runDue(at(1));
  check('successfulSendFailedReceiptRetainsRunning', (await runs(injected.queued.id))[0]?.status === 'RUNNING');
  await repo.recoverExpired(at(62));
  check('failedReceiptRecoveryUncertain', (await execution(injected.queued.id)).status === 'UNCERTAIN' && (await runs(injected.queued.id))[0]?.status === 'UNCERTAIN');
  const crash = await fixture(10);
  const claim = (await repo.claimDue(at(1))).find(item => item.id === crash.queued.id)!;
  const prepared = await repo.prepareAction(crash.guildId, crash.queued.id, claim.claimToken!, 0, true, at(2));
  check('crashBeforeSendDurableRunning', prepared.kind === 'READY' && (await runs(crash.queued.id))[0]?.status === 'RUNNING');
  await repo.recoverExpired(at(62));
  check('crashBeforeSendRecoveryUncertain', (await execution(crash.queued.id)).status === 'UNCERTAIN' && (await runs(crash.queued.id))[0]?.status === 'UNCERTAIN');
  check('lateReceiptEvidenceWithoutResumption', prepared.kind === 'READY' && await repo.confirmAction(crash.guildId, crash.queued.id, claim.claimToken!, 0, messageId, at(63), prepared.dispatchToken) &&
    (await execution(crash.queued.id)).status === 'UNCERTAIN' && (await runs(crash.queued.id))[0]?.discordMessageId === messageId);
  check('crossGuildReconciliationRejected', await rejects(() => service.reconcile(actor(guildIds[11]!), crash.queued.id, 0, 'CONFIRMED_SENT', at(64))));
  check('adminConfirmedSent', await service.reconcile(actor(crash.guildId), crash.queued.id, 0, 'CONFIRMED_SENT', at(64)) &&
    (await execution(crash.queued.id)).status === 'SUCCEEDED' && (await runs(crash.queued.id))[0]?.reconciliationResult === 'CONFIRMED_SENT');
  check('adminConfirmedNotSent', await service.reconcile(actor(thrown.guildId), thrown.queued.id, 0, 'CONFIRMED_NOT_SENT', at(64)) &&
    (await execution(thrown.queued.id)).status === 'FAILED' && (await runs(thrown.queued.id))[0]?.reconciliationResult === 'CONFIRMED_NOT_SENT');
  check('adminConfirmedSentWithoutInventedReceipt', await service.reconcile(actor(injected.guildId), injected.queued.id, 0, 'CONFIRMED_SENT', at(64)) &&
    (await execution(injected.queued.id)).status === 'SUCCEEDED' && (await runs(injected.queued.id))[0]?.discordMessageId === null &&
    (await runs(injected.queued.id))[0]?.reconciliationResult === 'CONFIRMED_SENT');
  const partial = await fixture(12, 2);
  const partialClaim = (await repo.claimDue(at(1))).find(item => item.id === partial.queued.id)!;
  const partialReady = await repo.prepareAction(partial.guildId, partial.queued.id, partialClaim.claimToken!, 0, true, at(2));
  if (partialReady.kind !== 'READY') throw new Error('partialReady');
  await repo.confirmAction(partial.guildId, partial.queued.id, partialClaim.claimToken!, 0, messageId, at(3), partialReady.dispatchToken);
  await repo.recoverExpired(at(62));
  check('priorSuccessPendingRecoveryUncertain', (await execution(partial.queued.id)).status === 'UNCERTAIN' && (await runs(partial.queued.id))[0]?.status === 'SUCCEEDED');
  check('manualPartialNotSentReconciliation', await service.reconcile(actor(partial.guildId), partial.queued.id, 1, 'CONFIRMED_NOT_SENT', at(63)) &&
    (await execution(partial.queued.id)).safeErrorCode === 'PARTIAL_RECONCILED' && (await runs(partial.queued.id))[1]?.status === 'FAILED');
  const unresolved = await fixture(14);
  sendMode = 'throw';
  await tick();
  await repo.prune(at(9_000_000));
  check('retentionUnresolvedUncertain', (await execution(unresolved.queued.id))?.status === 'UNCERTAIN' && (await runs(unresolved.queued.id)).length === 1);
  const legacyGuild = guildIds[13]!;
  const legacyRule = await service.create(actor(legacyGuild), draft(), at(0));
  const legacyId = randomUUID();
  await db.insert(automationExecutions).values({ id: legacyId, guildId: legacyGuild, automationId: legacyRule.id,
    triggerKey: 'legacy-inert', configVersion: legacyRule.configVersion, moduleEpoch: 1, createdAt: at(0), nextAttemptAt: at(0) });
  await db.insert(automationExecutionActions).values({ executionId: legacyId, position: 0, actionKey: 'LEGACY_INERT',
    actionVersion: 1, config: { provenance: 'V7_1_UNVERIFIED' } });
  const legacy = { guildId: legacyGuild, queued: { id: legacyId } };
  await tick();
  check('legacyInertNeverExecutes', (await execution(legacy.queued.id)).safeErrorCode === 'UNKNOWN_ACTION' && sends.filter(item => item.startsWith(`${legacy.guildId}:`)).length === 0);
} catch (error) {
  console.error(JSON.stringify({ checks, passedCount: Object.values(checks).filter(Boolean).length,
    errorType: error instanceof Error ? error.name : 'unknown', failedCheck: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
} finally {
  try { for (const id of guildIds) await db.delete(guilds).where(eq(guilds.id, id)); }
  finally { await connection.pool.end(); }
  if (!process.exitCode) console.log(JSON.stringify({ checks, passedCount: Object.values(checks).filter(Boolean).length }));
}
