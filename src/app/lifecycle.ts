export interface LifecycleDependencies {
  probe(): Promise<void>;
  register(): void;
  login(): Promise<unknown>;
  destroy(): void;
  closeDatabase(): Promise<void>;
}

export function createBotLifecycle(deps: LifecycleDependencies) {
  const abortStartup = new AbortController();
  let stopping = false;
  let startup: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  return {
    start() {
      if (startup) return startup;
      startup = (async () => {
        if (stopping) return;
        await deps.probe();
        if (stopping) return;
        deps.register();
        const login = deps.login();
        // A late login completion after shutdown must never resurrect a client.
        void login.then(() => { if (stopping) deps.destroy(); }, () => {});
        await Promise.race([
          login,
          new Promise<void>(resolve => {
            if (abortStartup.signal.aborted) resolve();
            else abortStartup.signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
        if (stopping) deps.destroy();
      })();
      return startup;
    },
    shutdown() {
      if (stopPromise) return stopPromise;
      stopping = true;
      abortStartup.abort();
      stopPromise = (async () => {
        deps.destroy();
        try { await startup; } catch { /* caller reports startup failures */ }
        await deps.closeDatabase();
      })();
      return stopPromise;
    },
  };
}
