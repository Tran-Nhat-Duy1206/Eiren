import { describe, it, expect, vi } from 'vitest';
import { ModerationScheduler } from './scheduler.js';
import { V5Scheduler } from '../../app/v5-scheduler.js';

describe.each(['moderation', 'v5'] as const)('%s scheduler telemetry', kind => {
  const make = (run: () => Promise<void>, now: () => number, later = vi.fn(async () => {})) => {
    const logger = { error: vi.fn(), debug: vi.fn() };
    const scheduler = kind === 'moderation'
      ? new ModerationScheduler({ expireDue: run } as never, vi.fn() as never, logger as never, 30_000, now)
      : new V5Scheduler([{ name: 'events', runDue: run }, { name: 'giveaways', runDue: later }], logger as never, 30_000, now);
    return { scheduler, logger, later };
  };
  it('tracks long active ticks, no overlap, recovery, and immediate stopped state while draining', async () => {
    let clock = 0; let release!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const { scheduler } = make(run, () => clock);
    const active = scheduler.tick();
    expect(scheduler.tick()).toBe(active);
    expect(scheduler.telemetry.snapshot()).toMatchObject({ state: 'STARTING', tickCount: 1, running: true, startedAt: new Date(0) });
    clock = 90_000; expect(scheduler.telemetry.snapshot().state).toBe('STARTING');
    clock++; expect(scheduler.telemetry.snapshot().state).toBe('STALE');
    release(); await active;
    expect(scheduler.telemetry.snapshot().state).toBe('HEALTHY');
    const next = scheduler.tick(); let stopped = false;
    const stop = scheduler.stop().then(() => { stopped = true; });
    expect(scheduler.telemetry.snapshot()).toMatchObject({ state: 'STOPPED', running: true });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await next; await stop;
    expect(scheduler.telemetry.snapshot()).toMatchObject({ state: 'STOPPED', running: false, tickCount: 2 });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('preserves prior success on failure, uses safe categories and keeps later work running', async () => {
    let clock = 10; let fail = false;
    const { scheduler, logger, later } = make(async () => { if (fail) throw Object.assign(new Error('PRIVATE_SENTINEL'), { name: 'SECRET_NAME', code: '23505' }); }, () => clock);
    await scheduler.tick(); fail = true; clock = 20; await scheduler.tick();
    expect(scheduler.telemetry.snapshot().jobs[0]).toMatchObject({ lastSuccessAt: new Date(10), lastFailureAt: new Date(20), lastAttemptAt: new Date(20), lastFailureCategory: 'CONFLICT', currentRunningSince: null });
    if (kind === 'v5') expect(later).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/PRIVATE_SENTINEL|SECRET_NAME/);
    clock = 90_021; expect(scheduler.telemetry.snapshot().state).toBe('STALE');
    fail = false; await scheduler.tick(); expect(scheduler.telemetry.snapshot().state).toBe('HEALTHY');
  });
  it('preserves the existing native timer ref semantics', async () => {
    const timer = { unref: vi.fn() };
    const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer as never);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    try {
      const { scheduler } = make(async () => {}, () => 0);
      scheduler.start();
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(timer.unref).toHaveBeenCalledTimes(kind === 'v5' ? 1 : 0);
      await scheduler.stop(); expect(clear).toHaveBeenCalledWith(timer);
    } finally { interval.mockRestore(); clear.mockRestore(); }
  });
  it('starts immediately with a 30 second interval', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => {}); const { scheduler } = make(run, () => Date.now());
      scheduler.start(); scheduler.start(); expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000); expect(run).toHaveBeenCalledTimes(2);
      await scheduler.stop();
    } finally { vi.useRealTimers(); }
  });
});
