import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeDatabase, ReadinessService, toPublicReadiness, type DatabaseProbeResult } from './readiness.js';
import { MIGRATION_DESCRIPTOR as expected } from './migration-descriptor.js';
import type { OperationalDatabase } from './operational-database.js';

const good: DatabaseProbeResult = { database: 'ready', migrations: 'ready', observedCount: 21, observedTag: expected.tag };
afterEach(() => vi.useRealTimers());

describe('readiness', () => {
  it('returns ready/200 semantics and strips all private details', async () => {
    const service = new ReadinessService(async () => ({ ...good, hash: 'SECRET' } as DatabaseProbeResult), () => true, () => 'RUNNING', () => ({ v5: 'HEALTHY', moderation: 'HEALTHY' }));
    const result = await service.check();
    expect(result.ready ? 200 : 503).toBe(200);
    expect(toPublicReadiness(result)).toEqual({ status: 'ready', checks: { database: 'ready', migrations: 'ready', gateway: 'ready', scheduler: 'ready' } });
    expect(JSON.stringify(toPublicReadiness(result))).not.toMatch(/SECRET|observed|expected|checkedAt|0020/);
  });
  it('caches only database for two seconds after completion; collapses concurrent probes', async () => {
    vi.useFakeTimers();
    let phase = 'RUNNING'; let gateway = true; let v5 = 'HEALTHY'; let moderation = 'HEALTHY';
    const probe = vi.fn(() => new Promise<DatabaseProbeResult>((resolve) => setTimeout(() => resolve(good), 1000)));
    const service = new ReadinessService(probe, () => gateway, () => phase, () => ({ v5, moderation }));
    const first = service.check(); const second = service.check();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).ready).toBe(true); await second;
    expect(probe).toHaveBeenCalledTimes(1);
    for (const next of ['STARTING', 'STOPPING']) { phase = next; expect((await service.check()).ready).toBe(false); }
    phase = 'RUNNING'; gateway = false; expect((await service.check()).ready).toBe(false); gateway = true;
    for (const state of ['STARTING', 'STALE', 'STOPPED']) {
      v5 = state; expect((await service.check()).ready).toBe(false); v5 = 'HEALTHY';
      moderation = state; expect((await service.check()).ready).toBe(false); moderation = 'HEALTHY';
    }
    await vi.advanceTimersByTimeAsync(1999); await service.check(); expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); const expired = service.check();
    await vi.advanceTimersByTimeAsync(1000); await expired; expect(probe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds fake hung dependencies and caches timeout without timers left behind', async () => {
    vi.useFakeTimers();
    const service = new ReadinessService(() => new Promise(() => {}), () => true, () => 'RUNNING', () => ({ v5: 'HEALTHY', moderation: 'HEALTHY' }));
    const pending = service.check(); await vi.advanceTimersByTimeAsync(2200);
    const result = await pending;
    expect(result.ready ? 200 : 503).toBe(503);
    expect(result.database).toBe('unavailable'); expect(result.migrations).toBe('unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds the combined connectivity and journal probe, not each call separately', async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ rows: [{ count: '21', hash: expected.hash, created_at: expected.timestamp }] }), 1500)));
    const service = new ReadinessService(() => probeDatabase({ query } as Pick<OperationalDatabase, 'query'>), () => true, () => 'RUNNING', () => ({ v5: 'HEALTHY', moderation: 'HEALTHY' }));
    const pending = service.check(); await vi.advanceTimersByTimeAsync(2200);
    expect((await pending).ready).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    expect((await service.check()).database).toBe('unavailable');
    expect(query).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not expose arbitrary exception names or messages', async () => {
    const fail = () => { throw Object.assign(new Error('PASSWORD SECRET'), { name: 'PrivateHost' }); };
    const service = new ReadinessService(fail, fail, fail, fail);
    const result = await service.check(); expect(result.ready).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/PASSWORD|SECRET|PrivateHost/);
  });
});

describe('database probe', () => {
  const reader = (fn: ReturnType<typeof vi.fn>) => ({ query: fn }) as Pick<OperationalDatabase, 'query'>;
  it.each([expected.hash, expected.approvedCrlfHash])('accepts only approved latest hash %s', async (hash) => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({ rows: [{ count: '21', hash, created_at: String(expected.timestamp) }] });
    expect(await probeDatabase(reader(query))).toEqual(good);
    expect(query.mock.calls[0]?.[0]).toBe('SELECT 1');
  });
  it.each([{ count: '20', hash: expected.hash, created_at: expected.timestamp }, { count: '22', hash: expected.hash, created_at: expected.timestamp }, { count: '21', hash: 'unknown', created_at: expected.timestamp }, { count: '21', hash: expected.hash, created_at: expected.timestamp + 1 }])('rejects a differing migration', async (row) => {
    const result = await probeDatabase(reader(vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] })));
    expect(result.migrations).toBe('mismatch'); expect(result.observedTag).toBeUndefined();
  });
  it('distinguishes database down from missing migration journal', async () => {
    expect(await probeDatabase(reader(vi.fn().mockRejectedValue(new Error('host secret'))))).toEqual({ database: 'unavailable', migrations: 'unavailable' });
    expect(await probeDatabase(reader(vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce({ code: '42P01', message: 'private' })))).toEqual({ database: 'ready', migrations: 'unavailable' });
  });
});
