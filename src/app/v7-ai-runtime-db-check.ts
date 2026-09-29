import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { aiRequests, aiSettings, aiUsageDaily, guildModules, guilds } from '../core/database/schema.js';
import { PermissionService, type Actor } from '../core/permissions/permission-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { FakeAiProvider, fakeGate } from '../modules/ai/fake-provider.js';
import { AI_DEFAULT_LIMITS } from '../modules/ai/limits.js';
import { AiRepository } from '../modules/ai/repository.js';
import { AiRuntime } from '../modules/ai/runtime.js';
import { AiService } from '../modules/ai/service.js';

const connection = createDatabase(loadEnv().DATABASE_URL);
const db = connection.db, guildId = `v72a-fake-${randomUUID()}`;
const owner = '12345678901234567', member = '22345678901234567';
const actor = (userId: string): Actor => ({ guildId, userId, guildOwnerId: owner, roleIds: [] });
const model = { providerId: 'synthetic', modelId: 'local-fake', inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 4, maxInputTokens: 2048, maxOutputTokens: 512 };
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
  console.log(JSON.stringify(checks));
} catch (error) {
  console.error(JSON.stringify({ checks, errorType: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally {
  try { await db.delete(guilds).where(eq(guilds.id, guildId)); }
  finally { await connection.pool.end(); }
}
