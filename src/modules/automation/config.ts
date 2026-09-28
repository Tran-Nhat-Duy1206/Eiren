import { AUTOMATION_LIMITS, AUTOMATION_SCHEMA_VERSION, validateAutomationRegistry } from './contracts.js';
import type { AutomationActionDefinition, AutomationTriggerDefinition } from './contracts.js';

export type AutomationConfig = Readonly<{ schemaVersion: number; enabled: boolean; trigger: Readonly<{ id: string; version: number; config: Readonly<Record<string, unknown>> }>;
  actions: readonly Readonly<{ id: string; version: number; config: Readonly<Record<string, unknown>> }>[] }>;
const fail = (): never => { throw new Error('Invalid automation configuration'); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
/** Reject exotic objects, URLs, executable strings, prototype keys, and unbounded JSON before persistence. */
function safeJson(value: unknown, depth = 0): void {
  if (depth > 8) fail();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') {
    if (value.length > AUTOMATION_LIMITS.maxStaticMessageLength || /(?:https?:\/\/|www\.|javascript:|data:|<script\b|\$\{|\{\{|```)/i.test(value)) fail();
    return;
  }
  if (Array.isArray(value)) { if (value.length > 20) fail(); for (const item of value) safeJson(item, depth + 1); return; }
  if (!object(value)) return fail();
  if (Object.keys(value).length > 20) fail();
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) fail();
    safeJson(item, depth + 1);
  }
}
export function validateAutomationConfig(input: unknown, triggers: readonly AutomationTriggerDefinition[], actions: readonly AutomationActionDefinition[], enabledCount = 0): AutomationConfig {
  validateAutomationRegistry(triggers, actions);
  if (!object(input)) return fail();
  if (!keys(input, ['schemaVersion', 'enabled', 'trigger', 'actions']) || input.schemaVersion !== AUTOMATION_SCHEMA_VERSION || typeof input.enabled !== 'boolean' ||
      !Number.isSafeInteger(enabledCount) || enabledCount < 0 || (input.enabled && enabledCount >= AUTOMATION_LIMITS.maxEnabled) ||
      !object(input.trigger) || !Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > AUTOMATION_LIMITS.maxActions) return fail();
  const validateRef = (value: unknown, definitions: readonly (AutomationTriggerDefinition | AutomationActionDefinition)[]) => {
    if (!object(value)) return fail();
    if (!keys(value, ['id', 'version', 'config']) || typeof value.id !== 'string' || !integer(value.version) || !object(value.config)) return fail();
    const definition = definitions.find(item => item.id === value.id && item.version === value.version);
    if (!definition) return fail();
    safeJson(value.config);
    if (!definition.configSchema.safeParse(value.config).success) fail();
    return value;
  };
  validateRef(input.trigger, triggers);
  for (const action of input.actions) {
    const ref = validateRef(action, actions);
    const definition = actions.find(item => item.id === ref.id)!;
    const actionConfig = ref.config as Record<string, unknown>;
    if (typeof actionConfig.message === 'string' && actionConfig.message.length > definition.maxStaticMessageLength) fail();
  }
  if (JSON.stringify(input).length > 8192) fail();
  return input as AutomationConfig;
}
