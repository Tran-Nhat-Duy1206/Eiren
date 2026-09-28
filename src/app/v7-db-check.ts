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
