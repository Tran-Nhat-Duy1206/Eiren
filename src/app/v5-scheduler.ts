import type { Logger } from '../core/logger/logger.js';

import { safeFailureCategory, safeErrorStage } from '../core/operations/failures.js';
import { SchedulerTelemetry } from '../core/operations/scheduler-telemetry.js';
export { ScheduledStageError } from '../core/operations/failures.js';
const trustedJobs = new Set(['events', 'giveaways', 'tempvoice', 'analytics', 'automation', 'ai-maintenance', 'data-retention', 'subject-request-maintenance']);

/** Timers are only wakeups: PostgreSQL rows and transaction locks own due work. */
export class V5Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  readonly telemetry: SchedulerTelemetry;
  constructor(private readonly jobs: readonly { name: string; runDue(): Promise<void> }[],
    private readonly logger: Logger, private readonly intervalMs = 30_000, now: () => number = Date.now) {
    this.telemetry = new SchedulerTelemetry(jobs.map(job => job.name), intervalMs, now);
  }
  start() {
    if (this.timer) return;
    this.telemetry.start();
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.telemetry.tickStarted();
    this.active = (async () => {
      for (const [index, job] of this.jobs.entries()) {
        this.telemetry.jobStarted(index);
        try {
          await job.runDue();
          this.telemetry.jobCompleted(index);
          if (job.name === 'analytics') this.logger.debug({ job: 'analytics' }, 'Scheduled reconciliation complete');
        }
        catch (error) {
          this.telemetry.jobCompleted(index, { error });
          const stage = safeErrorStage(error);
          this.logger.error({ job: trustedJobs.has(job.name) ? job.name : 'scheduled-job',
            ...(stage ? { stage } : {}),
            failureCategory: safeFailureCategory(error) }, 'Scheduled reconciliation failed');
        }
      }
    })().finally(() => { this.telemetry.tickCompleted(); this.active = undefined; });
    return this.active;
  }
  async stop() {
    this.telemetry.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
