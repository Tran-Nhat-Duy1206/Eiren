import { describe, expect, it, vi } from 'vitest';
import { OperationsRuntimeState } from './runtime-state.js';
import { trackStartupProbe, trackStartupReconciliation } from './startup-tracking.js';
import { createBotLifecycle } from '../../app/lifecycle.js';

describe('startup telemetry never weakens lifecycle', () => {
  it('records success after all existing work completes', async () => {
    const runtime = new OperationsRuntimeState(() => 123);
    const work = vi.fn(async () => undefined);
    await trackStartupProbe(runtime, work);
    expect(work).toHaveBeenCalledOnce(); expect(runtime.snapshot().startupProbe).toBe('SUCCEEDED');
    expect(runtime.snapshot().startupProbeCompletedAt).toEqual(new Date(123));
  });
  it('keeps failed schema startup fail-closed before registration and login', async () => {
    const runtime = new OperationsRuntimeState();
    const error = Object.assign(new Error('SYNTHETIC_PRIVATE_SQL_URL'), { code: '08006' });
    const register = vi.fn(), login = vi.fn(async () => undefined);
    const lifecycle = createBotLifecycle({ probe: () => trackStartupProbe(runtime, async () => { throw error; }),
      register, login, destroy: vi.fn(), closeDatabase: vi.fn(async () => undefined) });
    await expect(lifecycle.start()).rejects.toBe(error);
    expect(register).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled();
    expect(runtime.snapshot().startupProbe).toBe('FAILED'); expect(runtime.snapshot().startupProbeFailureCategory).toBe('DATABASE');
    expect(JSON.stringify(runtime.snapshot())).not.toContain('SYNTHETIC_PRIVATE');
    await lifecycle.shutdown();
  });
  it.each(['tempvoice', 'analyticsVoice'] as const)('shows %s running and preserves safe failure without swallowing it', async name => {
    const runtime = new OperationsRuntimeState(() => 456);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const error = new Error('SYNTHETIC_PRIVATE_RECONCILIATION');
    const work = trackStartupReconciliation(runtime, name, async () => { await barrier; throw error; });
    expect(runtime.snapshot().reconciliations[name].status).toBe('RUNNING');
    release(); await expect(work).rejects.toBe(error);
    expect(runtime.snapshot().reconciliations[name]).toMatchObject({ status: 'FAILED', failureCategory: 'UNKNOWN' });
    expect(JSON.stringify(runtime.snapshot())).not.toContain('SYNTHETIC_PRIVATE');
    await trackStartupReconciliation(runtime, name, async () => undefined);
    expect(runtime.snapshot().reconciliations[name].status).toBe('SUCCEEDED');
  });
});
