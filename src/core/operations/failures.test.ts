import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors/errors.js';
import { safeFailureCategory, safeErrorStage, ScheduledStageError } from './failures.js';
import { V5Scheduler } from '../../app/v5-scheduler.js';

describe('failure metadata is bounded and cannot interrupt later jobs', () => {
  it.each(['DATABASE', 'CONFLICT', 'VALIDATION', 'PERMISSION'] as const)('maps trusted AppError %s without messages', code => {
    expect(safeFailureCategory(new AppError(code, 'SYNTHETIC_PRIVATE'))).toBe(code);
  });
  it('accepts only static stages and never returns arbitrary exception names', () => {
    expect(safeErrorStage(new ScheduledStageError('analytics.runDue', new Error('SYNTHETIC_PRIVATE')))).toBe('analytics.runDue');
    expect(safeErrorStage(new ScheduledStageError('SYNTHETIC_PRIVATE_URL', {}))).toBeUndefined();
    expect(safeFailureCategory({ name: 'SYNTHETIC_PRIVATE_CLASS', message: 'SYNTHETIC_PRIVATE' })).toBe('UNKNOWN');
  });
  it('contains hostile getter/proxy failures without changing scheduler isolation', async () => {
    const error = new Proxy({}, { get() { throw new Error('SYNTHETIC_PRIVATE'); }, getPrototypeOf() { throw new Error('SYNTHETIC_PRIVATE'); } });
    expect(safeFailureCategory(error)).toBe('UNKNOWN'); expect(safeErrorStage(error)).toBeUndefined();
    const later = vi.fn(async () => undefined), log = vi.fn();
    const scheduler = new V5Scheduler([{ name: 'events', runDue: async () => { throw error; } }, { name: 'giveaways', runDue: later }], { error: log, debug: vi.fn() } as never);
    await scheduler.tick(); expect(later).toHaveBeenCalledOnce(); expect(scheduler.telemetry.snapshot().state).toBe('HEALTHY');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SYNTHETIC_PRIVATE'); await scheduler.stop();
  });
});
