import { AppError } from '../../core/errors/errors.js';
import { parseDuration } from '../../core/time/duration.js';
import type { Actor, PermissionLevel, PermissionService } from '../../core/permissions/permission-service.js';
import type { Logger } from '../../core/logger/logger.js';
import type { GuildLogNotifier } from '../../services/log-notifier.js';
import type { LogCategory, LogField } from '../logging/guild-log-service.js';
import { MessageActivityTracker } from './tracker.js';
import type { AntiRaidRepository, AntiRaidSettings, AntiRaidSettingsPatch } from './repository.js';

const snowflake = /^\d{17,20}$/;
export const JOIN_BURST_POINTS = 60;
export const EMERGENCY_POINTS = 20;
export const MESSAGE_SPAM_POINTS = 40;
export const MASS_MENTION_POINTS = 30;

export interface RaidVerificationPort {
  quarantineForRaid(guildId: string, userId: string, reason: string, source?: 'join' | 'message'): Promise<boolean>;
  markManualReview(guildId: string, userId: string, reason: string, joinedAt?: Date): Promise<void>;
}
export interface RaidAlertSink {
  sendTo(guildId: string, channelId: string, category: LogCategory, title: string, fields?: readonly LogField[]): Promise<void>;
}
export interface JoinEvaluation {
  enabled: boolean; duplicate?: boolean; riskScore: number; signals: string[]; joinCount: number; youngAccount: boolean;
  burst: boolean; emergency: boolean; emergencyActivated: boolean; quarantined: boolean; alerted: boolean;
}
export interface MessageEvaluation {
  ignored?: boolean; duplicate?: boolean; suppressed?: boolean; spam: boolean; mentions: boolean;
  riskScore: number; signals: string[]; quarantined: boolean; alerted: boolean;
}
export const antiraidConfigFields = [
  'join_window_seconds', 'join_threshold', 'young_account_age', 'young_account_weight',
  'message_spam_threshold', 'message_spam_window_seconds', 'mention_threshold', 'auto_quarantine', 'alert_channel',
] as const;
export type AntiRaidConfigField = typeof antiraidConfigFields[number];

function parseConfigValue(field: AntiRaidConfigField, value: string): AntiRaidSettingsPatch {
  const integer = (min: number, max: number) => {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < min || parsed > max)
      throw new AppError('VALIDATION', `Expected an integer between ${min} and ${max}.`);
    return parsed;
  };
  switch (field) {
    case 'join_window_seconds': return { joinWindowSeconds: integer(5, 86400) };
    case 'join_threshold': return { joinThreshold: integer(2, 1000) };
    case 'young_account_age': {
      const input = value.trim().toLowerCase();
      if (['none', 'off', '0'].includes(input)) return { youngAccountAgeSeconds: 0 };
      return { youngAccountAgeSeconds: parseDuration(input) };
    }
    case 'young_account_weight': return { youngAccountWeight: integer(0, 100) };
    case 'message_spam_threshold': return { messageSpamThreshold: integer(2, 1000) };
    case 'message_spam_window_seconds': return { messageSpamWindowSeconds: integer(5, 86400) };
    case 'mention_threshold': return { mentionThreshold: integer(0, 100) };
    case 'auto_quarantine': {
      const input = value.trim().toLowerCase();
      if (!['true', 'false'].includes(input)) throw new AppError('VALIDATION', 'Expected true or false.');
      return { autoQuarantine: input === 'true' };
    }
    case 'alert_channel': {
      const input = value.trim();
      if (['clear', 'none', ''].includes(input.toLowerCase())) return { alertChannelId: null };
      if (!snowflake.test(input)) throw new AppError('VALIDATION', 'Expected a Discord channel ID or clear.');
      return { alertChannelId: input };
    }
    default: throw new AppError('VALIDATION', 'Unknown anti-raid setting.');
  }
}

export class AntiRaidService {
  private readonly quarantineSuccess = new Map<string, number>();
  private recentlyQuarantined(key: string, at: number) {
    const last = this.quarantineSuccess.get(key);
    return last !== undefined && at - last < 60_000;
  }
  private rememberQuarantine(key: string, at: number) {
    this.quarantineSuccess.set(key, at);
    while (this.quarantineSuccess.size > 5000) this.quarantineSuccess.delete(this.quarantineSuccess.keys().next().value!);
  }
  constructor(
    private readonly repository: AntiRaidRepository,
    private readonly permissions: PermissionService,
    private readonly logger: Logger,
    private readonly notify?: GuildLogNotifier,
    private readonly verification?: RaidVerificationPort,
    private readonly alertSink?: RaidAlertSink,
    private readonly tracker: MessageActivityTracker = new MessageActivityTracker(),
    private readonly hasSecurityLogDestination: (guildId: string) => Promise<boolean> = async () => false,
  ) {}

  private async require(actor: Actor, level: PermissionLevel) { await this.permissions.require(actor, level); }

