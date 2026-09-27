import type { Logger } from '../core/logger/logger.js';

/** Trusted, static stage label; raw errors and SQL must never enter scheduled job logs. */
export class ScheduledStageError extends Error {
  constructor(readonly stage: string, cause: unknown) { super('Scheduled stage failed', { cause }); }
}

/** Timers are only wakeups: PostgreSQL rows and transaction locks own due work. */
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
        try {
          await job.runDue();
          if (job.name === 'analytics') this.logger.debug({ job: job.name }, 'Scheduled reconciliation complete');
        }
        catch (error) { this.logger.error({ job: job.name,
          ...(error instanceof ScheduledStageError ? { stage: error.stage } : {}),
          errorType: error instanceof ScheduledStageError && error.cause instanceof Error ? error.cause.name
            : error instanceof Error ? error.name : 'unknown' }, 'Scheduled reconciliation failed'); }
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
