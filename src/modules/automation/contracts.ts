import type { PermissionLevel } from '../../core/permissions/permission-service.js';
import type { ZodType } from 'zod';

/** Contract only: no registered item implies an executable automation. */
export const AUTOMATION_SCHEMA_VERSION = 1;
export const AUTOMATION_LIMITS = Object.freeze({ maxEnabled: 20, maxActions: 2, maxDepth: 2, maxStaticMessageLength: 1000,
  futureClaimsPerTick: 20, futureClaimsPerGuild: 2, executionsPerMinute: 10, executionsPerHour: 60, retryAttempts: 5 });
export const AUTOMATION_CONFIGURE_PERMISSION: PermissionLevel = 'ADMIN';
export type AutomationRuntimePrerequisite = 'GUILD_AVAILABLE' | 'CHANNEL_AVAILABLE' | 'BOT_SEND_MESSAGES' | 'MODULE_ENABLED';
export type AutomationIdempotency = 'IDEMPOTENT' | 'DEDUPLICATED' | 'NON_IDEMPOTENT';
export type AutomationDiscordSideEffect = 'NONE' | 'SEND_MESSAGE' | 'MODIFY_DISCORD_STATE';
export type AutomationCapability = Readonly<{
  /** Who may configure this definition; never grants the bot runtime permissions. */
  configurePermission: PermissionLevel;
  /** Runtime bot requirements are independently checked by a future executor. */
  runtimePrerequisites: readonly AutomationRuntimePrerequisite[];
  discordSideEffect: AutomationDiscordSideEffect;
}>;
export type AutomationTriggerDefinition = Readonly<{
  id: string; version: number; schemaVersion: number; capability: AutomationCapability;
  timeoutMs: number; idempotency: AutomationIdempotency;
  /** Configuration must match the trusted definition schema, not merely be JSON-shaped. */
  configSchema: ZodType<Record<string, unknown>>;
  /** Metadata only; handlers are intentionally absent. */
  runnable: false;
}>;
export type AutomationActionDefinition = AutomationTriggerDefinition & Readonly<{ maxStaticMessageLength: number }>;
export type AutomationExecutionContext = Readonly<{
  guildId: string; automationId: string; executionId: string; depth: number;
  triggerId: string; triggerVersion: number; createdAt: Date;
}>;
export const AUTOMATION_TRIGGERS: readonly AutomationTriggerDefinition[] = Object.freeze([]);
export const AUTOMATION_ACTIONS: readonly AutomationActionDefinition[] = Object.freeze([]);

// Registry identifiers match the fixed, non-executable keys permitted by the V7.1 SQL checks.
const idPattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const prerequisites: readonly AutomationRuntimePrerequisite[] = ['GUILD_AVAILABLE', 'CHANNEL_AVAILABLE', 'BOT_SEND_MESSAGES', 'MODULE_ENABLED'];
const effects: readonly AutomationDiscordSideEffect[] = ['NONE', 'SEND_MESSAGE', 'MODIFY_DISCORD_STATE'];
const idempotencies: readonly AutomationIdempotency[] = ['IDEMPOTENT', 'DEDUPLICATED', 'NON_IDEMPOTENT'];
export function validateAutomationRegistry(triggers: readonly AutomationTriggerDefinition[], actions: readonly AutomationActionDefinition[]): void {
  for (const entries of [triggers, actions]) {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!idPattern.test(entry.id) || ids.has(entry.id)) throw new Error('Invalid or duplicate automation definition id');
      ids.add(entry.id);
      if (entry.schemaVersion !== AUTOMATION_SCHEMA_VERSION || !Number.isSafeInteger(entry.version) || entry.version < 1 || entry.runnable !== false ||
          !entry.configSchema || typeof entry.configSchema.safeParse !== 'function')
        throw new Error('Unsupported automation definition version or configuration schema');
      if (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > 60_000) throw new Error('Invalid automation timeout');
      if (!idempotencies.includes(entry.idempotency) || !entry.capability || entry.capability.configurePermission !== AUTOMATION_CONFIGURE_PERMISSION ||
          !effects.includes(entry.capability.discordSideEffect) || !Array.isArray(entry.capability.runtimePrerequisites) ||
          entry.capability.runtimePrerequisites.some(value => !prerequisites.includes(value)) ||
          new Set(entry.capability.runtimePrerequisites).size !== entry.capability.runtimePrerequisites.length)
        throw new Error('Invalid automation capability');
      if (entry.capability.discordSideEffect !== 'NONE' && !entry.capability.runtimePrerequisites.includes('GUILD_AVAILABLE'))
        throw new Error('Discord side effects require a guild runtime prerequisite');
    }
  }
  for (const action of actions) if (!Number.isSafeInteger(action.maxStaticMessageLength) || action.maxStaticMessageLength < 0 ||
    action.maxStaticMessageLength > AUTOMATION_LIMITS.maxStaticMessageLength) throw new Error('Invalid static message limit');
}