  async status(actor: Actor) {
    await this.require(actor, 'MODERATOR');
    return this.repository.ensureSettings(actor.guildId);
  }
  async setEnabled(actor: Actor, enabled: boolean) {
    await this.require(actor, 'ADMIN');
    if (enabled) {
      const settings = await this.repository.ensureSettings(actor.guildId);
      if (!settings.alertChannelId && !await this.hasSecurityLogDestination(actor.guildId))
        throw new AppError('VALIDATION', 'Configure an anti-raid alert channel or enable security logging before enabling anti-raid.');
    }
    return this.repository.updateSettings(actor.guildId, { enabled }, actor.userId);
  }
  async configure(actor: Actor, field: string, value: string) {
    await this.require(actor, 'ADMIN');
    if (!antiraidConfigFields.includes(field as AntiRaidConfigField))
      throw new AppError('VALIDATION', 'Unknown anti-raid setting.');
    const patch = parseConfigValue(field as AntiRaidConfigField, value);
    return this.repository.updateSettings(actor.guildId, patch, actor.userId);
  }
  async emergency(actor: Actor, enabled: boolean, reason?: string) {
    await this.require(actor, 'SENIOR_MODERATOR');
    const settings = await this.repository.setEmergency(actor.guildId, {
      enabled, actorId: actor.userId,
      reason: enabled ? (reason?.trim() || 'manual_activation') : (reason?.trim() || 'manual_deactivation'),
    });
    await this.notify?.(actor.guildId, 'security', enabled ? 'Emergency mode enabled' : 'Emergency mode disabled', [
      { name: 'Staff ID', value: actor.userId }, { name: 'Reason', value: settings.emergencyReason ?? 'manual' },
    ], { actorId: actor.userId });
    return settings;
  }

  /** Transparent rule-based join scoring. Young accounts alone never trigger a raid response. */
  async handleJoin(input: {
    guildId: string; userId: string; joinedAt: Date; accountCreatedAt: Date | null; verificationStatus?: string | null;
  }): Promise<JoinEvaluation> {
    const settings = await this.repository.ensureSettings(input.guildId);
    const accountAgeSeconds = input.accountCreatedAt
      ? Math.max(0, Math.floor((input.joinedAt.getTime() - input.accountCreatedAt.getTime()) / 1000)) : null;
    if (!settings.enabled || input.joinedAt.getTime() < Date.now() - 30 * 86400_000)
      return { enabled: false, riskScore: 0, signals: [], joinCount: 0, youngAccount: false,
      burst: false, emergency: settings.emergencyMode, emergencyActivated: false, quarantined: false, alerted: false };
    const decision = await this.repository.evaluateJoin({ ...input, accountAgeSeconds,
      verificationStatus: input.verificationStatus ?? null, riskScore: 0, signals: [] });
    const current = decision.settings;
    if (!current.enabled) return { enabled: false, duplicate: decision.duplicate, riskScore: 0, signals: [],
      joinCount: 0, youngAccount: false, burst: false, emergency: current.emergencyMode,
      emergencyActivated: false, quarantined: false, alerted: false };
    const joinCount = decision.joinCount;
    const youngAccount = accountAgeSeconds !== null && accountAgeSeconds < current.youngAccountAgeSeconds;
    const burst = joinCount >= current.joinThreshold;
    const emergency = current.emergencyMode;
    const emergencyActivated = decision.emergencyActivated;
    const signals = decision.record?.signals ?? [];
    const riskScore = decision.record?.riskScore ?? 0;
    // Establish the review gate before alert delivery or Discord role operations can yield.
    if (emergency || emergencyActivated)
      await this.verification?.markManualReview(input.guildId, input.userId, 'emergency_mode', input.joinedAt);
    if (decision.duplicate) {
      // Role application and metadata writes are idempotent: retry after a partial failure.
      const quarantineKey = `${input.guildId}:${input.userId}`;
      if (current.autoQuarantine && this.verification && (signals.includes('join_burst') || emergency)
        && !this.recentlyQuarantined(quarantineKey, Date.now())) {
        try {
          if (await this.verification.quarantineForRaid(input.guildId, input.userId, signals.join(', ') || 'raid_suspicion', 'join'))
            this.rememberQuarantine(quarantineKey, Date.now());
        }
        catch (error) { this.logger.warn({ guildId: input.guildId, errorType: error instanceof Error ? error.name : 'unknown' }, 'Anti-raid quarantine retry failed'); }
      }
      return { enabled: true, duplicate: true, riskScore, signals, joinCount, youngAccount, burst,
        emergency, emergencyActivated: false, quarantined: false, alerted: false };
    }
    if (emergencyActivated) {
      await this.emitAlert(input.guildId, current, 'Emergency mode activated: join burst', [
        { name: 'Joins in window', value: `${joinCount}/${settings.joinThreshold}` },
        { name: 'Window (seconds)', value: String(settings.joinWindowSeconds) },
        { name: 'Signals', value: signals.join(', ') },
      ]);
    }
    const suspiciousYoung = youngAccount && joinCount >= Math.min(3, current.joinThreshold);
    let quarantined = false;
    if (settings.autoQuarantine && this.verification && (burst || emergency || suspiciousYoung)) {
      try {
        quarantined = await this.verification.quarantineForRaid(input.guildId, input.userId, signals.join(', ') || 'raid_suspicion', 'join');
        if (quarantined) this.rememberQuarantine(`${input.guildId}:${input.userId}`, Date.now());
      } catch (error) {
        this.logger.warn({ guildId: input.guildId, errorType: error instanceof Error ? error.name : 'unknown' }, 'Anti-raid quarantine failed');
      }
      if (quarantined) {
        await this.notify?.(input.guildId, 'security', 'Member auto-quarantined', [
          { name: 'Member ID', value: input.userId },
          { name: 'Signals', value: signals.join(', ') || 'raid_suspicion' },
          { name: 'Risk score', value: String(riskScore) },
        ], { targetId: input.userId });
      }
    }
    let alerted = emergencyActivated;
    if ((burst || suspiciousYoung) && !emergencyActivated
      && this.tracker.shouldAlert(input.guildId, 'raid_alert', input.joinedAt.getTime(), 120)) {
      await this.emitAlert(input.guildId, settings, burst ? 'Raid suspicion: repeated joins' : 'Suspicious join activity', [
        { name: 'Joins in window', value: `${joinCount}/${settings.joinThreshold}` },
        { name: 'Signals', value: signals.join(', ') || 'young_account' },
        { name: 'Risk score', value: String(riskScore) },
      ]);
      alerted = true;
    }
    return { enabled: true, riskScore, signals, joinCount, youngAccount, burst, emergency,
      emergencyActivated, quarantined, alerted };
  }

