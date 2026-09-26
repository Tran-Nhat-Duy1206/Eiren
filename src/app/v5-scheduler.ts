import type { Logger } from '../core/logger/logger.js';

/** Timers are only wakeups: PostgreSQL rows and transaction locks own all V5 due work. */
export class V5Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  constructor(private readonly jobs: readonly { name: string; runDue(): Promise<void> }[],
    private readonly logger: Logger, private readonly intervalMs = 30_000) {}
  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = (async () => {
      for (const job of this.jobs) {
        try { await job.runDue(); }
        catch (error) { this.logger.error({ job: job.name, errorType: error instanceof Error ? error.name : 'unknown' },
          'V5 scheduled reconciliation failed'); }
      }
    })().finally(() => { this.active = undefined; });
    return this.active;
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
