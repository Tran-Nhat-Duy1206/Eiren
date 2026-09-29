import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { automations, automationActions, automationExecutions, automationExecutionActions, automationExecutionAttempts, automationActionRuns, guildModules, guilds } from '../core/database/schema.js';
import { PermissionService, type Actor } from '../core/permissions/permission-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { AutomationRepository } from '../modules/automation/repository.js';
import { AutomationService, type AutomationRuleDraft } from '../modules/automation/service.js';

const connection = createDatabase(loadEnv().DATABASE_URL);
const { db } = connection;
const guildIds = Array.from({ length: 12 }, (_, i) => `v73-${i}-${randomUUID()}`);
const [a, b] = guildIds as [string, string];
const owner = '12345678901234567', member = '22345678901234567';
const at = (seconds: number) => new Date(Date.UTC(2031, 0, 1, 0, 0, seconds));
const draft = (enabled = true): AutomationRuleDraft => ({ name: 'Synthetic rule', timezone: 'UTC', cooldownSeconds: 0,
  config: { schemaVersion: 1, enabled, trigger: { id: 'SCHEDULED', version: 1,
    config: { kind: 'daily', time: '12:00', timezone: 'UTC' } },
  actions: [{ id: 'STAFF_LOG', version: 1, config: { channelId: owner, message: 'Synthetic' } }] } });
const actor = (guildId: string, userId = owner): Actor => ({ guildId, userId, guildOwnerId: owner, roleIds: [] });
const checks: Record<string, boolean> = {};
function check(key: string, value: boolean) { checks[key] = value; if (!value) throw new Error(key); }
async function rejects(work: () => Promise<unknown>) { try { await work(); return false; } catch { return true; } }
const repo = new AutomationRepository(db);
const guildRepo = new GuildRepository(db);
const service = new AutomationService(repo, new PermissionService(guildRepo),
  async (guildId, userId) => actor(guildId, userId), { debug() {} } as never);
