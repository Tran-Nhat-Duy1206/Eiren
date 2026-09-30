import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { automationExecutions, guilds, guildModules } from '../core/database/schema.js';
import { PermissionService, type Actor } from '../core/permissions/permission-service.js';
import { GuildRepository } from '../repositories/guild-repository.js';
import { AutomationRepository } from '../modules/automation/repository.js';
import { AutomationService, type AutomationRuleDraft } from '../modules/automation/service.js';

const connection = createDatabase(loadEnv().DATABASE_URL);
const { db } = connection;
const guildId = `v7-dashboard-${randomUUID()}`, otherId = `v7-dashboard-${randomUUID()}`;
const owner = '12345678901234567', member = '22345678901234567', receipt = '32345678901234567';
const actor = (id: string, userId = owner): Actor => ({ guildId: id, userId, guildOwnerId: owner, roleIds: [] });
const at = (seconds: number) => new Date(Date.UTC(2031, 0, 1, 0, 0, seconds));
const draft: AutomationRuleDraft = { name: 'Named historical automation', timezone: 'UTC', cooldownSeconds: 0,
  config: { schemaVersion: 1, enabled: true, trigger: { id: 'SCHEDULED', version: 1,
    config: { kind: 'daily', time: '12:00', timezone: 'UTC' } }, actions: [0, 1].map(position => ({
    id: 'STAFF_LOG', version: 1, config: { channelId: owner, message: `Sensitive snapshot ${position}` },
  })) } };
const repo = new AutomationRepository(db);
const service = new AutomationService(repo, new PermissionService(new GuildRepository(db)),
  async (id, userId) => actor(id, userId), { debug() {}, error() {} } as never);
