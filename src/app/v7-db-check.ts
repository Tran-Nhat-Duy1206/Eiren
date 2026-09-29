import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { guilds, guildModules, aiSettings, aiUsageDaily, aiRequests,
  automations, automationActions, automationExecutions, automationActionRuns } from '../core/database/schema.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { AiRepository, maximumCostMicros, type AiAdmissionInput } from '../modules/ai/repository.js';
import { AI_DEFAULT_LIMITS } from '../modules/ai/limits.js';

const checks: Record<string, boolean | number | string> = {};
const assert = (key: string, value: unknown) => { checks[key] = Boolean(value); if (!value) throw new Error(key); };
const id = randomUUID();
const guildId = `v7-check-${id}`, otherId = `v7-check-other-${id}`;
const userId = '12345678901234567', otherUser = '22345678901234567';
const model = { providerId: 'synthetic', modelId: 'approved', inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 4, maxInputTokens: 2048, maxOutputTokens: 512 };
const policy = { providerId: 'synthetic', modelId: 'approved', ...AI_DEFAULT_LIMITS };
const now = new Date();
let stage = 'initialize';
let connection: ReturnType<typeof createDatabase> | undefined;
const rejection = async (work: () => Promise<unknown>) => {
  try { await work(); return false; } catch { return true; }
};
try {
  connection = createDatabase(loadEnv().DATABASE_URL);
  const db = connection.db;
  stage = 'schema';
  const expectedTables = ['ai_settings', 'ai_usage_daily', 'ai_requests', 'automations', 'automation_actions',
    'automation_executions', 'automation_action_runs'];
  const tables = await db.execute(sql`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name IN ('ai_settings','ai_usage_daily','ai_requests',
      'automations','automation_actions','automation_executions','automation_action_runs')`);
  assert('sevenV7FoundationTables', expectedTables.every(name => tables.rows.some(row => row.table_name === name)));
  const columns = await db.execute(sql`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name IN ('ai_settings','ai_usage_daily','ai_requests',
      'automations','automation_actions','automation_executions','automation_action_runs')`);
  assert('noContentOrSecretsInV7Schema', columns.rows.every(row =>
    !/(prompt|response|message_body|ticket_text|report_text|appeal_text|moderation_note|provider_secret|api_key|access_token|cookie|request_body)/i
      .test(String(row.column_name))));
  await db.insert(guilds).values([{ id: guildId }, { id: otherId }]);
  await db.insert(guildModules).values([{ guildId, moduleKey: 'ai', enabled: false, updatedBy: 'synthetic' },
    { guildId: otherId, moduleKey: 'ai', enabled: true, updatedBy: 'synthetic' }]);
  await db.insert(aiSettings).values([{ guildId, providerId: 'synthetic', modelId: 'approved', guildRequestsPerDay: 1 },
    { guildId: otherId, providerId: 'synthetic', modelId: 'approved' }]);
  const ai = new AiRepository(db), guildRepo = new GuildRepository(db);
  const initialCost = maximumCostMicros(model, 100, 10);
  const options = (ingress: NonNullable<Awaited<ReturnType<typeof ai.reserveIngress>>>, key: string,
    user = userId, at = now, changes: Partial<AiAdmissionInput> = {}): AiAdmissionInput => ({
    ingress, userId: user, requestKey: key, inputCharacters: 400, estimatedInputTokens: 100,
    maxOutputTokens: 10, model, policy, globalDailyBudgetMicros: 5_000_000,
    globalMonthlyBudgetMicros: 50_000_000, now: at, ...changes,
  });
  stage = 'admission';
  assert('disabledAiCannotReserve', await ai.reserveIngress(guildId) === null);
  await guildRepo.setModuleState(guildId, 'ai', true, userId);
  const ingress = await ai.reserveIngress(guildId);
  assert('immutableIngressEpoch', Object.isFrozen(ingress) && ingress?.guildId === guildId && ingress.epoch >= 1);
  if (!ingress) throw new Error('Expected enabled synthetic ingress');
  const candidates = await Promise.all([ai.admit(options(ingress, `same-cap-a-${id}`)),
    ai.admit(options(ingress, `same-cap-b-${id}`, otherUser))]);
  const accepted = candidates.filter(item => item !== null);
  assert('concurrentSingleRemainingDailySlot', accepted.length === 1);
  const first = accepted[0];
  if (!first) throw new Error('Expected one atomic admission');
  const day = now.toISOString().slice(0, 10);
  const [usage] = await db.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, guildId), eq(aiUsageDaily.utcDay, day)));
  assert('atomicDailyRequestAndWorstCaseReservation', usage?.requests === 1 &&
    usage.reservedCostMicros === initialCost && usage.settledCostMicros === 0);
  assert('idempotencyKeyCannotReserveAgain', await ai.admit(options(ingress, first.userId === userId ? `same-cap-a-${id}` : `same-cap-b-${id}`, first.userId)) === null);
  assert('noExtraRequestAfterRejectedReplay', (await db.select().from(aiRequests).where(eq(aiRequests.guildId, guildId))).length === 1);
  const actual = { inputTokens: 50, outputTokens: 5, costMicros: maximumCostMicros(model, 50, 5) };
  assert('settlementAcceptedOnce', await ai.settle(first, actual, new Date(now.getTime() + 1_000)));
  assert('duplicateSettlementRejected', !await ai.settle(first, actual, new Date(now.getTime() + 1_001)));
  const [settled] = await db.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, guildId), eq(aiUsageDaily.utcDay, day)));
  assert('settlementFreesReservationWithoutNegativeCost', settled?.reservedCostMicros === 0 &&
    settled.settledCostMicros === actual.costMicros && settled.inputTokens === 50 && settled.outputTokens === 5);
  await db.update(aiSettings).set({ guildRequestsPerDay: 25, userRequestsPerDay: 1 }).where(eq(aiSettings.guildId, guildId));
  assert('userDailyCapPersistsAcrossSettlement', await ai.admit(options(ingress, `user-cap-${id}`, first.userId,
    new Date(now.getTime() + 31_000))) === null);
  await db.update(aiSettings).set({ userRequestsPerDay: 10 }).where(eq(aiSettings.guildId, guildId));
  assert('userCooldownRejectsImmediateReuse', await ai.admit(options(ingress, `cooldown-${id}`, first.userId,
    new Date(now.getTime() + 2_000))) === null);
  const costLimited = await ai.admit(options(ingress, `cost-accepted-${id}`, otherUser,
    new Date(now.getTime() + 31_000)));
  assert('eligibleSecondUserCanReserve', costLimited !== null);
  if (!costLimited) throw new Error('Expected second admission');
  await ai.settle(costLimited, null, new Date(now.getTime() + 32_000));
  await db.update(aiSettings).set({ monthlyBudgetMicros: settled!.settledCostMicros + initialCost })
    .where(eq(aiSettings.guildId, guildId));
  assert('monthlyGuildBudgetRejectsOverrun', await ai.admit(options(ingress, `budget-${id}`, '32345678901234567',
    new Date(now.getTime() + 35_000))) === null);
  await db.update(aiSettings).set({ monthlyBudgetMicros: null }).where(eq(aiSettings.guildId, guildId));
  const guildConcurrencyRace = await Promise.all([
    ai.admit(options(ingress, `guild-concurrency-a-${id}`, '13345678901234567', new Date(now.getTime() + 40_000))),
    ai.admit(options(ingress, `guild-concurrency-b-${id}`, '14345678901234567', new Date(now.getTime() + 40_000))),
  ]);
  assert('guildConcurrentReservationsOneWithDailyRoom', guildConcurrencyRace.filter(Boolean).length === 1);
  const guildWinner = guildConcurrencyRace.find(item => item !== null);
  if (guildWinner) await ai.settle(guildWinner, null, new Date(now.getTime() + 41_000));
  const sameKey = `same-key-race-${id}`;
  const sameKeyRace = await Promise.all([
    ai.admit(options(ingress, sameKey, '15345678901234567', new Date(now.getTime() + 75_000))),
    ai.admit(options(ingress, sameKey, '16345678901234567', new Date(now.getTime() + 75_000))),
  ]);
  assert('simultaneousRequestKeyReplayIsUnique', sameKeyRace.filter(Boolean).length === 1 &&
    (await db.select().from(aiRequests).where(and(eq(aiRequests.guildId, guildId), eq(aiRequests.requestKey, sameKey)))).length === 1);
  const keyWinner = sameKeyRace.find(item => item !== null);
  if (keyWinner) await ai.settle(keyWinner, null, new Date(now.getTime() + 76_000));
  await guildRepo.setModuleState(guildId, 'ai', false, userId);
  assert('disabledBeforeAdmissionRejectsToken', await ai.admit(options(ingress, `disabled-${id}`)) === null);
  await guildRepo.setModuleState(guildId, 'ai', true, userId);
  assert('reenabledOldEpochCannotRelabel', await ai.admit(options(ingress, `old-epoch-${id}`)) === null &&
    !(await db.select().from(aiRequests).where(and(eq(aiRequests.guildId, guildId), eq(aiRequests.requestKey, `old-epoch-${id}`)))).length);
  const fresh = await ai.reserveIngress(guildId);
  assert('freshEpochAdvances', fresh?.epoch === ingress.epoch + 2);
  if (!fresh) throw new Error('Expected fresh ingress');
  const concurrencyDay = new Date(now.getTime() + 86_400_000);
  const otherIngress = await ai.reserveIngress(otherId);
  if (!otherIngress) throw new Error('Expected second guild ingress');
  assert('globalMonthlyBudgetRejectsOverrun', await ai.admit(options(otherIngress,
    `global-month-${id}`, '72345678901234567', now, { globalMonthlyBudgetMicros: actual.costMicros })) === null);
  const processPolicy = { ...policy, processConcurrency: 1 };
  const processRace = await Promise.all([ai.admit(options(fresh, `process-g1-${id}`,
    '32345678901234567', concurrencyDay, { policy: processPolicy })),
  ai.admit(options(otherIngress, `process-g2-${id}`, '42345678901234567', concurrencyDay,
    { policy: processPolicy }))]);
  assert('globalConcurrentAdmissionsRespectProcessTarget', processRace.filter(Boolean).length === 1);
  const admittedFromProcessRace = processRace.find(item => item !== null);
  if (admittedFromProcessRace) await ai.settle(admittedFromProcessRace, null, new Date(concurrencyDay.getTime() + 1_000));
  const upcoming = new Date(concurrencyDay.getTime() + 86_400_000);
  const candidateInput = options(fresh, `global-g1-${id}`, '32345678901234567', upcoming,
    { globalDailyBudgetMicros: initialCost });
  const globalRace = await Promise.all([ai.admit(candidateInput), ai.admit(options(otherIngress,
    `global-g2-${id}`, '42345678901234567', upcoming, { globalDailyBudgetMicros: initialCost }))]);
  assert('globalSpendCapSerializesGuilds', globalRace.filter(Boolean).length === 1);
  assert('otherGuildIndependentCounters', (await db.select().from(aiUsageDaily).where(eq(aiUsageDaily.guildId, otherId)))
    .every(row => row.requests <= 1));
  const admittedFromGlobalRace = globalRace.find(item => item !== null);
  if (admittedFromGlobalRace) await ai.settle(admittedFromGlobalRace, null, new Date(upcoming.getTime() + 1_000));
  const edge = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1, 23, 59, 55));
  const edgeUser = '17345678901234567';
  const beforeMidnight = await ai.admit(options(otherIngress, `midnight-a-${id}`, edgeUser, edge));
  if (!beforeMidnight) throw new Error('Expected pre-midnight request');
  await ai.settle(beforeMidnight, null, new Date(edge.getTime() + 1_000));
  assert('cooldownCrossesUtcMidnight', await ai.admit(options(otherIngress, `midnight-rejected-${id}`,
    edgeUser, new Date(edge.getTime() + 10_000))) === null);
  const afterCooldown = await ai.admit(options(otherIngress, `midnight-b-${id}`,
    edgeUser, new Date(edge.getTime() + 31_000)));
  assert('dailyQuotaResetsAtUtcMidnightButCooldownDoesNot', afterCooldown !== null);
  if (afterCooldown) await ai.settle(afterCooldown, null, new Date(edge.getTime() + 32_000));
  const delayed = await ai.admit(options(fresh, `old-settle-${id}`, '52345678901234567',
    new Date(upcoming.getTime() + 86_400_000)));
  assert('reserveBeforeToggleForDelayedSettlement', delayed !== null);
  if (!delayed) throw new Error('Expected delayed reservation');
  assert('settlementCannotSpendBeyondReservation', await rejection(() => ai.settle(delayed,
    { inputTokens: 50, outputTokens: 5, costMicros: delayed.reservedCostMicros + 1 })));
  const [stillReserved] = await db.select().from(aiRequests).where(eq(aiRequests.id, delayed.id));
  assert('failedSettlementLeavesReservationAtomic', stillReserved?.status === 'RESERVED');
  await guildRepo.setModuleState(guildId, 'ai', false, userId);
  await guildRepo.setModuleState(guildId, 'ai', true, userId);
  assert('oldEpochSettlementDoesNotAuthorizeOutput', !await ai.settle(delayed, actual,
    new Date(upcoming.getTime() + 86_401_000)));
  const [charged] = await db.select().from(aiRequests).where(eq(aiRequests.id, delayed.id));
  assert('oldEpochStillBillsAccurateMetadata', charged?.status === 'SETTLED' && charged.actualCostMicros === actual.costMicros);
  assert('crossGuildSettlementCannotTouchOtherGuild', !await ai.settle({ ...delayed, guildId: otherId }, actual));
  const expiringIngress = await ai.reserveIngress(guildId);
  if (!expiringIngress) throw new Error('Expected active synthetic ingress');
  const expiring = await ai.admit(options(expiringIngress, `expired-${id}`, '62345678901234567',
    new Date(upcoming.getTime() + 2 * 86_400_000)));
  assert('leaseCanBeReserved', expiring !== null);
  if (!expiring) throw new Error('Expected expiring admission');
  assert('expiredLeaseChargesFullRatherThanRefunding', !await ai.settle(expiring, actual,
    new Date(expiring.leaseUntil.getTime() + 1)));
  const [expired] = await db.select().from(aiRequests).where(eq(aiRequests.id, expiring.id));
  assert('expiredMetadataConservative', expired?.status === 'EXPIRED' && expired.actualCostMicros === expiring.reservedCostMicros);
  // Hold the actual PostgreSQL advisory lock across lease expiry, not just a mocked clock.
  const holdGlobalLock = async () => {
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const release = db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(0, hashtext('eiren-ai-budget'))`);
      acquired();
      await tx.execute(sql`SELECT pg_sleep(1.5)`);
    });
    await ready;
    return { release };
  };
  const liveIngress = await ai.reserveIngress(otherId);
  if (!liveIngress) throw new Error('Expected other guild ingress for lock-wait regression');
  const lateLock = await holdGlobalLock();
  const latePromise = ai.admit(options(liveIngress, `late-clock-${id}`, '82345678901234567', now,
    { now: undefined }));
  await lateLock.release;
  const late = await latePromise;
  assert('admissionLeaseStartsAfterLockWait', late !== null &&
    late.leaseUntil.getTime() - Date.now() > 59_400);
  if (!late) throw new Error('Expected late admission');
  const settleLock = await holdGlobalLock();
  await db.update(aiRequests).set({ leaseUntil: new Date(Date.now() + 500) }).where(eq(aiRequests.id, late.id));
  const lateSettlement = ai.settle(late, actual);
  await settleLock.release;
  assert('lockWaitCannotAuthorizeExpiredSettlement', !await lateSettlement);
  const [lateRow] = await db.select().from(aiRequests).where(eq(aiRequests.id, late.id));
  assert('expiredAfterLockWaitChargesOnce', lateRow?.status === 'EXPIRED' &&
    lateRow.actualCostMicros === late.reservedCostMicros);
  const duplicate = await ai.admit(options(liveIngress, `duplicate-settle-${id}`,
    '92345678901234567', now, { now: undefined }));
  if (!duplicate) throw new Error('Expected live reservation for duplicate settlement');
  const liveDay = new Date().toISOString().slice(0, 10);
  const usageFor = () => db.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, otherId), eq(aiUsageDaily.utcDay, liveDay)));
  const [beforeDuplicate] = await usageFor();
  const duplicateResults = await Promise.all([ai.settle(duplicate, actual), ai.settle(duplicate, actual)]);
  const [afterDuplicate] = await usageFor();
  assert('concurrentDuplicateSettlementExactlyOnce', duplicateResults.filter(Boolean).length === 1 &&
    afterDuplicate?.reservedCostMicros === beforeDuplicate!.reservedCostMicros - duplicate.reservedCostMicros &&
    afterDuplicate.settledCostMicros === beforeDuplicate!.settledCostMicros + actual.costMicros &&
    afterDuplicate.inputTokens === beforeDuplicate!.inputTokens + actual.inputTokens &&
    afterDuplicate.outputTokens === beforeDuplicate!.outputTokens + actual.outputTokens);
  const racing = await ai.admit(options(liveIngress, `expiry-race-${id}`,
    '10345678901234567', now, { now: undefined }));
  if (!racing) throw new Error('Expected live reservation for expiry race');
  const [beforeRace] = await usageFor();
  const expiryLock = await holdGlobalLock();
  await db.update(aiRequests).set({ leaseUntil: new Date(Date.now() + 500) }).where(eq(aiRequests.id, racing.id));
  const cleanupPromise = ai.admit(options(liveIngress, `cleanup-race-${id}`,
    '11345678901234567', now, { now: undefined }));
  const settlePromise = ai.settle(racing, actual);
  await expiryLock.release;
  const [cleanup, racingSettlement] = await Promise.all([cleanupPromise, settlePromise]);
  assert('expiredCleanupAndSettlementCannotAuthorize', cleanup !== null && racingSettlement === false);
  const [raceRow] = await db.select().from(aiRequests).where(eq(aiRequests.id, racing.id));
  assert('expiredCleanupAndSettlementOneTerminalCharge', raceRow?.status === 'EXPIRED' &&
    raceRow.actualCostMicros === racing.reservedCostMicros);
  if (!cleanup) throw new Error('Expected post-expiration admission');
  assert('newAdmissionSettlesAfterExpiryRace', await ai.settle(cleanup, null));
  const [afterRace] = await usageFor();
  assert('expiryRaceCountersRemainExact', afterRace?.requests === beforeRace!.requests + 1 &&
    afterRace.reservedCostMicros === beforeRace!.reservedCostMicros - racing.reservedCostMicros &&
    afterRace.settledCostMicros === beforeRace!.settledCostMicros + racing.reservedCostMicros + cleanup.reservedCostMicros &&
    afterRace.inputTokens === beforeRace!.inputTokens && afterRace.outputTokens === beforeRace!.outputTokens);
  assert('rejectNegativeDailyCounters', await rejection(() => db.update(aiUsageDaily)
    .set({ reservedCostMicros: -1 }).where(and(eq(aiUsageDaily.guildId, guildId), eq(aiUsageDaily.utcDay, day)))));
  assert('rejectOversizedGuildSettings', await rejection(() => db.update(aiSettings)
    .set({ guildRequestsPerDay: 26 }).where(eq(aiSettings.guildId, guildId))));
  stage = 'automation-foundation';
  const [rule] = await db.insert(automations).values({ guildId, name: 'Synthetic reminder', triggerKey: 'SCHEDULED',
    triggerVersion: 1, triggerConfig: { hour: 8 }, authorizedBy: userId,
    approvedCapability: 'SEND_MESSAGE', timezone: 'UTC' }).returning();
  const [otherRule] = await db.insert(automations).values({ guildId: otherId, name: 'Other guild',
    triggerKey: 'SCHEDULED', triggerVersion: 1, authorizedBy: otherUser,
    approvedCapability: 'STAFF_LOG' }).returning();
  if (!rule || !otherRule) throw new Error('Expected synthetic automation rules');
  assert('automationStartsInertAndDisabled', rule.enabled === false && rule.nextRunAt === null);
  assert('automationCapabilityDoesNotRepresentAnEirenRole', await rejection(() => db.update(automations)
    .set({ approvedCapability: 'ADMIN' }).where(eq(automations.id, rule.id))));
  assert('automationAuthorizerIsSnowflake', await rejection(() => db.update(automations)
    .set({ authorizedBy: 'not-a-user' }).where(eq(automations.id, rule.id))));
  await db.insert(automationActions).values({ automationId: rule.id, position: 0, actionKey: 'STATIC_MESSAGE',
    actionVersion: 1, config: { text: 'synthetic' } });
  assert('automationActionPositionBounded', await rejection(() => db.insert(automationActions).values({
    automationId: rule.id, position: 2, actionKey: 'STATIC_MESSAGE', actionVersion: 1 })));
  assert('automationConfigJsonMustBeObject', await rejection(() => db.update(automations)
    .set({ triggerConfig: [] as never }).where(eq(automations.id, rule.id))));
  assert('automationRejectsArbitraryActionKind', await rejection(() => db.insert(automationActions).values({
    automationId: rule.id, position: 1, actionKey: 'HTTP_REQUEST', actionVersion: 1 })));
  const executionId = randomUUID();
  await db.insert(automationExecutions).values({ id: executionId, guildId, automationId: rule.id,
    triggerKey: `slot:${id}`, moduleEpoch: 1, configVersion: 1 });
  assert('automationTriggerDedupeUnique', await rejection(() => db.insert(automationExecutions).values({
    id: randomUUID(), guildId, automationId: rule.id, triggerKey: `slot:${id}`, moduleEpoch: 1, configVersion: 1 })));
  assert('automationCrossGuildFkRejectsObjectAccess', await rejection(() => db.insert(automationExecutions).values({
    id: randomUUID(), guildId: otherId, automationId: rule.id,
    triggerKey: `cross:${id}`, moduleEpoch: 1, configVersion: 1 })));
  assert('automationRejectsInvalidStatus', await rejection(() => db.update(automationExecutions)
    .set({ status: 'EXECUTING' }).where(eq(automationExecutions.id, executionId))));
  assert('automationRejectsUnsafeDepth', await rejection(() => db.update(automationExecutions)
    .set({ chainDepth: 3 }).where(eq(automationExecutions.id, executionId))));
  await db.insert(automationActionRuns).values({ executionId, position: 0 });
  assert('executionActionRunLinked', (await db.select().from(automationActionRuns)
    .where(eq(automationActionRuns.executionId, executionId))).length === 1);
  assert('executionActionPositionBounded', await rejection(() => db.insert(automationActionRuns).values({
    executionId, position: 2 })));
} catch (error) {
  checks.failedStage = stage;
  checks.errorClass = error instanceof Error ? error.constructor.name : 'unknown';
  const cause = error as { cause?: { code?: string; cause?: { code?: string } } };
  checks.pgCode = cause.cause?.code ?? cause.cause?.cause?.code ?? 'none';
  process.exitCode = 1;
} finally {
  if (connection) {
    try {
      const db = connection.db;
      await db.delete(guilds).where(eq(guilds.id, guildId));
      await db.delete(guilds).where(eq(guilds.id, otherId));
      const count = await db.execute(sql`SELECT
        (SELECT count(*) FROM guilds WHERE id IN (${guildId}, ${otherId})) +
        (SELECT count(*) FROM ai_requests WHERE guild_id IN (${guildId}, ${otherId})) +
        (SELECT count(*) FROM automation_executions WHERE guild_id IN (${guildId}, ${otherId})) AS count`);
      assert('syntheticV7FixturesRemoved', Number(count.rows[0]?.count) === 0);
    } catch (error) { checks.cleanupErrorClass = error instanceof Error ? error.constructor.name : 'unknown'; process.exitCode = 1; }
    try { await connection.pool.end(); } catch { checks.poolCloseFailed = true; process.exitCode = 1; }
  }
  checks.passedCount = Object.values(checks).filter(item => item === true).length;
  console.log(JSON.stringify(checks));
}