async function row(id: string) { return (await db.select().from(automationExecutions).where(eq(automationExecutions.id, id)))[0]!; }
async function queue(guildId: string, ruleId: number, key: string, time = at(0)) {
  return repo.createExecution(guildId, ruleId, key, time);
}
try {
  await db.insert(guilds).values(guildIds.map(id => ({ id })));
  await db.insert(guildModules).values(guildIds.map(guildId => ({ guildId, moduleKey: 'automation', enabled: true, updatedBy: owner, version: 1 })));
  check('serviceRequiresAdmin', await rejects(() => service.create(actor(a, member), draft(), at(0))));
  const primary = await service.create(actor(a), draft(), at(0));
  const other = await service.create(actor(b), draft(), at(0));
  check('guildScopedReadListAndMutation', (await service.list(actor(a))).length === 1 &&
    await rejects(() => service.inspect(actor(b), primary.id)) &&
    await rejects(() => service.update(actor(b), primary.id, draft(), at(0))) &&
    await rejects(() => service.setEnabled(actor(b), primary.id, false)) &&
    await rejects(() => service.delete(actor(b), primary.id)) && Boolean(await service.inspect(actor(b), other.id)));
  const updated = await service.update(actor(a), primary.id, draft(), at(0));
  check('configVersionOnUpdate', updated.configVersion === primary.configVersion + 1);
  const original = await queue(a, primary.id, 'dedupe', at(0));
  const duplicate = await queue(a, primary.id, 'dedupe', at(0));
  check('triggerDedupeAndSnapshot', duplicate.id === original.id &&
    (await db.select().from(automationExecutionActions).where(eq(automationExecutionActions.executionId, original.id))).length === 1);
  const causationId = randomUUID();
  const chained = await repo.createExecution(a, primary.id, 'chain-allowed', at(0), causationId, 2);
  check('causationAndDepthBounded', chained.causationId === causationId && chained.chainDepth === 2 &&
    await rejects(() => repo.createExecution(a, primary.id, 'chain-rejected', at(0), causationId, 3)) &&
    await rejects(() => repo.createExecution(a, primary.id, 'unsafe-content key', at(0))));
  await db.update(automationExecutions).set({ status: 'SKIPPED', completedAt: at(0) })
    .where(eq(automationExecutions.id, chained.id));
  const [oldClaim] = await repo.claimDue(at(1));
  check('claimCreatesAuthoritativeAttempt', oldClaim?.id === original.id && oldClaim.attempts === 1 &&
    (await db.select().from(automationExecutionAttempts).where(eq(automationExecutionAttempts.executionId, original.id))).length === 1);
  check('expiredLeaseCannotFinalize', !(await repo.finalizeClaim(a, original.id, oldClaim!.claimToken!, true, at(61))) &&
    (await row(original.id)).status === 'RUNNING');
  await service.update(actor(a), primary.id, draft(), at(0));
  check('staleConfigFinalization', await repo.finalizeClaim(a, original.id, oldClaim!.claimToken!, true, at(2)) &&
    (await row(original.id)).safeErrorCode === 'STALE_CONFIG');
  check('terminalTransitionAndClaimTokenCannotReplay',
    !(await repo.finalizeClaim(a, original.id, oldClaim!.claimToken!, true, at(3))) &&
    !(await repo.retryFailed(a, original.id, at(3))) && (await row(original.id)).status === 'SKIPPED');
  const epoch = await queue(a, primary.id, 'epoch');
  const [epochClaim] = await repo.claimDue(at(3));
  await guildRepo.setModuleState(a, 'automation', false, owner);
  await guildRepo.setModuleState(a, 'automation', true, owner);
  check('moduleEpochFencedAfterReenable', epochClaim?.id === epoch.id &&
    await repo.finalizeClaim(a, epoch.id, epochClaim!.claimToken!, true, at(4)) &&
    (await row(epoch.id)).safeErrorCode === 'STALE_CONFIG');
  const pendingDisabled = await queue(a, primary.id, 'pending-module-disable');
  await guildRepo.setModuleState(a, 'automation', false, owner);
  const [pendingDisabledClaim] = await repo.claimDue(at(4));
  check('pendingModuleDisableCannotAuthorize', pendingDisabledClaim?.id === pendingDisabled.id &&
    await repo.finalizeClaim(a, pendingDisabled.id, pendingDisabledClaim.claimToken!, true, at(5)) &&
    (await row(pendingDisabled.id)).status === 'SKIPPED' &&
    (await row(pendingDisabled.id)).safeErrorCode === 'STALE_CONFIG');
  await guildRepo.setModuleState(a, 'automation', true, owner);
  check('pendingDisableReenableNeverRelabeled', (await row(pendingDisabled.id)).status === 'SKIPPED');
  const disabled = await queue(a, primary.id, 'disabled');
  const [disabledClaim] = await repo.claimDue(at(5));
  const beforeToggle = (await repo.get(a, primary.id))!.configVersion;
  await service.setEnabled(actor(a), primary.id, false);
  const reen = await service.setEnabled(actor(a), primary.id, true);
  check('individualRuleDisableReenableFence', disabledClaim?.id === disabled.id && reen.configVersion === beforeToggle + 2 &&
    await repo.finalizeClaim(a, disabled.id, disabledClaim!.claimToken!, true, at(6)) &&
    (await row(disabled.id)).safeErrorCode === 'STALE_CONFIG');
  const pendingRuleDisabled = await queue(a, primary.id, 'pending-rule-disable');
  await service.setEnabled(actor(a), primary.id, false);
  const [ruleDisabledClaim] = await repo.claimDue(at(7));
  check('pendingRuleDisableCannotAuthorize', ruleDisabledClaim?.id === pendingRuleDisabled.id &&
    await repo.finalizeClaim(a, pendingRuleDisabled.id, ruleDisabledClaim.claimToken!, true, at(8)) &&
    (await row(pendingRuleDisabled.id)).status === 'SKIPPED');
  await service.setEnabled(actor(a), primary.id, true);
  check('pendingRuleReenableNeverRelabeled', (await row(pendingRuleDisabled.id)).status === 'SKIPPED');
  const revoked = await queue(a, primary.id, 'revoked-authorizer');
  const [revokedClaim] = await repo.claimDue(at(9));
  check('currentAuthorityDenialCannotAuthorize', revokedClaim?.id === revoked.id &&
    await repo.finalizeClaim(a, revoked.id, revokedClaim.claimToken!, false, at(10)) &&
    (await row(revoked.id)).status === 'SKIPPED' && (await row(revoked.id)).safeErrorCode === 'STALE_CONFIG');
  const scheduleRule = await service.create(actor(a), draft(), at(0));
  await db.update(automations).set({ nextRunAt: null }).where(eq(automations.id, primary.id));
  await db.update(automations).set({ nextRunAt: null }).where(eq(automations.id, other.id));
  await db.update(automations).set({ nextRunAt: at(10) }).where(eq(automations.id, scheduleRule.id));
  const generated = await repo.generateDue(at(86_400));
  const again = await repo.generateDue(at(86_400));
  const afterSchedule = await repo.get(a, scheduleRule.id);
  check('scheduleDeterministicNoCatchup', generated.length === 1 && again.length === 0 &&
    generated[0]?.triggerKey === `scheduled:${at(10).toISOString()}` &&
    !!afterSchedule?.nextRunAt && afterSchedule.nextRunAt > at(86_400));
  check('scheduleDuplicateKey', (await queue(a, scheduleRule.id, `scheduled:${at(10).toISOString()}`)).id === generated[0]?.id);
  const capacity: { id: number }[] = [];
  for (let i = 0; i < 18; i++) capacity.push(await service.create(actor(a), draft(), at(0)));
  check('enabledCap20', (await service.list(actor(a))).filter(rule => rule.enabled).length === 20 &&
    await rejects(() => service.create(actor(a), draft(), at(0))));
  await service.setEnabled(actor(a), capacity[0]!.id, false);
  const extra = await service.create(actor(a), draft(), at(0));
  check('enableCapacityAndRecovery', await rejects(() => service.setEnabled(actor(a), capacity[0]!.id, true)) && extra.enabled);
  // Test constraints in independent transactions: a rejected statement must not poison subsequent operations.
  check('crossGuildCompositeExecutionFK', await rejects(() => db.insert(automationExecutions).values({
    id: randomUUID(), guildId: b, automationId: primary.id, triggerKey: 'wrong-guild', moduleEpoch: 1, configVersion: 1 })));
  check('actionRunSnapshotPositionFK', await rejects(() => db.insert(automationActionRuns).values({ executionId: original.id, position: 1 })));
  check('immutableSnapshotUpdateTrigger', await rejects(() => db.update(automationExecutionActions).set({ actionKey: 'STATIC_MESSAGE' })
    .where(and(eq(automationExecutionActions.executionId, original.id), eq(automationExecutionActions.position, 0)))));
  const recoverable = await queue(b, other.id, 'recoverable', at(86_400));
  const recoveryClaim = (await repo.claimDue(at(86_401))).find(item => item.id === recoverable.id);
  check('recoverableClaimObtained', recoveryClaim?.id === recoverable.id);
  await repo.recoverExpired(at(86_462));
  check('expiredLeaseThirtySecondBackoff', (await row(recoverable.id)).status === 'PENDING' &&
    (await row(recoverable.id)).nextAttemptAt?.getTime() === at(86_492).getTime());
  const unsafe = await queue(b, other.id, 'unsafe', at(86_500));
  const unsafeClaim = (await repo.claimDue(at(86_501))).find(item => item.id === unsafe.id);
  check('unsafeClaimObtained', unsafeClaim?.id === unsafe.id);
  await db.insert(automationActionRuns).values({ executionId: unsafe.id, position: 0, status: 'RUNNING' });
  await repo.recoverExpired(at(86_562));
  check('unsafeActionRunBecomesUncertain', (await row(unsafe.id)).status === 'UNCERTAIN' &&
    (await row(unsafe.id)).safeErrorCode === 'ACTION_OUTCOME_UNKNOWN' &&
    !(await repo.retryFailed(b, unsafe.id, at(86_563))));
  // Explicitly seed historical attempt metadata to exercise the authoritative sliding windows.
  const rateRule = await service.create(actor(b), draft(), at(0));
  for (let i = 0; i < 10; i++) {
    const execution = await queue(b, rateRule.id, `minute-${i}`, at(100_000 + i));
    await db.insert(automationExecutionAttempts).values({ id: randomUUID(), guildId: b, executionId: execution.id, attemptedAt: at(100_000) });
    await db.update(automationExecutions).set({ status: 'SKIPPED' }).where(eq(automationExecutions.id, execution.id));
  }
  const ratePending = await queue(b, rateRule.id, 'minute-pending', at(100_001));
  check('authoritativeMinuteRate10', !(await repo.claimDue(at(100_002))).some(item => item.id === ratePending.id));
  for (let i = 10; i < 60; i++) {
    await db.insert(automationExecutionAttempts).values({ id: randomUUID(), guildId: b, executionId: ratePending.id, attemptedAt: at(97_000) });
  }
  check('authoritativeHourRate60', !(await repo.claimDue(at(100_061))).some(item => item.id === ratePending.id));
  check('rateWindowExpires', (await repo.claimDue(at(100_601))).some(item => item.id === ratePending.id));
  // Isolate retry exhaustion from other pending rows using a future timestamp.
  const retries = await queue(b, rateRule.id, 'retry-limit', at(200_000));
  for (let attempt = 1; attempt <= 5; attempt++) {
    const time = at(200_000 + attempt * 1000);
    const claims = await repo.claimDue(time);
    const claimed = claims.find(item => item.id === retries.id);
    check(`retryClaim${attempt}`, claimed?.attempts === attempt);
    check(`retryDefer${attempt}`, await repo.deferClaim(b, retries.id, claimed!.claimToken!, at(200_000 + attempt * 1000 + 1)));
  }
  check('maxFiveAttempts', (await row(retries.id)).status === 'FAILED' && (await row(retries.id)).attempts === 5);
  const aged = await queue(b, rateRule.id, 'age-limit', at(300_000));
  await db.update(automationExecutions).set({ nextAttemptAt: at(386_401) }).where(eq(automationExecutions.id, aged.id));
  await repo.claimDue(at(386_401));
  check('twentyFourHourRetryExpiry', (await row(aged.id)).status === 'FAILED' && (await row(aged.id)).attempts === 0);
  // Distinct guilds avoid per-guild rate-budget interference; all queued rows have the same fixed due time.
  const boundTime = at(500_000);
  for (const guildId of guildIds) {
    const rule = guildId === a ? primary.id : guildId === b ? other.id : (await service.create(actor(guildId), draft(), at(0))).id;
    for (let i = 0; i < 3; i++) await queue(guildId, rule, `bound-${i}`, boundTime);
  }
  const bounded = await repo.claimDue(at(500_001));
  check('perGuildTwoAndGlobalTwenty', bounded.length === 20 &&
    guildIds.every(guildId => bounded.filter(item => item.guildId === guildId).length <= 2));
  // Hold the exact transaction advisory lock while two claim callers wait, then release without sleeps.
  const concurrentAt = at(600_000);
  const concurrencyRule = await service.create(actor(guildIds[2]!), draft(), at(0));
  const one = await queue(guildIds[2]!, concurrencyRule.id, 'concurrent', concurrentAt);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { entered = resolve; });
  const holder = db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(724099,7303)`); entered(); await gate; });
  await locked;
  const left = repo.claimDue(at(600_001));
  const right = repo.claimDue(at(600_001));
  release();
  await holder;
  const owners = [...await left, ...await right].filter(item => item.id === one.id);
  check('concurrentAdvisoryLockExactlyOneOwner', owners.length === 1 && (await row(one.id)).attempts === 1);
  const historical = await queue(b, other.id, 'soft-delete-history', at(700_000));
  check('softDeleteRetainsExecutionHistory', await service.delete(actor(b), other.id) &&
    !(await repo.get(b, other.id)) && (await row(historical.id)).automationId === other.id &&
    (await db.select().from(automationActions).where(eq(automationActions.automationId, other.id))).length === 1);
} catch (error) {
  console.error(JSON.stringify({ checks, passedCount: Object.values(checks).filter(Boolean).length,
    errorType: error instanceof Error ? error.name : 'unknown',
    failedCheck: error instanceof Error && Object.hasOwn(checks, error.message) ? error.message : 'database-or-script' }));
  process.exitCode = 1;
} finally {
  try { for (const id of guildIds) await db.delete(guilds).where(eq(guilds.id, id)); }
  finally { await connection.pool.end(); }
  if (!process.exitCode) console.log(JSON.stringify({ checks, passedCount: Object.values(checks).filter(Boolean).length }));
}
