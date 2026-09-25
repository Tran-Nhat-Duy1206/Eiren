import type { Logger } from '../../core/logger/logger.js';
import type { ModerationGateway, ModerationService } from './service.js';

/** PostgreSQL-backed claims make expiration restart-safe; timers only trigger scans. */
export class ModerationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  constructor(private readonly moderation: ModerationService,
    private readonly gatewayForGuild: (guildId: string) => Promise<ModerationGateway>,
    private readonly logger: Logger, private readonly intervalMs = 30_000) {}
  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = (async () => {
      try { await this.moderation.expireDue(this.gatewayForGuild); }
      catch (error) { this.logger.error({ err: error }, 'Moderation expiration scan failed'); }
    })().finally(() => { this.active = undefined; });
    return this.active;
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
