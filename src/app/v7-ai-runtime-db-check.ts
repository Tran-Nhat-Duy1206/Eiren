import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { aiRequests, aiSettings, aiUsageDaily, guildModules, guilds } from '../core/database/schema.js';
import { PermissionService, type Actor } from '../core/permissions/permission-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { FakeAiProvider, fakeGate } from '../modules/ai/fake-provider.js';
import { AI_DEFAULT_LIMITS } from '../modules/ai/limits.js';
import { AiRepository, maximumCostMicros } from '../modules/ai/repository.js';
import { AiRuntime } from '../modules/ai/runtime.js';
import { AiService } from '../modules/ai/service.js';

const connection = createDatabase(loadEnv().DATABASE_URL);
const db = connection.db, guildId = `v72a-fake-${randomUUID()}`;
const framingGuildId = `v72a-framing-${randomUUID()}`;
const budgetGuildId = `v72a-budget-${randomUUID()}`;
const probeGuildId = `v72a-oldprobe-${randomUUID()}`;
const owner = '12345678901234567', member = '22345678901234567';
const actor = (userId: string): Actor => ({ guildId, userId, guildOwnerId: owner, roleIds: [] });
const model = { providerId: 'synthetic', modelId: 'local-fake', inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 4, maxInputTokens: 2048, maxOutputTokens: 512, requestOverheadTokens: 32 };
const checks: Record<string, boolean> = {};
function check(name: string, result: boolean) { checks[name] = result; if (!result) throw new Error(name); }
try {
  await db.insert(guilds).values({ id: guildId });
  await db.insert(guildModules).values({ guildId, moduleKey: 'ai', enabled: true, updatedBy: owner });
  // Synthetic server-approved config bootstrap: no MEMBER-facing mutation or real credential.
  await db.insert(aiSettings).values({ guildId, providerId: model.providerId, modelId: model.modelId });
  const guildsRepo = new GuildRepository(db);
  const service = new AiService(new AiRepository(db), new PermissionService(guildsRepo), {
    providerId: model.providerId, models: [model], policy: { ...AI_DEFAULT_LIMITS,
      providerId: model.providerId, modelId: model.modelId }, timeoutMs: 1000,
    globalDailyBudgetMicros: 5_000_000, globalMonthlyBudgetMicros: 50_000_000,
  });
  const gate = fakeGate();
  const fake = new FakeAiProvider([
    { kind: 'success', response: { text: 'Local answer' } },
    { kind: 'success', response: { text: 'Local summary' } },
    { kind: 'delay', gate: gate.promise, response: { text: 'Old-epoch output' } },
  ], [model]);
  let signalProviderEntered!: () => void;
  const providerEntered = new Promise<void>(resolve => { signalProviderEntered = resolve; });
  const runtime = new AiRuntime(service, { capabilities: fake.capabilities, generate: request => {
    const pending = fake.generate(request);
    if (fake.requests.length === 3) signalProviderEntered();
    return pending;
  } });
  const ingress = await service.reserveIngress(guildId);
  const first = await runtime.run({ ingress, actor: actor(owner), requestKey: `ask-${guildId}`,
    mode: 'ask', text: 'Hello' });
  check('fakeAskWithRealPostgresAdmission', first.kind === 'ok' && first.text === 'Local answer');
  const [askRow] = await db.select().from(aiRequests)
    .where(and(eq(aiRequests.guildId, guildId), eq(aiRequests.requestKey, `ask-${guildId}`)));
  const firstRequest = fake.requests[0];
  const completeEstimate = firstRequest && Buffer.byteLength(firstRequest.instructions, 'utf8') +
    Buffer.byteLength(firstRequest.userInput, 'utf8') + model.requestOverheadTokens;
  check('completeInputCostReservedBeforeFakeDispatch', Boolean(askRow && firstRequest && completeEstimate &&
    askRow.reservedInputTokens === completeEstimate &&
    askRow.reservedCostMicros === maximumCostMicros(model, completeEstimate, AI_DEFAULT_LIMITS.maxOutputTokens) &&
    askRow.actualInputTokens === 1));
  const second = await runtime.run({ ingress, actor: actor(member), requestKey: `summary-${guildId}`,
    mode: 'summarize', text: 'Only this pasted text.' });
  check('fakeSummarizeWithRealPostgresAdmission', second.kind === 'ok' && second.text === 'Local summary');
  check('noExternalAdapterOrImplicitContext', fake.requests.length === 2 && fake.requests.every(request =>
    !('context' in request) && !('endpoint' in request)));
  const pending = runtime.run({ ingress, actor: actor('32345678901234567'), requestKey: `old-epoch-${guildId}`,
    mode: 'ask', text: 'Delayed explicit request' });
  await providerEntered;
  check('fakeProviderEnteredBeforeDisable', fake.requests.length === 3);
  await guildsRepo.setModuleState(guildId, 'ai', false, owner);
  await guildsRepo.setModuleState(guildId, 'ai', true, owner);
  gate.release();
  const result = await pending;
  check('oldEpochCannotDeliverFakeOutput', result.kind === 'unavailable');
  const [billed] = await db.select().from(aiRequests).where(and(eq(aiRequests.guildId, guildId), eq(aiRequests.requestKey, `old-epoch-${guildId}`)));
  const [daily] = await db.select().from(aiUsageDaily).where(eq(aiUsageDaily.guildId, guildId));
  check('realPostgresBillsDisabledInflightMetadata', billed?.status === 'SETTLED' &&
    billed.actualCostMicros !== null && daily?.reservedCostMicros === 0 && daily?.requests === 3);
  const replay = await runtime.run({ ingress, actor: actor('42345678901234567'),
    requestKey: `stale-${guildId}`, mode: 'ask', text: 'Old interaction' });
  check('oldEpochNeverDispatchesFakeProvider', replay.kind === 'limited' && fake.requests.length === 3 &&
    !(await db.select().from(aiRequests).where(and(eq(aiRequests.guildId, guildId), eq(aiRequests.requestKey, `stale-${guildId}`)))).length);
  await runtime.stop();

  // This tiny approved model fits the old user-only UTF-8 estimate, but cannot fit
  // the complete trusted instruction + user text + server-approved request framing.
  const framingModel = { ...model, maxInputTokens: 32, requestOverheadTokens: 8 };
  const framingText = 'fit';
  check('oldUserOnlyEstimateFitsModel', Buffer.byteLength(framingText, 'utf8') <= framingModel.maxInputTokens);
  await db.insert(guilds).values({ id: framingGuildId });
  await db.insert(guildModules).values({ guildId: framingGuildId, moduleKey: 'ai', enabled: true, updatedBy: owner });
  await db.insert(aiSettings).values({ guildId: framingGuildId, providerId: framingModel.providerId,
    modelId: framingModel.modelId });
  const framingService = new AiService(new AiRepository(db), new PermissionService(guildsRepo), {
    providerId: framingModel.providerId, models: [framingModel], policy: { ...AI_DEFAULT_LIMITS,
      providerId: framingModel.providerId, modelId: framingModel.modelId }, timeoutMs: 1000,
    globalDailyBudgetMicros: 5_000_000, globalMonthlyBudgetMicros: 50_000_000,
  });
  const framingProvider = new FakeAiProvider([], [framingModel]);
  const framingRuntime = new AiRuntime(framingService, framingProvider);
  const framingIngress = await framingService.reserveIngress(framingGuildId);
  const framingKey = `framing-${framingGuildId}`;
  const framingResult = await framingRuntime.run({ ingress: framingIngress,
    actor: { guildId: framingGuildId, userId: owner, guildOwnerId: owner, roleIds: [] },
    requestKey: framingKey, mode: 'ask', text: framingText });
  check('completeRequestRejectedBeforeProvider',
    (framingResult.kind === 'limited' || framingResult.kind === 'too_large') && framingProvider.requests.length === 0);
  const framingRequests = await db.select().from(aiRequests).where(eq(aiRequests.guildId, framingGuildId));
  const framingUsage = await db.select().from(aiUsageDaily).where(eq(aiUsageDaily.guildId, framingGuildId));
  check('framingRejectionDoesNotReserveRequestOrCost', framingRequests.length === 0 &&
    framingUsage.every(day => day.requests === 0 && day.reservedCostMicros === 0 && day.settledCostMicros === 0));
  await framingRuntime.stop();

  // Real PostgreSQL budget race: user-only tokens fit the entire daily cap, while
  // trusted instructions and approved framing push the complete reservation above it.
  const budgetText = 'fit';
  const oldUserOnlyCost = maximumCostMicros(model, Buffer.byteLength(budgetText, 'utf8'), AI_DEFAULT_LIMITS.maxOutputTokens);
  await db.insert(guilds).values({ id: budgetGuildId });
  await db.insert(guildModules).values({ guildId: budgetGuildId, moduleKey: 'ai', enabled: true, updatedBy: owner });
  await db.insert(aiSettings).values({ guildId: budgetGuildId, providerId: model.providerId,
    modelId: model.modelId, monthlyBudgetMicros: oldUserOnlyCost });
  const budgetService = new AiService(new AiRepository(db), new PermissionService(guildsRepo), {
    providerId: model.providerId, models: [model], policy: { ...AI_DEFAULT_LIMITS,
      providerId: model.providerId, modelId: model.modelId }, timeoutMs: 1000,
    globalDailyBudgetMicros: 5_000_000, globalMonthlyBudgetMicros: 50_000_000,
  });
  const budgetFake = new FakeAiProvider([], [model]);
  const budgetIngress = await budgetService.reserveIngress(budgetGuildId);
  const budgetResult = await new AiRuntime(budgetService, budgetFake).run({ ingress: budgetIngress,
    actor: { guildId: budgetGuildId, userId: owner, guildOwnerId: owner, roleIds: [] },
    requestKey: `budget-${budgetGuildId}`, mode: 'ask', text: budgetText });
  const budgetRequests = await db.select().from(aiRequests).where(eq(aiRequests.guildId, budgetGuildId));
  const [budgetDay] = await db.select().from(aiUsageDaily).where(eq(aiUsageDaily.guildId, budgetGuildId));
  check('userOnlyBudgetWouldFitButCompleteRequestCannotDispatch',
    oldUserOnlyCost > 0 && budgetResult.kind === 'limited' && budgetFake.requests.length === 0 &&
    budgetRequests.length === 0 && budgetDay?.requests === 0 && budgetDay.reservedCostMicros === 0 &&
    budgetDay.settledCostMicros === 0 && budgetDay.rejected === 1);
  // Independent control proves the old user-only estimate really would pass every
  // PostgreSQL gate, rather than inferring this from a rejection by another quota.
  await db.insert(guilds).values({ id: probeGuildId });
  await db.insert(guildModules).values({ guildId: probeGuildId, moduleKey: 'ai', enabled: true, updatedBy: owner });
  await db.insert(aiSettings).values({ guildId: probeGuildId, providerId: model.providerId,
    modelId: model.modelId, monthlyBudgetMicros: oldUserOnlyCost });
  const probeRepository = new AiRepository(db);
  const probeIngress = await probeRepository.reserveIngress(probeGuildId);
  const oldProbe = probeIngress && await probeRepository.admit({ ingress: probeIngress, userId: owner,
    requestKey: `oldprobe-${probeGuildId}`, inputCharacters: budgetText.length,
    estimatedInputTokens: Buffer.byteLength(budgetText, 'utf8'),
    maxOutputTokens: AI_DEFAULT_LIMITS.maxOutputTokens, model, policy: { ...AI_DEFAULT_LIMITS,
      providerId: model.providerId, modelId: model.modelId }, globalDailyBudgetMicros: 5_000_000,
    globalMonthlyBudgetMicros: 50_000_000 });
  check('oldUserOnlyControlActuallyAdmitsUnderSameGuildCap',
    oldProbe?.reservedCostMicros === oldUserOnlyCost && oldProbe.reservedInputTokens === 3);
  console.log(JSON.stringify(checks));
} catch (error) {
  console.error(JSON.stringify({ checks, errorType: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally {
  try {
    await db.delete(guilds).where(eq(guilds.id, probeGuildId));
    await db.delete(guilds).where(eq(guilds.id, budgetGuildId));
    await db.delete(guilds).where(eq(guilds.id, framingGuildId));
    await db.delete(guilds).where(eq(guilds.id, guildId));
  } finally { await connection.pool.end(); }
}
