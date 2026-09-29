import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { automations, automationActions, automationExecutions, automationExecutionActions, automationExecutionAttempts, automationActionRuns, guilds, guildModules } from '../../core/database/schema.js';
import { AppError } from '../../core/errors/errors.js';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS } from './contracts.js';
import { validateAutomationConfig } from './config.js';
import { nextScheduledOccurrence, type ScheduledConfig } from './schedule.js';
import { AUTOMATION_EXECUTION_TTL_MS, AUTOMATION_LEASE_MS, automationExecutionExpired, automationRetryDelayMs } from './retry.js';
import { assertAutomationStatusTransition } from './status.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type AutomationRuleInput = { name: string; enabled: boolean; triggerId: string; triggerVersion: number;
  triggerConfig: Record<string, unknown>; actions: { id: string; version: number; config: Record<string, unknown> }[];
  timezone: string; cooldownSeconds: number; approvedCapability: string; nextRunAt: Date | null };
const bad = (message: string): never => { throw new AppError('VALIDATION', message); };
const missing = (): never => { throw new AppError('NOT_FOUND', 'Automation not found'); };
const validDate = (date: Date | null | undefined) => date == null || (date instanceof Date && Number.isFinite(date.getTime()));
function validate(input: AutomationRuleInput) {
  if (typeof input.name !== 'string' || input.name.trim() !== input.name || input.name.length < 1 || input.name.length > 80 ||
      !Number.isInteger(input.cooldownSeconds) || input.cooldownSeconds < 0 || input.cooldownSeconds > 86400 ||
      !['SEND_MESSAGE', 'STAFF_LOG'].includes(input.approvedCapability) || !validDate(input.nextRunAt) ||
      typeof input.timezone !== 'string' || input.timezone.length < 1 || input.timezone.length > 64) bad('Invalid automation rule');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { bad('Invalid timezone'); }
  try { validateAutomationConfig({ schemaVersion: 1, enabled: input.enabled,
    trigger: { id: input.triggerId, version: input.triggerVersion, config: input.triggerConfig }, actions: input.actions },
  AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS); } catch { bad('Invalid automation configuration'); }
  if (input.triggerId !== 'SCHEDULED' || (input.triggerConfig.kind === 'daily' && input.triggerConfig.timezone !== input.timezone)) bad('Invalid scheduled timezone');
  const capability = input.actions.every(action => action.id === 'STAFF_LOG') ? 'STAFF_LOG' : 'SEND_MESSAGE';
  if (input.approvedCapability !== capability) bad('Invalid approved capability');
}
export class AutomationRepository {
  constructor(private readonly db: Database) {}
  private async serialize(tx: Tx) { await tx.execute(sql`SELECT pg_advisory_xact_lock(724099, 7303)`); }
  private async lockGuild(tx: Tx, guildId: string) {
    const [guild] = await tx.select({ id: guilds.id }).from(guilds).where(eq(guilds.id, guildId)).for('update');
    if (!guild) throw new AppError('NOT_FOUND', 'Guild not found');
  }
  private async capacity(tx: Tx, guildId: string, except?: number) {
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(automations)
      .where(and(eq(automations.guildId, guildId), eq(automations.enabled, true), isNull(automations.deletedAt),
        except === undefined ? undefined : sql`${automations.id} <> ${except}`));
    if ((count?.total ?? 0) >= 20) throw new AppError('CONFLICT', 'Enabled automation limit reached');
  }
  async create(guildId: string, authorizedBy: string, input: AutomationRuleInput) {
    validate(input);
    if (!/^[0-9]{17,20}$/.test(authorizedBy)) bad('Invalid authorizer');
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      await this.lockGuild(tx, guildId);
      if (input.enabled) await this.capacity(tx, guildId);
      const [rule] = await tx.insert(automations).values({ guildId, name: input.name, enabled: input.enabled,
        triggerKey: input.triggerId, triggerVersion: input.triggerVersion, triggerConfig: input.triggerConfig,
        timezone: input.timezone, cooldownSeconds: input.cooldownSeconds, approvedCapability: input.approvedCapability,
        nextRunAt: input.nextRunAt, authorizedBy }).returning();
      await tx.insert(automationActions).values(input.actions.map((action, position) => ({ automationId: rule!.id, position,
        actionKey: action.id, actionVersion: action.version, config: action.config })));
      return rule!;
    });
  }
  async get(guildId: string, id: number) {
    const [rule] = await this.db.select().from(automations).where(and(eq(automations.guildId, guildId), eq(automations.id, id), isNull(automations.deletedAt)));
    if (!rule) return null;
    const actions = await this.db.select().from(automationActions).where(eq(automationActions.automationId, id)).orderBy(automationActions.position);
    return { ...rule, actions };
  }
  async list(guildId: string) {
    return this.db.select().from(automations).where(and(eq(automations.guildId, guildId), isNull(automations.deletedAt))).orderBy(automations.id).limit(100);
  }
  async update(guildId: string, id: number, authorizedBy: string, input: AutomationRuleInput) {
    validate(input);
    if (!/^[0-9]{17,20}$/.test(authorizedBy)) bad('Invalid authorizer');
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      await this.lockGuild(tx, guildId);
      const [old] = await tx.select().from(automations).where(and(eq(automations.guildId, guildId), eq(automations.id, id), isNull(automations.deletedAt))).for('update');
      if (!old) return missing();
      if (input.enabled) await this.capacity(tx, guildId, id);
      const [rule] = await tx.update(automations).set({ name: input.name, enabled: input.enabled, triggerKey: input.triggerId,
        triggerVersion: input.triggerVersion, triggerConfig: input.triggerConfig, timezone: input.timezone,
        cooldownSeconds: input.cooldownSeconds, approvedCapability: input.approvedCapability, nextRunAt: input.nextRunAt,
        authorizedBy, configVersion: sql`${automations.configVersion} + 1`, updatedAt: new Date() })
        .where(and(eq(automations.guildId, guildId), eq(automations.id, id))).returning();
      await tx.delete(automationActions).where(eq(automationActions.automationId, id));
      await tx.insert(automationActions).values(input.actions.map((action, position) => ({ automationId: id, position,
        actionKey: action.id, actionVersion: action.version, config: action.config })));
      return rule!;
    });
  }
  async setEnabled(guildId: string, id: number, enabled: boolean) {
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      await this.lockGuild(tx, guildId);
      const [old] = await tx.select().from(automations).where(and(eq(automations.guildId, guildId), eq(automations.id, id), isNull(automations.deletedAt))).for('update');
      if (!old) return missing();
      if (enabled && !old.enabled) await this.capacity(tx, guildId, id);
      if (enabled === old.enabled) return old;
      const nextRunAt = enabled ? nextScheduledOccurrence(old.triggerConfig as ScheduledConfig, new Date()) : old.nextRunAt;
      const [rule] = await tx.update(automations).set({ enabled, nextRunAt, configVersion: sql`${automations.configVersion} + 1`, updatedAt: new Date() })
        .where(and(eq(automations.guildId, guildId), eq(automations.id, id))).returning();
      return rule!;
    });
  }
  async softDelete(guildId: string, id: number) {
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      await this.lockGuild(tx, guildId);
      const [rule] = await tx.update(automations).set({ enabled: false, deletedAt: new Date(), nextRunAt: null,
        configVersion: sql`${automations.configVersion} + 1`, updatedAt: new Date() })
        .where(and(eq(automations.guildId, guildId), eq(automations.id, id), isNull(automations.deletedAt))).returning();
      return Boolean(rule);
    });
  }
  private async enqueue(tx: Tx, guildId: string, id: number, triggerKey: string, at: Date, causationId?: string, depth = 0) {
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(triggerKey) || !Number.isSafeInteger(depth) || depth < 0 || depth > 2 ||
        !(at instanceof Date) || !Number.isFinite(at.getTime()) ||
        (causationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(causationId)))
      bad('Invalid execution request');
    const [module] = await tx.select().from(guildModules).where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, 'automation'))).for('update');
    const [rule] = await tx.select().from(automations).where(and(eq(automations.guildId, guildId), eq(automations.id, id), isNull(automations.deletedAt))).for('update');
    if (!rule) return missing();
    if (!module?.enabled || !rule.enabled) throw new AppError('DISABLED', 'Automation disabled');
    const [row] = await tx.insert(automationExecutions).values({ id: randomUUID(), guildId, automationId: id, triggerKey,
      moduleEpoch: module.version, configVersion: rule.configVersion, causationId, chainDepth: depth, createdAt: at,
      nextAttemptAt: at }).onConflictDoNothing().returning();
    if (row) {
      const actions = await tx.select().from(automationActions).where(eq(automationActions.automationId, id)).orderBy(automationActions.position);
      if (actions.length < 1 || actions.length > 2) throw new AppError('CONFLICT', 'Invalid automation actions');
      await tx.insert(automationExecutionActions).values(actions.map(action => ({ executionId: row.id, position: action.position,
        actionKey: action.actionKey, actionVersion: action.actionVersion, config: action.config })));
    }
    const [existing] = row ? [row] : await tx.select().from(automationExecutions).where(and(eq(automationExecutions.guildId, guildId),
      eq(automationExecutions.automationId, id), eq(automationExecutions.triggerKey, triggerKey)));
    return existing!;
  }
  async createExecution(guildId: string, id: number, triggerKey: string, now?: Date, causationId?: string, depth = 0) {
    return this.db.transaction(async tx => { await this.serialize(tx); return this.enqueue(tx, guildId, id, triggerKey, now ?? new Date(), causationId, depth); });
  }
  /** One occurrence per selected rule per tick; overdue occurrences are never replayed. */
  async generateDue(now?: Date) {
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      const time = now ?? new Date(); // The default clock starts after lock contention, not before it.
      if (!validDate(time)) bad('Invalid time');
      const due = await tx.select({ id: automations.id, guildId: automations.guildId }).from(automations)
        .where(and(eq(automations.enabled, true), isNull(automations.deletedAt), lte(automations.nextRunAt, time)))
        .orderBy(automations.nextRunAt, automations.id).limit(20);
      const output = [];
      for (const candidate of due.sort((a, b) => a.guildId.localeCompare(b.guildId) || a.id - b.id)) {
        await this.lockGuild(tx, candidate.guildId);
        const [rule] = await tx.select().from(automations).where(and(eq(automations.id, candidate.id), eq(automations.guildId, candidate.guildId),
          eq(automations.enabled, true), isNull(automations.deletedAt), lte(automations.nextRunAt, time))).for('update', { skipLocked: true });
        if (!rule) continue;
        const occurrence = rule.nextRunAt!;
        const next = nextScheduledOccurrence(rule.triggerConfig as ScheduledConfig, time);
        const [module] = await tx.select().from(guildModules).where(and(eq(guildModules.guildId, rule.guildId), eq(guildModules.moduleKey, 'automation'))).for('update');
        if (module?.enabled) output.push(await this.enqueue(tx, rule.guildId, rule.id, `scheduled:${occurrence.toISOString()}`, time));
        await tx.update(automations).set({ nextRunAt: next }).where(eq(automations.id, rule.id));
      }
      return output;
    });
  }
  /** Locks at most twenty eligible rows globally, then serializes budget under the guild row. */
  async claimDue(now?: Date) {
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      const selectionTime = now ?? new Date();
      if (!validDate(selectionTime)) bad('Invalid time');
      const found = await tx.execute(sql<{ id: string; guild_id: string }>`WITH ranked AS (
        SELECT e.id, e.guild_id, row_number() OVER (PARTITION BY e.guild_id ORDER BY e.created_at,e.id) AS rn
        FROM automation_executions e WHERE e.status = 'PENDING' AND e.created_at <= ${selectionTime}
        AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ${selectionTime})
      ) SELECT e.id,e.guild_id FROM automation_executions e JOIN ranked r ON r.id=e.id
        WHERE r.rn <= 2 ORDER BY e.created_at,e.id LIMIT 20 FOR UPDATE OF e SKIP LOCKED`);
      const claimed = [];
      for (const raw of [...found.rows].sort((a, b) => String(a.guild_id).localeCompare(String(b.guild_id)))) {
        const candidate = raw as { id: string; guild_id: string };
        const [pending] = await tx.select().from(automationExecutions).where(eq(automationExecutions.id, candidate.id));
        if (!pending || pending.status !== 'PENDING') continue;
        await this.lockGuild(tx, candidate.guild_id);
        const admittedAt = now ?? new Date(); // Never mint an already-expired lease after a guild-lock wait.
        if (automationExecutionExpired(pending.createdAt, admittedAt) || pending.attempts >= 5) {
          await tx.update(automationExecutions).set({ status: 'FAILED', safeErrorCode: 'RETRY_EXHAUSTED', completedAt: admittedAt,
            nextAttemptAt: null }).where(eq(automationExecutions.id, candidate.id));
          continue;
        }
        const [rates] = await tx.select({ minute: sql<number>`count(*) FILTER (WHERE ${automationExecutionAttempts.attemptedAt} > ${new Date(admittedAt.getTime() - 60_000)} AND ${automationExecutionAttempts.attemptedAt} <= ${admittedAt})::int`,
          hour: sql<number>`count(*)::int` }).from(automationExecutionAttempts).where(and(eq(automationExecutionAttempts.guildId, candidate.guild_id),
          gt(automationExecutionAttempts.attemptedAt, new Date(admittedAt.getTime() - 3_600_000)),
          lte(automationExecutionAttempts.attemptedAt, admittedAt)));
        if ((rates?.minute ?? 0) >= 10 || (rates?.hour ?? 0) >= 60) continue;
        const token = randomUUID();
        const [row] = await tx.update(automationExecutions).set({ status: 'RUNNING', claimToken: token,
          leaseUntil: new Date(admittedAt.getTime() + AUTOMATION_LEASE_MS), attempts: sql`${automationExecutions.attempts} + 1` })
          .where(and(eq(automationExecutions.id, candidate.id), lt(automationExecutions.attempts, 5))).returning();
        if (!row) continue;
        await tx.insert(automationExecutionAttempts).values({ id: randomUUID(), guildId: candidate.guild_id, executionId: row.id, attemptedAt: admittedAt });
        claimed.push(row);
      }
      return claimed;
    });
  }
  async finalizeClaim(guildId: string, executionId: string, token: string, currentAuthority: boolean, now?: Date) {
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      const [execution] = await tx.select().from(automationExecutions).where(and(eq(automationExecutions.guildId, guildId),
        eq(automationExecutions.id, executionId))).for('update');
      if (!execution || execution.status !== 'RUNNING' || execution.claimToken !== token || !execution.leaseUntil) return false;
      const [module] = await tx.select().from(guildModules).where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, 'automation'))).for('update');
      const [rule] = await tx.select().from(automations).where(and(eq(automations.guildId, guildId), eq(automations.id, execution.automationId))).for('update');
      const snapshots = await tx.select().from(automationExecutionActions).where(eq(automationExecutionActions.executionId, executionId)).orderBy(automationExecutionActions.position);
      const live = await tx.select().from(automationActions).where(eq(automationActions.automationId, execution.automationId)).orderBy(automationActions.position);
      const finalizedAt = now ?? new Date(); // Recheck the lease after row locks and external member lookup.
      if (!validDate(finalizedAt)) bad('Invalid time');
      if (execution.leaseUntil <= finalizedAt) return false;
      let safeConfig = false;
      if (rule) try {
        validateAutomationConfig({ schemaVersion: 1, enabled: rule.enabled,
          trigger: { id: rule.triggerKey, version: rule.triggerVersion, config: rule.triggerConfig },
          actions: snapshots.map(action => ({ id: action.actionKey, version: action.actionVersion, config: action.config })) },
        AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS);
        safeConfig = rule.approvedCapability === (snapshots.every(action => action.actionKey === 'STAFF_LOG') ? 'STAFF_LOG' : 'SEND_MESSAGE') &&
          (rule.triggerConfig.kind !== 'daily' || rule.triggerConfig.timezone === rule.timezone);
      } catch { /* Untrusted/manual database JSON cannot authorize any action. */ }
      const valid = safeConfig && currentAuthority === true && module?.enabled && module.version === execution.moduleEpoch && rule?.enabled && !rule.deletedAt &&
        rule.configVersion === execution.configVersion && snapshots.length > 0 && snapshots.length === live.length &&
        snapshots.every((item, index) => item.position === index && item.position === live[index]?.position &&
          item.actionKey === live[index]?.actionKey && item.actionVersion === live[index]?.actionVersion &&
          JSON.stringify(item.config) === JSON.stringify(live[index]?.config));
      await tx.update(automationExecutions).set({ status: 'SKIPPED', safeErrorCode: valid ? 'CORE_ONLY' : 'STALE_CONFIG',
        completedAt: finalizedAt, claimToken: null, leaseUntil: null }).where(eq(automationExecutions.id, executionId));
      return true;
    });
  }
  async recoverExpired(now?: Date) {
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      const time = now ?? new Date();
      if (!validDate(time)) bad('Invalid time');
      const rows = await tx.select().from(automationExecutions).where(and(eq(automationExecutions.status, 'RUNNING'),
        lt(automationExecutions.leaseUntil, time))).orderBy(automationExecutions.leaseUntil).limit(20).for('update', { skipLocked: true });
      for (const row of rows) {
        const [unsafe] = await tx.select({ position: automationActionRuns.position }).from(automationActionRuns)
          .where(and(eq(automationActionRuns.executionId, row.id), inArray(automationActionRuns.status, ['RUNNING', 'SUCCEEDED', 'UNCERTAIN']))).limit(1);
        const terminal = Boolean(unsafe) || row.attempts >= 5 || automationExecutionExpired(row.createdAt, time);
        const next = unsafe ? 'UNCERTAIN' : terminal ? 'FAILED' : 'PENDING';
        assertAutomationStatusTransition('RUNNING', next);
        await tx.update(automationExecutions).set({ status: next,
          safeErrorCode: unsafe ? 'ACTION_OUTCOME_UNKNOWN' : terminal ? 'RETRY_EXHAUSTED' : 'LEASE_EXPIRED',
          claimToken: null, leaseUntil: null, completedAt: terminal ? time : null,
          nextAttemptAt: terminal ? null : new Date(time.getTime() + automationRetryDelayMs(Math.max(1, row.attempts))) })
          .where(eq(automationExecutions.id, row.id));
      }
      return rows.length;
    });
  }
  async deferClaim(guildId: string, executionId: string, token: string, now?: Date) {
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      const [row] = await tx.select().from(automationExecutions).where(and(eq(automationExecutions.guildId, guildId),
        eq(automationExecutions.id, executionId))).for('update');
      if (!row || row.status !== 'RUNNING' || row.claimToken !== token || !row.leaseUntil) return false;
      const [unsafe] = await tx.select({ position: automationActionRuns.position }).from(automationActionRuns)
        .where(and(eq(automationActionRuns.executionId, executionId), inArray(automationActionRuns.status, ['RUNNING', 'SUCCEEDED', 'UNCERTAIN']))).limit(1);
      if (unsafe) return false;
      const deferredAt = now ?? new Date();
      if (!validDate(deferredAt)) bad('Invalid time');
      if (row.leaseUntil <= deferredAt) return false; // Expired owners leave recovery to classify ambiguity.
      const terminal = row.attempts >= 5 || automationExecutionExpired(row.createdAt, deferredAt);
      assertAutomationStatusTransition('RUNNING', terminal ? 'FAILED' : 'PENDING');
      await tx.update(automationExecutions).set({ status: terminal ? 'FAILED' : 'PENDING',
        safeErrorCode: terminal ? 'RETRY_EXHAUSTED' : 'RETRYABLE_INTERNAL', claimToken: null, leaseUntil: null,
        completedAt: terminal ? deferredAt : null, nextAttemptAt: terminal ? null :
          new Date(deferredAt.getTime() + automationRetryDelayMs(Math.max(1, row.attempts))) })
        .where(eq(automationExecutions.id, executionId));
      return true;
    });
  }
  async retryFailed(guildId: string, executionId: string, now?: Date) {
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      const retryAt = now ?? new Date();
      if (!validDate(retryAt)) bad('Invalid time');
      const [unsafe] = await tx.select({ position: automationActionRuns.position }).from(automationActionRuns)
        .where(and(eq(automationActionRuns.executionId, executionId), inArray(automationActionRuns.status, ['RUNNING', 'SUCCEEDED', 'UNCERTAIN']))).limit(1);
      if (unsafe) return false;
      assertAutomationStatusTransition('FAILED', 'PENDING');
      const [row] = await tx.update(automationExecutions).set({ status: 'PENDING', safeErrorCode: null, completedAt: null,
        nextAttemptAt: retryAt }).where(and(eq(automationExecutions.guildId, guildId), eq(automationExecutions.id, executionId),
        eq(automationExecutions.status, 'FAILED'), eq(automationExecutions.safeErrorCode, 'RETRYABLE_INTERNAL'),
        lt(automationExecutions.attempts, 5), gt(automationExecutions.createdAt, new Date(retryAt.getTime() - AUTOMATION_EXECUTION_TTL_MS)))).returning();
      return Boolean(row);
    });
  }
  async prune(now = new Date()) {
    return this.db.transaction(async tx => {
      await this.serialize(tx);
      const attempts = await tx.execute(sql`DELETE FROM automation_execution_attempts WHERE id IN (
        SELECT id FROM automation_execution_attempts WHERE attempted_at < ${new Date(now.getTime() - 3_600_000)} LIMIT 200)`);
      // Metadata is retained while executions may still be externally referenced; prune only old terminal rows.
      const executions = await tx.execute(sql`DELETE FROM automation_executions WHERE id IN (
        SELECT id FROM automation_executions WHERE status IN ('SUCCEEDED','SKIPPED','FAILED','UNCERTAIN')
        AND completed_at < ${new Date(now.getTime() - 90 * 86_400_000)} LIMIT 100)`);
      return { attempts: attempts.rowCount ?? 0, executions: executions.rowCount ?? 0 };
    });
  }
}