const checks: Record<string, boolean> = {};
function check(name: string, result: boolean) { checks[name] = result; if (!result) throw new Error(name); }
async function errorCode(work: () => Promise<unknown>) {
  try { await work(); return 'NO_ERROR'; } catch (error) { return (error as { code?: string }).code; }
}
try {
  await db.insert(guilds).values([{ id: guildId }, { id: otherId }]);
  await db.insert(guildModules).values([guildId, otherId].map(id => ({ guildId: id, moduleKey: 'automation', enabled: true,
    updatedBy: owner, version: 1 })));
  const rule = await service.create(actor(guildId), draft, at(0));
  const foreignRule = await service.create(actor(otherId), draft, at(0));
  const queued = await repo.createExecution(guildId, rule.id, 'dashboard-ambiguous', at(0));
  const foreign = await repo.createExecution(otherId, foreignRule.id, 'dashboard-foreign', at(0));
  check('adminOnlyAndValidatedParameters', await errorCode(() => service.listRecentExecutions(actor(guildId, member))) === 'PERMISSION' &&
    await errorCode(() => service.inspectExecution(actor(guildId, member), queued.id)) === 'PERMISSION' &&
    await errorCode(() => service.inspectExecution(actor(guildId), 'invalid-id')) === 'VALIDATION' &&
    await errorCode(() => service.listRecentExecutions(actor(guildId), undefined, 101)) === 'VALIDATION' &&
    await errorCode(() => service.listRecentExecutions(actor(guildId), 0)) === 'VALIDATION');
  check('guildIsolationAndCrossGuildInspectDenied', !(await service.listRecentExecutions(actor(guildId))).some(item => item.id === foreign.id) &&
    (await repo.inspectExecution(guildId, foreign.id)) === null &&
    await errorCode(() => service.inspectExecution(actor(guildId), foreign.id)) === 'NOT_FOUND');
  const initial = await service.inspectExecution(actor(guildId), queued.id);
  check('safeProjectionAndPendingActions', Object.keys(initial).sort().join(',') ===
    'actions,attempts,automationId,automationName,completedAt,configVersion,createdAt,id,moduleEpoch,reconciliation,safeErrorCode,status,triggerKey' &&
    initial.actions.length === 2 && initial.actions.every(action => action.status === 'PENDING' && action.attempts === 0 && action.updatedAt === null &&
      Object.keys(action).sort().join(',') === 'actionKey,actionVersion,attempts,discordMessageId,position,reconciledAt,reconciledBy,reconciliationResult,safeErrorCode,status,updatedAt') &&
    !JSON.stringify(initial).includes('Sensitive snapshot'));
  const claim = (await repo.claimDue(at(1))).find(item => item.id === queued.id)!;
  const prepared = await repo.prepareAction(guildId, queued.id, claim.claimToken!, 0, true, at(2));
  if (prepared.kind !== 'READY') throw new Error('prepare action 0');
  await repo.confirmAction(guildId, queued.id, claim.claimToken!, 0, receipt, at(3), prepared.dispatchToken);
  await repo.recoverExpired(at(62));
  const partial = await service.inspectExecution(actor(guildId), queued.id);
  check('priorReceiptNextPendingAllowsNotSentOnly', partial.status === 'UNCERTAIN' && partial.actions[0]?.discordMessageId === receipt &&
    partial.reconciliation.length === 2 && partial.reconciliation[1]?.position === 1 &&
    partial.reconciliation[1].allowNotSent && !partial.reconciliation[1].allowSent &&
    partial.reconciliation[0]?.allowSent === true && partial.reconciliation[0]?.allowNotSent === false);
  const second = await repo.createExecution(guildId, rule.id, 'dashboard-uncertain', at(10));
  const secondClaim = (await repo.claimDue(at(11))).find(item => item.id === second.id)!;
  const ready = await repo.prepareAction(guildId, second.id, secondClaim.claimToken!, 0, true, at(12));
  if (ready.kind !== 'READY') throw new Error('prepare ambiguous action');
  await repo.markAmbiguous(guildId, second.id, secondClaim.claimToken!, 0, at(13), ready.dispatchToken);
  const ambiguous = await service.inspectExecution(actor(guildId), second.id);
  check('uncertainActionAllowsBothOutcomes', ambiguous.reconciliation.length === 1 &&
    ambiguous.reconciliation[0]?.position === 0 && ambiguous.reconciliation[0].allowSent && ambiguous.reconciliation[0].allowNotSent &&
    !JSON.stringify(ambiguous).includes(ready.dispatchToken));
  await repo.confirmAction(guildId, second.id, secondClaim.claimToken!, 0, receipt, at(14), ready.dispatchToken);
  const late = await service.inspectExecution(actor(guildId), second.id);
  check('lateConfirmedReceiptAllowsSentOnly', late.reconciliation.find(item => item.position === 0)?.allowSent === true &&
    late.reconciliation.find(item => item.position === 0)?.allowNotSent === false && late.actions[0]?.discordMessageId === receipt);
  for (let index = 0; index < 52; index++)
    await repo.createExecution(guildId, rule.id, `dashboard-order-${index}`, at(20 + index));
  const recent = await service.listRecentExecutions(actor(guildId));
  check('boundedNewestFirstAndFiltered', recent.length === 50 && recent[0]?.triggerKey === 'dashboard-order-51' &&
    recent.at(-1)?.triggerKey === 'dashboard-order-2' && recent.every(item => item.automationName === draft.name) &&
    (await service.listRecentExecutions(actor(guildId), rule.id, 2)).length === 2);
  await service.delete(actor(guildId), rule.id);
  check('deletedRuleHistoryVisible', (await service.inspectExecution(actor(guildId), queued.id)).automationName === draft.name &&
    (await service.listRecentExecutions(actor(guildId), rule.id, 1))[0]?.automationName === draft.name);
  console.log(JSON.stringify({ suite: 'v7-automation-dashboard-db', checks, count: Object.keys(checks).length }));
} finally {
  await db.delete(guilds).where(eq(guilds.id, guildId));
  await db.delete(guilds).where(eq(guilds.id, otherId));
  await connection.pool.end();
}
