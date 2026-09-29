import { describe, expect, it } from 'vitest';
import { AUTOMATION_EXECUTION_TTL_MS, AUTOMATION_LEASE_MS,
  automationExecutionExpired, automationRetryDelayMs } from './retry.js';

describe('bounded Automation claim retry helpers', () => {
  it('uses exponential 30-second backoff under the 10-minute ceiling', () => {
    expect([1, 2, 3, 4, 5].map(automationRetryDelayMs))
      .toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(AUTOMATION_LEASE_MS).toBe(60_000);
    for (const attempt of [0, -1, 6, Number.NaN, Number.MAX_SAFE_INTEGER])
      expect(() => automationRetryDelayMs(attempt)).toThrow();
  });
  it('expires at exactly 24 hours, never permitting an unbounded retry', () => {
    const created = new Date('2026-01-01T00:00:00.000Z');
    expect(automationExecutionExpired(created, new Date(created.getTime() + AUTOMATION_EXECUTION_TTL_MS - 1))).toBe(false);
    expect(automationExecutionExpired(created, new Date(created.getTime() + AUTOMATION_EXECUTION_TTL_MS))).toBe(true);
    expect(() => automationExecutionExpired(new Date(NaN), created)).toThrow();
  });
});
