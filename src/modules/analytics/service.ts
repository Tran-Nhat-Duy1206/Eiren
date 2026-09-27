import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import type { ModuleService } from '../../services/module-service.js';
import { AnalyticsRepository, rangeHours, type AnalyticsRange, type VoiceReservation } from './repository.js';

export class AnalyticsService {
  private readonly voiceReady = new Map<string, { at: Date; epoch: number }>();
  private readonly voiceGeneration = new Map<string, number>();
  private readonly ingressTails = new Map<string, Promise<void>>();
  /** Preserve this gateway process's observation order while PostgreSQL remains authoritative. */
  reserveVoiceObservation(guildId: string, userId: string, observedAt: Date): Promise<VoiceReservation | null> {
    this.validate(observedAt);
    const previous = this.ingressTails.get(guildId) ?? Promise.resolve();
    const reservation = previous.then(() => this.repository.reserveVoice(guildId, userId, observedAt));
    const settled = reservation.then(() => {}, () => {});
    this.ingressTails.set(guildId, settled);
    void settled.then(() => { if (this.ingressTails.get(guildId) === settled) this.ingressTails.delete(guildId); });
    return reservation;
  }
  async voiceBoundary(guildId: string) {
    await this.ingressTails.get(guildId);
    return this.repository.voiceBoundary(guildId);
  }
  async finalizeVoiceObservation(reservation: VoiceReservation, channelId: string | null) {
    return this.repository.finalizeVoice(reservation, channelId);
  }
  /** Invalidated after every analytics module write, including an idempotent toggle. */
  invalidateVoice(guildId: string) {
    this.voiceReady.delete(guildId);
    this.voiceGeneration.set(guildId, (this.voiceGeneration.get(guildId) ?? 0) + 1);
  }
  isVoiceReady(guildId: string) { return this.voiceReady.has(guildId); }
  constructor(readonly repository: AnalyticsRepository, private readonly permissions: PermissionService,
    private readonly modules: ModuleService) {
    modules.onChange?.((guildId, key) => { if (key === 'analytics') this.invalidateVoice(guildId); });
  }
  private validate(at: Date) {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || at.getTime() > Date.now() + 300000)
      throw new AppError('VALIDATION', 'Invalid analytics timestamp.');
  }
  async recordMessage(guildId: string, messageId: string, channelId: string, at: Date, botFlag = false, systemFlag = false, webhookFlag = false) {
    if (botFlag || systemFlag || webhookFlag) return false;
    this.validate(at);
    // Capture the pre-check epoch: a disable/re-enable cannot relabel delayed old work as new.
    const epoch = await this.modules.voiceEpoch?.(guildId);
    if (!await this.modules.isEnabled(guildId, 'analytics')) return false;
    return this.repository.message(guildId, messageId, channelId, at, epoch);
  }
  async recordMember(guildId: string, userId: string, present: boolean, at: Date) {
    this.validate(at);
    const epoch = await this.modules.voiceEpoch?.(guildId);
    if (!await this.modules.isEnabled(guildId, 'analytics')) return false;
    return this.repository.member(guildId, userId, present, at, epoch);
  }
  async recordVoice(guildId: string, userId: string, channelId: string | null, at: Date) {
    this.validate(at);
    if (!await this.modules.isEnabled(guildId, 'analytics')) { this.invalidateVoice(guildId); return false; }
    // During startup, preserve the event as a no-credit fence so a slow snapshot cannot revive old state.
    if (!this.isVoiceReady(guildId)) return this.repository.baselineVoice(guildId, userId, channelId, at);
    return this.repository.voice(guildId, userId, channelId, at, this.voiceReady.get(guildId)?.at,
      this.voiceReady.get(guildId)?.epoch);
  }
  /** Unknown member identity cannot contribute voice time, but fences a concurrent stale snapshot. */
  async fenceUnknownVoice(guildId: string, userId: string, at: Date) {
    this.validate(at);
    if (!await this.modules.isEnabled(guildId, 'analytics')) return false;
    return this.repository.baselineVoice(guildId, userId, null, at);
  }
  async recordCommand(guildId: string, interactionId: string, commandName: string, failed: boolean, durationMs: number, at: Date) {
    this.validate(at);
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 86400000 || !/^[a-z0-9_-]{1,32}$/.test(commandName))
      throw new AppError('VALIDATION', 'Invalid command telemetry.');
    const epoch = await this.modules.voiceEpoch?.(guildId);
    if (!await this.modules.isEnabled(guildId, 'analytics')) return false;
    return this.repository.command(guildId, interactionId, commandName, failed, durationMs, at, epoch);
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
  async reconcileVoice(guildId: string, live: readonly { userId: string; channelId: string }[], cutoff = new Date(),
    baselineAt = cutoff, observedEpoch?: number, observationBoundary = 0) {
    const generation = this.voiceGeneration.get(guildId) ?? 0;
    const epoch = observedEpoch ?? await this.modules.voiceEpoch?.(guildId) ?? 0;
    if (!await this.modules.isEnabled(guildId, 'analytics')) { this.invalidateVoice(guildId); return 0; }
    const count = await this.repository.reconcileVoice(guildId, live, cutoff, baselineAt, epoch, observationBoundary);
    if (count >= 0 && generation === (this.voiceGeneration.get(guildId) ?? 0) &&
      await this.modules.isEnabled(guildId, 'analytics')) this.voiceReady.set(guildId, { at: baselineAt, epoch });
    return Math.max(0, count);
  }
  async heartbeat(guildId: string, live: readonly { userId: string; channelId: string }[], now = new Date(), limit = 1000,
    baselineAt = now, observationBoundary = 0) {
    if (!this.isVoiceReady(guildId)) return 0;
    if (!await this.modules.isEnabled(guildId, 'analytics')) { this.invalidateVoice(guildId); return 0; }
    if (!this.isVoiceReady(guildId)) return 0;
    const count = await this.repository.heartbeat(guildId, live, now, limit, baselineAt,
      this.voiceReady.get(guildId)?.at, this.voiceReady.get(guildId)?.epoch, observationBoundary);
    if (count < 0) { this.invalidateVoice(guildId); return 0; }
    return count;
  }
}
