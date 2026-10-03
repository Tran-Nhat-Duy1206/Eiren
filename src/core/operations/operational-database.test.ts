import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), end: vi.fn(), options: undefined as unknown, pool: undefined as import('node:events').EventEmitter | undefined }));
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: { Pool: class extends EventEmitter {
    constructor(options: unknown) { super(); mocks.options = options; mocks.pool = this; }
    connect = mocks.connect; end = mocks.end;
  } } };
});
import { OperationalDatabase } from './operational-database.js';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const client = () => ({ query: vi.fn().mockResolvedValue({ rows: [{ value: 1 }] }), release: vi.fn() });

describe('dedicated operational reader', () => {
  it('contains idle pool error events without logging private error contents', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const database = new OperationalDatabase('private-url');
      expect(mocks.pool?.listenerCount('error')).toBe(1);
      expect(() => mocks.pool?.emit('error', new Error('PASSWORD private-host'))).not.toThrow();
      expect(log).not.toHaveBeenCalled();
      mocks.connect.mockRejectedValue(new Error('offline'));
      await expect(database.query('SELECT 1')).rejects.toThrow('offline');
    } finally { log.mockRestore(); }
  });
  it('limits its pool and runs queries inside read-only, locally bounded transactions', async () => {
    const c = client(); mocks.connect.mockResolvedValue(c); mocks.end.mockResolvedValue(undefined);
    const database = new OperationalDatabase('private-url');
    expect(mocks.options).toMatchObject({ max: 2, connectionTimeoutMillis: 500, statement_timeout: 1500, allowExitOnIdle: true });
    expect(await database.query('SELECT $1', [1])).toEqual({ rows: [{ value: 1 }] });
    expect(c.query.mock.calls.map((call) => call[0])).toEqual(['BEGIN READ ONLY', "SET LOCAL statement_timeout = '1500ms'", 'SELECT $1', 'COMMIT']);
    expect(c.release).toHaveBeenCalledWith(false);
    await database.close(); expect(mocks.end).toHaveBeenCalledTimes(1);
    await expect(database.query('SELECT 1')).rejects.toThrow('Operational reader unavailable');
  });
  it('destroys late acquired clients after the 500ms acquisition deadline', async () => {
    vi.useFakeTimers(); const c = client();
    mocks.connect.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(c), 700)));
    const database = new OperationalDatabase('url');
    const rejected = expect(database.query('SELECT 1')).rejects.toThrow('Operational reader unavailable');
    await vi.advanceTimersByTimeAsync(500); await rejected;
    await vi.advanceTimersByTimeAsync(200);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(true); expect(c.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('destroys hung queries by wall deadline and never double-releases late completion', async () => {
    vi.useFakeTimers(); const c = client(); let finish: (() => void) | undefined;
    c.query.mockImplementation((sql: string) => sql === 'SELECT 1' ? new Promise((resolve) => { finish = () => resolve({ rows: [] }); }) : Promise.resolve({ rows: [] }));
    mocks.connect.mockResolvedValue(c);
    const database = new OperationalDatabase('url');
    const rejected = expect(database.query('SELECT 1')).rejects.toThrow('Operational reader unavailable');
    await vi.advanceTimersByTimeAsync(2200); await rejected;
    expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
    finish?.(); await vi.advanceTimersByTimeAsync(0);
    expect(c.release).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('destroys failed transactions rather than returning aborted clients', async () => {
    const c = client(); c.query.mockRejectedValue(new Error('query failed')); mocks.connect.mockResolvedValue(c);
    await expect(new OperationalDatabase('url').query('SELECT 1')).rejects.toThrow('query failed');
    expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
