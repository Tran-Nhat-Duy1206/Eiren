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
  check('crossGuildFinalizeAndDeferRejected',
    !(await repo.finalizeClaim(b, original.id, oldClaim!.claimToken!, true, at(2))) &&
    !(await repo.deferClaim(b, original.id, oldClaim!.claimToken!, at(2))) && (await row(original.id)).status === 'RUNNING');
  const changed = { ...draft(), config: { ...draft().config,
    actions: [{ id: 'STAFF_LOG', version: 1, config: { channelId: owner, message: 'New configured action text' } }] } };
  await service.update(actor(a), primary.id, changed, at(0));
  check('historicalActionSnapshotUnchangedAfterEdit',
    (await db.select().from(automationExecutionActions).where(eq(automationExecutionActions.executionId, original.id)))[0]?.config.message === 'Synthetic' &&
    (await db.select().from(automationActions).where(eq(automationActions.automationId, primary.id)))[0]?.config.message === 'New configured action text');
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
  check('disabledModuleRejectsNewExecution', await rejects(() => queue(a, primary.id, 'disabled-before-enqueue')) &&
    !(await db.select().from(automationExecutions).where(and(eq(automationExecutions.guildId, a),
      eq(automationExecutions.triggerKey, 'disabled-before-enqueue')))).length);
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
  const onceAt = new Date('2025-06-01T12:00:00.000Z');
  const onceDraft: AutomationRuleDraft = { ...draft(), config: { ...draft().config,
    trigger: { id: 'SCHEDULED', version: 1, config: { kind: 'once', at: onceAt.toISOString() } } } };
  const onceGuild = guildIds[6]!;
  const onceRule = await service.create(actor(onceGuild), onceDraft, new Date('2025-05-31T00:00:00.000Z'));
  let unlockOnce!: () => void;
  let onceLockHeld!: () => void;
  const onceGate = new Promise<void>(resolve => { unlockOnce = resolve; });
  const onceEntered = new Promise<void>(resolve => { onceLockHeld = resolve; });
  const onceHolder = db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(724099,7303)`); onceLockHeld(); await onceGate; });
  await onceEntered;
  const firstGenerator = repo.generateDue(new Date(onceAt.getTime() + 1000));
  const secondGenerator = repo.generateDue(new Date(onceAt.getTime() + 1000));
  unlockOnce();
  await onceHolder;
  const generatedOnce = [...await firstGenerator, ...await secondGenerator].filter(item => item.automationId === onceRule.id);
  check('concurrentOnceGenerationExactOccurrence', generatedOnce.length === 1 &&
    generatedOnce[0]?.triggerKey === `scheduled:${onceAt.toISOString()}` && !(await repo.get(onceGuild, onceRule.id))?.nextRunAt &&
    (await db.select().from(automationExecutions).where(eq(automationExecutions.automationId, onceRule.id))).length === 1);
  await service.setEnabled(actor(onceGuild), onceRule.id, false);
  const onceReenabled = await service.setEnabled(actor(onceGuild), onceRule.id, true);
  check('pastOnceReenableDoesNotReplay', onceReenabled.nextRunAt === null &&
    (await repo.generateDue(new Date('2026-01-01T00:00:00.000Z'))).length === 0);
  const rollbackGuild = guildIds[8]!;
  const rollbackRule = await service.create(actor(rollbackGuild), draft(), at(0));
  await db.update(automations).set({ nextRunAt: at(10) }).where(eq(automations.id, rollbackRule.id));
  const rollbackFunction = `v73_due_reject_${randomUUID().replaceAll('-', '')}`;
  const rollbackTrigger = `${rollbackFunction}_trigger`;
  await db.execute(sql.raw(`CREATE FUNCTION "${rollbackFunction}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced synthetic due rollback'; END $$`));
  try {
    await db.execute(sql.raw(`CREATE TRIGGER "${rollbackTrigger}" BEFORE UPDATE OF next_run_at ON automations FOR EACH ROW WHEN (NEW.id = ${rollbackRule.id}) EXECUTE FUNCTION "${rollbackFunction}"()`));
    check('generationEnqueueAndAdvanceRollBackTogether', await rejects(() => repo.generateDue(at(86_400))) &&
      (await db.select().from(automationExecutions).where(eq(automationExecutions.automationId, rollbackRule.id))).length === 0 &&
      (await repo.get(rollbackGuild, rollbackRule.id))?.nextRunAt?.getTime() === at(10).getTime());
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS "${rollbackTrigger}" ON automations`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS "${rollbackFunction}"()`));
  }
  await service.setEnabled(actor(rollbackGuild), rollbackRule.id, false);
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
  for (const [index, actionStatus] of (['SUCCEEDED', 'UNCERTAIN'] as const).entries()) {
    const unsafeGuild = guildIds[index + 3]!;
    const unsafeRule = await service.create(actor(unsafeGuild), draft(), at(0));
    const unsafeExecution = await queue(unsafeGuild, unsafeRule.id, `unsafe-${actionStatus}`, at(86_600));
    const unsafeOwner = (await repo.claimDue(at(86_601))).find(item => item.id === unsafeExecution.id);
    check(`claimedBeforeAmbiguous${actionStatus}`, Boolean(unsafeOwner?.claimToken));
    await db.insert(automationActionRuns).values({ executionId: unsafeExecution.id, position: 0, status: actionStatus });
    await repo.recoverExpired(at(86_662));
    check(`ambiguous${actionStatus}NeverRetries`, (await row(unsafeExecution.id)).status === 'UNCERTAIN' &&
      !(await repo.retryFailed(unsafeGuild, unsafeExecution.id, at(86_663))));
  }
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
  const rateGuild = guildIds[5]!;
  const quotaRule = await service.create(actor(rateGuild), draft(), at(0));
  const quotaSource = await queue(rateGuild, quotaRule.id, 'prior-rate-metadata', at(120_000));
  await db.update(automationExecutions).set({ status: 'SKIPPED' }).where(eq(automationExecutions.id, quotaSource.id));
  await db.insert(automationExecutionAttempts).values(Array.from({ length: 9 }, () => ({
    id: randomUUID(), guildId: rateGuild, executionId: quotaSource.id, attemptedAt: at(120_000) })));
  const quotaA = await queue(rateGuild, quotaRule.id, 'last-slot-A', at(120_001));
  const quotaB = await queue(rateGuild, quotaRule.id, 'last-slot-B', at(120_001));
  let releaseRate!: () => void;
  let rateLockHeld!: () => void;
  const rateGate = new Promise<void>(resolve => { releaseRate = resolve; });
  const rateEntered = new Promise<void>(resolve => { rateLockHeld = resolve; });
  const rateHolder = db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(724099,7303)`); rateLockHeld(); await rateGate; });
  await rateEntered;
  const firstRateWorker = repo.claimDue(at(120_002));
  const secondRateWorker = repo.claimDue(at(120_002));
  releaseRate();
  await rateHolder;
  const quotaClaims = [...await firstRateWorker, ...await secondRateWorker].filter(item => item.guildId === rateGuild);
  check('concurrentFinalMinuteSlotReservedOnce', quotaClaims.length === 1 &&
    [quotaA.id, quotaB.id].includes(quotaClaims[0]!.id) &&
    (await db.select().from(automationExecutionAttempts).where(eq(automationExecutionAttempts.guildId, rateGuild))).length === 10);
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
  const tokenGuild = guildIds[7]!;
  const tokenRule = await service.create(actor(tokenGuild), draft(), at(0));
  const turnover = await queue(tokenGuild, tokenRule.id, 'token-turnover', at(620_000));
  const tokenA = (await repo.claimDue(at(620_001))).find(item => item.id === turnover.id)!;
  check('tokenAClaimed', Boolean(tokenA?.claimToken));
  await repo.recoverExpired(at(620_062));
  await repo.recoverExpired(at(620_062)); // first bounded batch may recover older, unrelated guild claims
  check('tokenARecoveredSafely', (await row(turnover.id)).status === 'PENDING');
  const tokenB = (await repo.claimDue(at(620_093))).find(item => item.id === turnover.id)!;
  check('staleLeaseOwnerCannotFinalizeOrDefer', Boolean(tokenB?.claimToken && tokenB.claimToken !== tokenA.claimToken) &&
    !(await repo.finalizeClaim(tokenGuild, turnover.id, tokenA.claimToken!, true, at(620_094))) &&
    !(await repo.deferClaim(tokenGuild, turnover.id, tokenA.claimToken!, at(620_094))) &&
    (await row(turnover.id)).claimToken === tokenB.claimToken &&
    await repo.finalizeClaim(tokenGuild, turnover.id, tokenB.claimToken!, true, at(620_095)) &&
    (await row(turnover.id)).safeErrorCode === 'CORE_ONLY');
  const historical = await queue(b, other.id, 'soft-delete-history', at(700_000));
  check('softDeleteRetainsExecutionHistory', await service.delete(actor(b), other.id) &&
    !(await repo.get(b, other.id)) && (await row(historical.id)).automationId === other.id &&
    (await db.select().from(automationActions).where(eq(automationActions.automationId, other.id))).length === 1);
  // An ambiguous external outcome cannot lose its action-run evidence through generic retention.
  const ambiguousBefore = (await db.select().from(automationActionRuns).where(eq(automationActionRuns.executionId, unsafe.id))).length;
  await repo.prune(at(9_000_000));
  check('unreconciledAmbiguityRetainsAuditEvidence', ambiguousBefore === 1 &&
    (await row(unsafe.id))?.status === 'UNCERTAIN' &&
    (await db.select().from(automationActionRuns).where(eq(automationActionRuns.executionId, unsafe.id))).length === 1);
  // Rate metadata must be bound to the execution's own guild, not merely reference two valid rows.
  check('attemptGuildExecutionCompositeFK', await rejects(() => db.insert(automationExecutionAttempts).values({
    id: randomUUID(), guildId: a, executionId: historical.id, attemptedAt: at(700_000) })));
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
