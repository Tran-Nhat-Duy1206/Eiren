import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AUTOMATION_ACTIONS, AUTOMATION_CONFIGURE_PERMISSION, AUTOMATION_LIMITS, AUTOMATION_TRIGGERS, validateAutomationRegistry } from './contracts.js';
import type { AutomationActionDefinition, AutomationTriggerDefinition } from './contracts.js';
import { validateAutomationConfig } from './config.js';
import { AUTOMATION_STATUSES, assertAutomationStatusTransition, canTransitionAutomationStatus } from './status.js';

const trigger: AutomationTriggerDefinition = { id: 'SCHEDULED', version: 1, schemaVersion: 1, runnable: false, timeoutMs: 1000,
  configSchema: z.object({}).strict(), idempotency: 'IDEMPOTENT',
  capability: { configurePermission: 'ADMIN', runtimePrerequisites: [], discordSideEffect: 'NONE' } };
const action: AutomationActionDefinition = { ...trigger, id: 'STATIC_MESSAGE', runnable: true,
  configSchema: z.object({ message: z.string().max(1000) }).strict(), maxStaticMessageLength: 1000 };
const config = () => ({ schemaVersion: 1, enabled: true, trigger: { id: trigger.id, version: 1, config: {} },
  actions: [{ id: action.id, version: 1, config: { message: 'hello' } }] });
const validate = (input: unknown, count = 0) => validateAutomationConfig(input, [trigger], [action], count);
describe('versioned automation contracts', () => {
  it('registers only inert scheduled triggers and two safe executable actions', () => {
    expect(AUTOMATION_TRIGGERS.map(item => item.id)).toEqual(['SCHEDULED']);
    expect(AUTOMATION_ACTIONS.map(item => item.id)).toEqual(['STATIC_MESSAGE', 'STAFF_LOG']);
    expect(AUTOMATION_TRIGGERS.every(item => item.runnable === false)).toBe(true);
    expect(AUTOMATION_ACTIONS.every(item => item.runnable === true)).toBe(true);
    expect(() => validateAutomationRegistry(AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS)).not.toThrow();
    expect(AUTOMATION_CONFIGURE_PERMISSION).toBe('ADMIN');
    expect(AUTOMATION_LIMITS).toMatchObject({ maxEnabled: 20, maxActions: 2, maxDepth: 2, maxStaticMessageLength: 1000,
      futureClaimsPerTick: 20, futureClaimsPerGuild: 2, executionsPerMinute: 10, executionsPerHour: 60, retryAttempts: 5 });
    expect(() => validateAutomationRegistry([trigger], [action])).not.toThrow();
  });
  it('rejects duplicate, executable, stale-version and unsafe capability definitions', () => {
    expect(() => validateAutomationRegistry([trigger, trigger], [])).toThrow();
    expect(() => validateAutomationRegistry([{ ...trigger, runnable: true as false }], [])).toThrow();
    expect(() => validateAutomationRegistry([], [{ ...action, runnable: false as true }])).toThrow();
    expect(() => validateAutomationRegistry([{ ...trigger, schemaVersion: 2 }], [])).toThrow();
    expect(() => validateAutomationRegistry([], [{ ...action, capability: { ...action.capability, discordSideEffect: 'SEND_MESSAGE' } }])).toThrow();
  });
  it('validates bounded inert configuration and versioned references', () => {
    expect(validate(config())).toEqual(config());
    expect(() => validate(config(), 20)).toThrow();
    expect(() => validate({ ...config(), schemaVersion: 2 })).toThrow();
    expect(() => validate({ ...config(), trigger: { ...config().trigger, config: { unexpected: true } } })).toThrow();
    expect(() => validate({ ...config(), actions: [{ ...config().actions[0], config: {} }] })).toThrow();
    expect(() => validate({ ...config(), trigger: { ...config().trigger, version: 2 } })).toThrow();
    expect(() => validate({ ...config(), actions: [config().actions[0], config().actions[0], config().actions[0]] })).toThrow();
    expect(() => validate({ ...config(), actions: [{ ...config().actions[0], config: { message: 'x'.repeat(1001) } }] })).toThrow();
  });
  it('rejects executable payloads, URLs, oversized JSON and unknown keys', () => {
    for (const message of ['https://example.com', 'javascript:alert(1)', '{{execute}}', '<script>x</script>'])
      expect(() => validate({ ...config(), actions: [{ ...config().actions[0], config: { message } }] })).toThrow();
    expect(() => validate({ ...config(), code: 'run()' })).toThrow();
    expect(() => validate({ ...config(), trigger: { ...config().trigger, config: { nested: { deep: 'x'.repeat(900) }, many: Array(21).fill(0) } } })).toThrow();
  });
  it('permits only explicit forward status transitions; uncertainty is terminal', () => {
    expect(AUTOMATION_STATUSES).toHaveLength(6);
    expect(canTransitionAutomationStatus('PENDING', 'RUNNING')).toBe(true);
    expect(canTransitionAutomationStatus('RUNNING', 'UNCERTAIN')).toBe(true);
    expect(canTransitionAutomationStatus('RUNNING', 'PENDING')).toBe(true); // only safe no-effect recovery/defer
    for (const terminal of ['SUCCEEDED', 'SKIPPED', 'FAILED', 'UNCERTAIN'] as const)
      expect(() => assertAutomationStatusTransition(terminal, 'RUNNING')).toThrow();
    expect(canTransitionAutomationStatus('FAILED', 'PENDING')).toBe(true);
    expect(canTransitionAutomationStatus('UNCERTAIN', 'PENDING')).toBe(false);
    expect(canTransitionAutomationStatus('PENDING', 'SUCCEEDED')).toBe(false);
  });
});
