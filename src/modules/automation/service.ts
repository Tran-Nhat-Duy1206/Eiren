import { AppError } from '../../core/errors/errors.js';
import type { Logger } from '../../core/logger/logger.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import { ScheduledStageError } from '../../app/v5-scheduler.js';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, AUTOMATION_LIMITS } from './contracts.js';
import { validateAutomationConfig, type AutomationConfig } from './config.js';
import { nextScheduledOccurrence, type ScheduledConfig } from './schedule.js';
import type { AutomationRepository, AutomationRuleInput, AutomationExecutionSummary, AutomationExecutionDetail } from './repository.js';
import type { AutomationDiscordGateway } from './discord-gateway.js';
import { createAutomationActionHandlerRegistry, resolveAutomationActionHandler } from './executor.js';
import { ZodError } from 'zod';

export type AutomationRuleDraft = Readonly<{ name: string; config: AutomationConfig;
  timezone: string; cooldownSeconds: number }>;
/** Fresh Discord member/roles lookup (never a historical actor or a cached permission snapshot). */
export type AutomationCurrentActor = (guildId: string, userId: string) => Promise<Actor | null>;

function validatedRule(draft: AutomationRuleDraft, now: Date): AutomationRuleInput {
  if (!draft || typeof draft.name !== 'string' || draft.name.trim() !== draft.name ||
    draft.name.length < 1 || draft.name.length > 80 ||
    typeof draft.timezone !== 'string' || draft.timezone.length < 1 || draft.timezone.length > 64 ||
    !Number.isSafeInteger(draft.cooldownSeconds) || draft.cooldownSeconds < 0 || draft.cooldownSeconds > 86_400)
    throw new AppError('VALIDATION', 'Invalid automation rule');
  try { new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone }); }
  catch { throw new AppError('VALIDATION', 'Invalid automation timezone'); }
  let config: AutomationConfig;
  try { config = validateAutomationConfig(draft.config, AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS); }
  catch { throw new AppError('VALIDATION', 'Invalid automation configuration'); }
  const triggerConfig = config.trigger.config as ScheduledConfig;
  if (config.trigger.id !== 'SCHEDULED' || (triggerConfig.kind === 'daily' && triggerConfig.timezone !== draft.timezone))
    throw new AppError('VALIDATION', 'Scheduled timezone must match the rule timezone');
  const capability = config.actions.every(action => action.id === 'STAFF_LOG') ? 'STAFF_LOG' : 'SEND_MESSAGE';
  const nextRunAt = config.enabled ? nextScheduledOccurrence(triggerConfig, now) : null;
  return { name: draft.name, enabled: config.enabled, triggerId: config.trigger.id,
    triggerVersion: config.trigger.version, triggerConfig: config.trigger.config as Record<string, unknown>,
    actions: config.actions.map(action => ({ id: action.id, version: action.version,
      config: action.config as Record<string, unknown> })), timezone: draft.timezone,
    cooldownSeconds: draft.cooldownSeconds, approvedCapability: capability, nextRunAt };
}

function boundedExternal<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // Promise.race observes late rejections: a timed-out Discord send is ambiguous, not retryable.
  return Promise.race([Promise.resolve().then(work), new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Automation external operation timed out')), timeoutMs);
  })]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Guild-scoped Automation management, optional fail-closed core-only mode, and bounded action dispatch. */
export class AutomationService {
  private readonly handlers: ReturnType<typeof createAutomationActionHandlerRegistry> | null;
  constructor(private readonly repository: AutomationRepository, private readonly permissions: PermissionService,
    private readonly currentActor: AutomationCurrentActor, private readonly logger: Logger,
    gateway?: AutomationDiscordGateway) {
    this.handlers = gateway ? createAutomationActionHandlerRegistry(gateway) : null;
  }

