import { describe, expect, it, vi } from 'vitest';
import { V5Scheduler } from './v5-scheduler.js';

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
});
