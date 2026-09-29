import { describe, expect, it } from 'vitest';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS } from './contracts.js';
import { validateAutomationConfig } from './config.js';
import { nextScheduledOccurrence } from './schedule.js';

const daily = (time: string, timezone = 'America/New_York') => ({ kind: 'daily' as const, time, timezone });
const next = (time: string, after: string) => nextScheduledOccurrence(daily(time), new Date(after))?.toISOString();
const configured = (trigger: unknown, action: unknown) => validateAutomationConfig({ schemaVersion: 1, enabled: true,
  trigger: { id: 'SCHEDULED', version: 1, config: trigger }, actions: [{ id: 'STATIC_MESSAGE', version: 1, config: action }] },
AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS);
const action = { channelId: '123456789012345678', message: 'hello' };

describe('inert scheduled automation', () => {
  it('skips nonexistent spring wall time', () => {
    expect(next('02:30', '2025-03-09T06:00:00.000Z')).toBe('2025-03-10T06:30:00.000Z');
    expect(next('03:30', '2025-03-09T06:00:00.000Z')).toBe('2025-03-09T07:30:00.000Z');
  });
  it('chooses earlier fall occurrence exactly once', () => {
    expect(next('01:30', '2025-11-02T04:00:00.000Z')).toBe('2025-11-02T05:30:00.000Z');
    expect(next('01:30', '2025-11-02T05:30:00.000Z')).toBe('2025-11-03T06:30:00.000Z');
    expect(next('01:30', '2025-11-02T05:45:00.000Z')).toBe('2025-11-03T06:30:00.000Z');
  });
  it('returns only future occurrences, including after re-enable', () => {
    expect(next('09:00', '2025-05-01T13:00:00.000Z')).toBe('2025-05-02T13:00:00.000Z');
    expect(nextScheduledOccurrence({ kind: 'once', at: '2025-05-01T00:00:00.000Z' }, new Date('2025-05-01T00:00:00.000Z'))).toBeNull();
    expect(nextScheduledOccurrence({ kind: 'once', at: '2025-05-02T00:00:00.000Z' }, new Date('2025-05-01T00:00:00.000Z'))?.toISOString()).toBe('2025-05-02T00:00:00.000Z');
  });
  it('rejects invalid timezone, time, timestamp and unknown schedule fields', () => {
    for (const config of [daily('24:00'), daily('9:00'), daily('10:00', 'Not/A_Zone'),
      { kind: 'once', at: '2025-05-01T00:00:00+01:00' }, { kind: 'once', at: '2025-02-30T00:00:00Z' },
      { ...daily('09:00'), cron: '* * * * *' }])
      expect(() => nextScheduledOccurrence(config as Parameters<typeof nextScheduledOccurrence>[0], new Date())).toThrow();
  });
  it('validates registered strict action schemas and capability', () => {
    expect(configured(daily('09:00'), action).enabled).toBe(true);
    for (const definition of AUTOMATION_ACTIONS) {
      expect(definition.capability.configurePermission).toBe('ADMIN');
      expect(definition.capability.discordSideEffect).toBe('SEND_MESSAGE');
      expect(definition.runnable).toBe(true);
    }
    for (const bad of [{ ...action, channelId: 'abc' }, { ...action, message: 'x'.repeat(1001) }, { ...action, extra: true }])
      expect(() => configured(daily('09:00'), bad)).toThrow();
    expect(() => configured({ ...daily('09:00'), extra: true }, action)).toThrow();
  });
});
