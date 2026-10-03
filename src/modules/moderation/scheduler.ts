import type { Logger } from '../../core/logger/logger.js';
import type { ModerationGateway, ModerationService } from './service.js';
import { safeFailureCategory } from '../../core/operations/failures.js';
import { SchedulerTelemetry } from '../../core/operations/scheduler-telemetry.js';

/** PostgreSQL-backed claims make expiration restart-safe; timers only trigger scans. */
export class ModerationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  readonly telemetry: SchedulerTelemetry;
  constructor(private readonly moderation: ModerationService,
    private readonly gatewayForGuild: (guildId: string) => Promise<ModerationGateway>,
    private readonly logger: Logger, private readonly intervalMs = 30_000, now: () => number = Date.now) {
    this.telemetry = new SchedulerTelemetry(['moderation-expiry'], intervalMs, now);
  }
  start() {
    if (this.timer) return;
    this.telemetry.start();
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.telemetry.tickStarted();
    this.telemetry.jobStarted(0);
    this.active = (async () => {
      try { await this.moderation.expireDue(this.gatewayForGuild); this.telemetry.jobCompleted(0); }
      catch (error) {
        this.telemetry.jobCompleted(0, { error });
        this.logger.error({ job: 'moderation-expiry', failureCategory: safeFailureCategory(error) }, 'Moderation expiration scan failed');
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
