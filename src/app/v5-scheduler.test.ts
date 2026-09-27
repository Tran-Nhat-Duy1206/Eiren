import { describe, expect, it, vi } from 'vitest';
import { ScheduledStageError, V5Scheduler } from './v5-scheduler.js';

describe('shared V5 wakeup scheduler', () => {
  it('does not overlap a pending scan and isolates one failing module', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const first = vi.fn(async () => waiting);
    const second = vi.fn(async () => { throw new Error('transient'); });
    const third = vi.fn(async () => {});
    const logger = { error: vi.fn() };
    const scheduler = new V5Scheduler([
      { name: 'events', runDue: first }, { name: 'giveaways', runDue: second },
      { name: 'tempvoice', runDue: third },
    ], logger as never);
    const pending = scheduler.tick();
    expect(scheduler.tick()).toBe(pending);
    expect(first).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
  it('reports a trusted maintenance stage without leaking the underlying error', async () => {
    const logger = { error: vi.fn() };
    const scheduler = new V5Scheduler([{ name: 'analytics', runDue: async () => {
      throw new ScheduledStageError('analytics.runDue.analytics_guild_hourly', new Error('postgresql://private:credential@localhost'));
    } }], logger as never);
    await scheduler.tick();
    expect(logger.error).toHaveBeenCalledWith({ job: 'analytics', stage: 'analytics.runDue.analytics_guild_hourly',
      errorType: 'Error' }, 'Scheduled reconciliation failed');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('credential');
  });
  it('reports completed analytics ticks without user or credential data', async () => {
    const logger = { error: vi.fn(), debug: vi.fn() };
    const scheduler = new V5Scheduler([{ name: 'analytics', runDue: async () => {} }], logger as never);
    await scheduler.tick();
    await scheduler.tick();
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith({ job: 'analytics' }, 'Scheduled reconciliation complete');
    expect(logger.error).not.toHaveBeenCalled();
  });
});
