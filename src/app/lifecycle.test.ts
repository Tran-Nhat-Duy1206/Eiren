import { describe, expect, it, vi } from 'vitest';
import { createBotLifecycle } from './lifecycle.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('bot lifecycle', () => {
  it('never logs in after shutdown during a pending database probe', async () => {
    const probe = deferred();
    const login = vi.fn(async () => {});
    const closeDatabase = vi.fn(async () => {});
    const destroy = vi.fn();
    const lifecycle = createBotLifecycle({ probe: () => probe.promise, register: vi.fn(), login, closeDatabase, destroy });
    const started = lifecycle.start();
    const stopped = lifecycle.shutdown();
    probe.resolve();
    await Promise.all([started, stopped]);
    expect(login).not.toHaveBeenCalled();
    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalled();
  });
  it('closes the database without waiting for login, and destroys any late connection', async () => {
    const login = deferred();
    const destroy = vi.fn();
    const closeDatabase = vi.fn(async () => {});
    const lifecycle = createBotLifecycle({ probe: async () => {}, register: vi.fn(), login: () => login.promise, destroy, closeDatabase });
    const started = lifecycle.start();
    await Promise.resolve(); // allow probe to complete and login to begin
    await lifecycle.shutdown();
    await started;
    expect(closeDatabase).toHaveBeenCalledOnce();
    login.resolve();
    await login.promise;
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(3); // shutdown, abort cleanup, late login
    await lifecycle.shutdown();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