  /** Message metadata only: timestamps, counts and duplicate IDs. Content is never accessed or stored. */
  async handleMessage(input: {
    guildId: string; userId: string; messageId: string; at: number; mentionCount: number;
  }): Promise<MessageEvaluation> {
    const settings = await this.repository.ensureSettings(input.guildId);
    const empty = { spam: false, mentions: false, riskScore: 0, signals: [] as string[], quarantined: false, alerted: false };
    if (!settings.enabled) return { ignored: true, ...empty };
    const count = this.tracker.record(input.guildId, input.userId, input.messageId, input.at, settings.messageSpamWindowSeconds);
    if (count === null) return { duplicate: true, ...empty };
    const spam = count >= settings.messageSpamThreshold;
    const mentions = settings.mentionThreshold > 0 && input.mentionCount >= settings.mentionThreshold;
    if (!spam && !mentions) return empty;
    const signals: string[] = [];
    if (spam) signals.push('message_spam');
    if (mentions) signals.push('mass_mentions');
    const riskScore = (spam ? MESSAGE_SPAM_POINTS : 0) + (mentions ? MASS_MENTION_POINTS : 0);
    const shouldAlert = this.tracker.shouldAlert(input.guildId, input.userId, input.at, 60);
    let quarantined = false;
    const quarantineKey = `${input.guildId}:${input.userId}`;
    if (settings.autoQuarantine && this.verification && !this.recentlyQuarantined(quarantineKey, Date.now())) {
      try {
        quarantined = await this.verification.quarantineForRaid(input.guildId, input.userId, signals.join(', '), 'message');
        if (quarantined) this.rememberQuarantine(quarantineKey, Date.now());
      } catch (error) {
        this.logger.warn({ guildId: input.guildId, errorType: error instanceof Error ? error.name : 'unknown' }, 'Anti-raid quarantine failed');
      }
    }
    if (!shouldAlert) return { suppressed: true, spam, mentions, riskScore, signals, quarantined, alerted: false };
    await this.emitAlert(input.guildId, settings, 'Suspicious message activity', [
      { name: 'Member ID', value: input.userId },
      { name: 'Messages in window', value: `${count}/${settings.messageSpamThreshold}` },
      { name: 'Mentions', value: String(input.mentionCount) },
      { name: 'Signals', value: signals.join(', ') },
      { name: 'Quarantined', value: String(quarantined) },
    ]);
    return { spam, mentions, riskScore, signals, quarantined, alerted: true };
  }

  private async emitAlert(guildId: string, settings: AntiRaidSettings, title: string,
    fields: readonly LogField[]) {
    await this.notify?.(guildId, 'security', title, fields);
    if (settings.alertChannelId && this.alertSink) {
      try { await this.alertSink.sendTo(guildId, settings.alertChannelId, 'security', title, fields); }
      catch (error) { this.logger.warn({ guildId, errorType: error instanceof Error ? error.name : 'unknown' }, 'Anti-raid alert channel delivery failed'); }
    }
  }
}