  async create(actor: Actor, draft: AutomationRuleDraft, now = new Date()) {
    await this.permissions.require(actor, 'ADMIN');
    return this.repository.create(actor.guildId, actor.userId, validatedRule(draft, now));
  }
  async inspect(actor: Actor, id: number) {
    await this.permissions.require(actor, 'ADMIN');
    const row = await this.repository.get(actor.guildId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Automation not found');
    return row;
  }
  async list(actor: Actor) {
    await this.permissions.require(actor, 'ADMIN');
    return this.repository.list(actor.guildId);
  }
  async listRecentExecutions(actor: Actor, automationId?: number, limit = 50): Promise<AutomationExecutionSummary[]> {
    await this.permissions.require(actor, 'ADMIN');
    return this.repository.listRecentExecutions(actor.guildId, automationId, limit);
  }
  async inspectExecution(actor: Actor, executionId: string): Promise<AutomationExecutionDetail> {
    await this.permissions.require(actor, 'ADMIN');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(executionId))
      throw new AppError('VALIDATION', 'Invalid execution identifier');
    const execution = await this.repository.inspectExecution(actor.guildId, executionId);
    if (!execution) throw new AppError('NOT_FOUND', 'Automation execution not found');
    return execution;
  }
  async update(actor: Actor, id: number, draft: AutomationRuleDraft, now = new Date()) {
    await this.permissions.require(actor, 'ADMIN');
    return this.repository.update(actor.guildId, id, actor.userId, validatedRule(draft, now));
  }
  async setEnabled(actor: Actor, id: number, enabled: boolean) {
    await this.permissions.require(actor, 'ADMIN');
    return this.repository.setEnabled(actor.guildId, id, enabled);
  }
  async delete(actor: Actor, id: number) {
    await this.permissions.require(actor, 'ADMIN');
    const removed = await this.repository.softDelete(actor.guildId, id);
    if (!removed) throw new AppError('NOT_FOUND', 'Automation not found');
    return true;
  }
  async createExecution(actor: Actor, id: number, triggerKey: string, now?: Date,
    causationId?: string, depth = 0) {
    await this.permissions.require(actor, 'ADMIN');
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > AUTOMATION_LIMITS.maxDepth)
      throw new AppError('VALIDATION', 'Automation chain depth exceeded');
    return this.repository.createExecution(actor.guildId, id, triggerKey, now, causationId, depth);
  }
  /** Explicit human resolution only; neither outcome launches another Discord action. */
  async reconcile(actor: Actor, executionId: string, position: number,
    result: 'CONFIRMED_SENT' | 'CONFIRMED_NOT_SENT', now?: Date) {
    // Reconciliation is a sensitive ADMIN-only state change, never authorized by a stale actor snapshot.
    const current = await this.currentActor(actor.guildId, actor.userId);
    if (!current || current.guildId !== actor.guildId || current.userId !== actor.userId)
      throw new AppError('PERMISSION', 'Current Eiren ADMIN membership required');
    await this.permissions.require(current, 'ADMIN');
    if (!Number.isSafeInteger(position) || position < 0 || position >= AUTOMATION_LIMITS.maxActions ||
        !['CONFIRMED_SENT', 'CONFIRMED_NOT_SENT'].includes(result))
      throw new AppError('VALIDATION', 'Invalid Automation reconciliation');
    const changed = await this.repository.reconcileUncertain(actor.guildId, executionId, position, actor.userId, result, now);
    if (!changed) throw new AppError('NOT_FOUND', 'Uncertain Automation action not found');
    return true;
  }

  /** Every external lookup and send runs AFTER a short DB transaction has ended. */
  async runDue(now?: Date) {
    const stage = async <T>(name: string, work: () => Promise<T>) => {
      try { return await work(); } catch (error) { throw new ScheduledStageError(name, error); }
    };
    const generated = await stage('automation.generate', () => this.repository.generateDue(now));
    const recovered = await stage('automation.recover', () => this.repository.recoverExpired(now));
    // Four bounded network workers; repository's default twenty-claim ceiling remains available to metadata callers.
    const claims = await stage('automation.claim', () => this.repository.claimDue(now, this.handlers ? 4 : 20));
    let finalized = 0, deferred = 0, uncertain = 0, blocked = 0, failures = 0;
    const worker = async (claim: typeof claims[number]) => {
      try {
        if (this.handlers) {
          const outcome = await this.runActionClaim(claim, now);
          if (outcome === 'finalized') finalized++;
          else if (outcome === 'deferred') deferred++;
          else if (outcome === 'uncertain') uncertain++;
          else blocked++;
        } else {
          // Explicitly unconfigured gateway is fail-closed; retained for core-only isolated tests.
          const rule = await stage('automation.rule', () => this.repository.get(claim.guildId, claim.automationId));
          let permitted = false;
          try {
            if (rule && rule.enabled && !rule.deletedAt) {
              const actor = await boundedExternal(() => this.currentActor(claim.guildId, rule.authorizedBy), 20_000);
              if (actor && actor.guildId === claim.guildId && actor.userId === rule.authorizedBy) {
                try { await this.permissions.require(actor, 'ADMIN'); permitted = true; }
                catch (error) { if (!(error instanceof AppError && error.code === 'PERMISSION')) throw error; }
              }
            }
          } catch {
            await stage('automation.defer', () => this.repository.deferClaim(claim.guildId, claim.id, claim.claimToken!, now));
            deferred++;
            return;
          }
          if (await stage('automation.finalize', () => this.repository.finalizeClaim(claim.guildId, claim.id,
            claim.claimToken!, permitted, now))) finalized++;
        }
      } catch (error) {
        failures++;
        this.logger.error({ job: 'automation', stage: error instanceof ScheduledStageError ? error.stage : 'automation.worker',
          errorType: error instanceof ScheduledStageError && error.cause instanceof Error ? error.cause.name :
            error instanceof Error ? error.name : 'unknown' }, 'Automation claim processing failed');
        // No implicit retry here: RUNNING action evidence is classified by bounded lease recovery.
      }
    };
    for (let index = 0; index < claims.length; index += 4)
      await Promise.all(claims.slice(index, index + 4).map(worker));
    const pruned = await stage('automation.prune', () => this.repository.prune(now));
    this.logger.debug({ job: 'automation', generated: generated.length, recovered, claimed: claims.length,
      finalized, deferred, uncertain, blocked, failures, ...pruned }, 'Automation maintenance complete');
    return { generated: generated.length, recovered, claimed: claims.length,
      finalized, deferred, uncertain, blocked, failures, ...pruned };
  }

  private async runActionClaim(claim: Awaited<ReturnType<AutomationRepository['claimDue']>>[number], now?: Date):
    Promise<'finalized' | 'deferred' | 'uncertain' | 'blocked'> {
    const guildId = claim.guildId, id = claim.id, token = claim.claimToken!;
    const view = await this.repository.getClaimActions(guildId, id, token);
    if (!view) return 'blocked';
    if (!view.actions.length || view.actions.length > AUTOMATION_LIMITS.maxActions) {
      await this.repository.prepareAction(guildId, id, token, 0, false, now);
      return 'blocked';
    }
    let priorSuccess = false;
    for (const snapshot of view.actions) {
      const handler = resolveAutomationActionHandler(snapshot.actionKey, snapshot.actionVersion, this.handlers!);
      if (!handler) {
        await this.repository.stopBeforeDispatch(guildId, id, token, snapshot.position, 'UNKNOWN_ACTION', now);
        return 'blocked'; // LEGACY_INERT has no registered handler.
      }
      const rule = await this.repository.get(guildId, view.automationId);
      if (!rule || !rule.enabled || rule.deletedAt) {
        await this.repository.stopBeforeDispatch(guildId, id, token, snapshot.position, 'STALE_CONFIG', now);
        return 'blocked';
      }
      let authorized = false;
      try {
        const actor = await boundedExternal(() => this.currentActor(guildId, rule.authorizedBy), 20_000);
        if (actor && actor.guildId === guildId && actor.userId === rule.authorizedBy) {
          try { await this.permissions.require(actor, 'ADMIN'); authorized = true; }
          catch (error) { if (!(error instanceof AppError && error.code === 'PERMISSION')) throw error; }
        }
      } catch {
        if (!priorSuccess && await this.repository.deferClaim(guildId, id, token, now)) return 'deferred';
        await this.repository.stopBeforeDispatch(guildId, id, token, snapshot.position, 'AUTH_UNAVAILABLE', now);
        return 'blocked';
      }
      if (!authorized) {
        await this.repository.stopBeforeDispatch(guildId, id, token, snapshot.position, 'AUTH_REVOKED', now);
        return 'blocked';
      }
      let preflight: Awaited<ReturnType<typeof handler.preflight>>;
      try { preflight = await boundedExternal(() => handler.preflight(guildId, snapshot.config), 20_000); }
      catch (error) {
        if (error instanceof ZodError) {
          await this.repository.stopBeforeDispatch(guildId, id, token, snapshot.position, 'INVALID_ACTION', now);
        } else if (!priorSuccess && await this.repository.deferClaim(guildId, id, token, now)) return 'deferred';
        else await this.repository.stopBeforeDispatch(guildId, id, token, snapshot.position, 'PREFLIGHT_UNAVAILABLE', now);
        return 'blocked';
      }
      if (preflight.kind === 'BLOCKED') {
        await this.repository.stopBeforeDispatch(guildId, id, token, snapshot.position, preflight.code, now);
        return 'blocked';
      }
      // Final transaction fences current module, rule, snapshots, order and active lease,
      // then COMMITs a durable RUNNING action before any network send is invoked.
      const ready = await this.repository.prepareAction(guildId, id, token, snapshot.position, true, now);
      if (ready.kind !== 'READY') return 'blocked';
      if (ready.snapshot.actionKey !== snapshot.actionKey || ready.snapshot.actionVersion !== snapshot.actionVersion ||
          JSON.stringify(ready.snapshot.config) !== JSON.stringify(snapshot.config)) {
        await this.repository.markAmbiguous(guildId, id, token, snapshot.position, now, ready.dispatchToken);
        return 'uncertain';
      }
      let messageId: string;
      try { messageId = await boundedExternal(preflight.send, handler.definition.timeoutMs); }
      catch {
        // After send invocation even a timeout/throw can mean Discord accepted the message.
        await this.repository.markAmbiguous(guildId, id, token, snapshot.position, now, ready.dispatchToken);
        return 'uncertain';
      }
      try {
        const recorded = await this.repository.confirmAction(guildId, id, token, snapshot.position,
          messageId, now, ready.dispatchToken);
        if (!recorded) return 'uncertain'; // No second effect after stale claim or failed receipt.
      } catch {
        // Discord already returned success. Retain RUNNING evidence; recovery makes it UNCERTAIN.
        return 'uncertain';
      }
      priorSuccess = true;
    }
    return priorSuccess ? 'finalized' : 'blocked';
  }
}
