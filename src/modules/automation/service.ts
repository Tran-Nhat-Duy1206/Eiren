import { AppError } from '../../core/errors/errors.js';
import type { Logger } from '../../core/logger/logger.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import { ScheduledStageError } from '../../app/v5-scheduler.js';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, AUTOMATION_LIMITS } from './contracts.js';
import { validateAutomationConfig, type AutomationConfig } from './config.js';
import { nextScheduledOccurrence, type ScheduledConfig } from './schedule.js';
import type { AutomationRepository, AutomationRuleInput } from './repository.js';

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

/** Automation metadata only. No method can invoke a Discord action. */
export class AutomationService {
  constructor(private readonly repository: AutomationRepository, private readonly permissions: PermissionService,
    private readonly currentActor: AutomationCurrentActor, private readonly logger: Logger) {}

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

  /** DB transactions end before fresh Discord member lookup; final DB fence follows it. */
  async runDue(now?: Date) {
    const stage = async <T>(name: string, work: () => Promise<T>) => {
      try { return await work(); } catch (error) { throw new ScheduledStageError(name, error); }
    };
    const generated = await stage('automation.generate', () => this.repository.generateDue(now));
    const recovered = await stage('automation.recover', () => this.repository.recoverExpired(now));
    const claims = await stage('automation.claim', () => this.repository.claimDue(now));
    let finalized = 0, deferred = 0;
    for (const claim of claims) {
      // No action is run: authorization here only determines safe terminal metadata.
      let permitted = false;
      try {
        const rule = await stage('automation.rule', () => this.repository.get(claim.guildId, claim.automationId));
        if (rule && rule.enabled && !rule.deletedAt) {
          const actor = await this.currentActor(claim.guildId, rule.authorizedBy);
          if (actor && actor.guildId === claim.guildId && actor.userId === rule.authorizedBy) {
            try { await this.permissions.require(actor, 'ADMIN'); permitted = true; }
            catch (error) { if (!(error instanceof AppError && error.code === 'PERMISSION')) throw error; }
          }
        }
      } catch {
        // A transient lookup failure is not evidence that a former ADMIN is still authorized.
        await stage('automation.defer', () => this.repository.deferClaim(claim.guildId, claim.id, claim.claimToken!, now));
        deferred++;
        continue;
      }
      if (await stage('automation.finalize', () => this.repository.finalizeClaim(claim.guildId, claim.id,
        claim.claimToken!, permitted, now))) finalized++;
    }
    const pruned = await stage('automation.prune', () => this.repository.prune(now));
    this.logger.debug({ job: 'automation', generated: generated.length, recovered, claimed: claims.length,
      finalized, deferred, ...pruned }, 'Inert automation core maintenance complete');
    return { generated: generated.length, recovered, claimed: claims.length, finalized, deferred, ...pruned };
  }
}
