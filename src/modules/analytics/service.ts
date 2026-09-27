import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import type { ModuleService } from '../../services/module-service.js';
import { AnalyticsRepository, rangeHours, type AnalyticsRange } from './repository.js';

export class AnalyticsService {
  constructor(readonly repository: AnalyticsRepository, private readonly permissions: PermissionService,
    private readonly modules: ModuleService) {}
  private validate(at: Date) {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || at.getTime() > Date.now() + 300000)
      throw new AppError('VALIDATION', 'Invalid analytics timestamp.');
  }
  async recordMessage(guildId: string, messageId: string, channelId: string, at: Date, botFlag = false, systemFlag = false, webhookFlag = false) {
    if (botFlag || systemFlag || webhookFlag) return false;
    this.validate(at);
    if (!await this.modules.isEnabled(guildId, 'analytics')) return false;
    return this.repository.message(guildId, messageId, channelId, at);
  }
  async recordMember(guildId: string, userId: string, present: boolean, at: Date) {
    this.validate(at);
    if (!await this.modules.isEnabled(guildId, 'analytics')) return false;
    return this.repository.member(guildId, userId, present, at);
  }
  async recordVoice(guildId: string, userId: string, channelId: string | null, at: Date) {
    this.validate(at);
    if (!await this.modules.isEnabled(guildId, 'analytics')) return false;
    return this.repository.voice(guildId, userId, channelId, at);
  }
  async recordCommand(guildId: string, interactionId: string, commandName: string, failed: boolean, durationMs: number, at: Date) {
    this.validate(at);
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 86400000 || !/^[a-z0-9_-]{1,32}$/.test(commandName))
      throw new AppError('VALIDATION', 'Invalid command telemetry.');
    if (!await this.modules.isEnabled(guildId, 'analytics')) return false;
    return this.repository.command(guildId, interactionId, commandName, failed, durationMs, at);
  }
  async summary(guildId: string, range: AnalyticsRange, timezone = 'UTC', now = new Date()) {
    if (!Object.hasOwn(rangeHours, range)) throw new AppError('VALIDATION', 'Choose 24h, 7d, 30d, or 90d.');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
    catch { throw new AppError('VALIDATION', 'Invalid IANA timezone.'); }
    // UTC absolute bounds avoid DST double-counting; SQL groups bounded buckets by validated local date.
    return { ...await this.repository.summary(guildId, range, now, timezone), timezone };
  }
  async status(actor: Actor) {
    await this.permissions.require(actor, 'HELPER');
    return { enabled: await this.modules.isEnabled(actor.guildId, 'analytics'), retentionDays: await this.repository.settings(actor.guildId) };
  }
  async setEnabled(actor: Actor, enabled: boolean) {
    await this.permissions.require(actor, 'ADMIN');
    await this.modules.setEnabled(actor.guildId, 'analytics', enabled, actor.userId);
    return this.status(actor);
  }
  async configure(actor: Actor, retentionDays: number) {
    await this.permissions.require(actor, 'ADMIN');
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 30 || retentionDays > 730)
      throw new AppError('VALIDATION', 'Retention must be 30–730 days.');
    await this.repository.configure(actor.guildId, retentionDays);
    return this.status(actor);
  }
  async summaryFor(actor: Actor, range: AnalyticsRange, timezone = 'UTC') {
    await this.permissions.require(actor, 'HELPER');
    return this.summary(actor.guildId, range, timezone);
  }
  async runDue(now = new Date(), limit = 500) { return this.repository.prune(now, limit); }
  async reconcileVoice(guildId: string, live: readonly { userId: string; channelId: string }[], now = new Date()) {
    if (!await this.modules.isEnabled(guildId, 'analytics')) return 0;
    return this.repository.reconcileVoice(guildId, live, now);
  }
  async heartbeat(guildId: string, live: readonly { userId: string; channelId: string }[], now = new Date(), limit = 1000) {
    if (!await this.modules.isEnabled(guildId, 'analytics')) return 0;
    return this.repository.heartbeat(guildId, live, now, limit);
  }
}
