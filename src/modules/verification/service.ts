import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionLevel, PermissionService } from '../../core/permissions/permission-service.js';
import type { Logger } from '../../core/logger/logger.js';
import type { GuildLogNotifier } from '../../services/log-notifier.js';
import { buildVerificationPanel } from './panel.js';
import type { VerificationGateway } from './discord-gateway.js';
import type {
  MemberVerification, VerificationMethod, VerificationMode, VerificationRepository,
  VerificationSettings, VerificationStatus,
} from './repository.js';

const snowflake = /^\d{17,20}$/;
export const verificationModes: readonly VerificationMode[] = ['BUTTON', 'MANUAL', 'BUTTON_AND_ACCOUNT_AGE'];

export interface VerificationJoinInput { guildId: string; userId: string; accountCreatedAt: Date | null; joinedAt: Date }
export interface VerificationJoinOutcome { status: VerificationStatus | 'DISABLED'; quarantined: boolean }
export interface VerificationResult {
  status: VerificationStatus; alreadyVerified?: boolean; verified?: boolean; quarantined?: boolean; accountTooYoung?: boolean;
}

export class VerificationService {
  private readonly memberOperations = new Map<string, Promise<void>>();
  private async serializeMember<T>(guildId: string, userId: string, action: () => Promise<T>): Promise<T> {
    const key = `${guildId}:${userId}`;
    const previous = this.memberOperations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.memberOperations.set(key, tail);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.memberOperations.get(key) === tail) this.memberOperations.delete(key);
    }
  }
  constructor(
    private readonly repository: VerificationRepository,
    private readonly permissions: PermissionService,
    private readonly logger: Logger,
    private readonly gatewayForGuild: (guildId: string) => Promise<VerificationGateway>,
    private readonly notify?: GuildLogNotifier,
    private readonly emergencyActive?: (guildId: string) => Promise<boolean>,
  ) {}

  private async require(actor: Actor, level: PermissionLevel) { await this.permissions.require(actor, level); }

  async settings(actor: Actor) {
    await this.require(actor, 'ADMIN');
    return this.repository.ensureSettings(actor.guildId);
  }
  async setEnabled(actor: Actor, enabled: boolean) {
    await this.require(actor, 'ADMIN');
    if (enabled) {
      const settings = await this.repository.ensureSettings(actor.guildId);
      if (settings.mode === 'BUTTON_AND_ACCOUNT_AGE' && !settings.minAccountAgeSeconds)
        throw new AppError('VALIDATION', 'Configure a minimum account age before enabling age-gated verification.');
      await this.assertConfiguredRoles(actor.guildId, settings);
    }
    return this.repository.updateSettings(actor.guildId, { enabled }, actor.userId);
  }
  private async assertConfiguredRoles(guildId: string, settings: VerificationSettings) {
    if (!settings.verifiedRoleId || !settings.quarantineRoleId || settings.verifiedRoleId === settings.quarantineRoleId)
      throw new AppError('VALIDATION', 'Configure distinct verified and quarantine roles before enabling verification.');
    const gateway = await this.gatewayForGuild(guildId);
    await gateway.assertRoleUsable(settings.verifiedRoleId);
    await gateway.assertRoleUsable(settings.quarantineRoleId);
  }
  async validatePanelInteraction(guildId: string, messageId: string, channelId: string, userId: string) {
    const settings = await this.repository.ensureSettings(guildId);
    if (!settings.enabled || !settings.panelMessageId || !settings.verificationChannelId ||
      settings.panelMessageId !== messageId || settings.verificationChannelId !== channelId)
      throw new AppError('VALIDATION', 'This verification panel is no longer active. Ask staff for the current panel.');
    if (!await (await this.gatewayForGuild(guildId)).memberExists(userId))
      throw new AppError('NOT_FOUND', 'You are no longer a member of this server.');
  }
  async setMode(actor: Actor, mode: string) {
    await this.require(actor, 'ADMIN');
    if (!verificationModes.includes(mode as VerificationMode)) throw new AppError('VALIDATION', 'Unknown verification mode.');
    if (mode === 'BUTTON_AND_ACCOUNT_AGE' && !(await this.repository.ensureSettings(actor.guildId)).minAccountAgeSeconds)
      throw new AppError('VALIDATION', 'Set /verification min-account-age before choosing the age-gated mode.');
    return this.repository.updateSettings(actor.guildId, { mode }, actor.userId);
  }
  async setChannel(actor: Actor, channelId: string | null) {
    await this.require(actor, 'ADMIN');
    if (channelId !== null && !snowflake.test(channelId)) throw new AppError('VALIDATION', 'Expected a Discord channel ID.');
    return this.repository.updateSettings(actor.guildId, { verificationChannelId: channelId }, actor.userId);
  }
  async setRole(actor: Actor, kind: 'verified' | 'quarantine', roleId: string | null) {
    await this.require(actor, 'ADMIN');
    if (roleId !== null && !snowflake.test(roleId)) throw new AppError('VALIDATION', 'Expected a Discord role ID.');
    if (roleId !== null) {
      const settings = await this.repository.ensureSettings(actor.guildId);
      if (roleId === (kind === 'verified' ? settings.quarantineRoleId : settings.verifiedRoleId))
        throw new AppError('VALIDATION', 'Verified and quarantine roles must be distinct.');
      const gateway = await this.gatewayForGuild(actor.guildId);
      await gateway.assertRoleUsable(roleId);
    }
    return this.repository.updateSettings(actor.guildId,
      kind === 'verified' ? { verifiedRoleId: roleId } : { quarantineRoleId: roleId }, actor.userId);
  }
  async setMinAccountAge(actor: Actor, seconds: number | null) {
    await this.require(actor, 'ADMIN');
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < 60)) throw new AppError('VALIDATION', 'Minimum account age must be at least one minute, or none.');
    if (seconds === null && (await this.repository.ensureSettings(actor.guildId)).mode === 'BUTTON_AND_ACCOUNT_AGE')
      throw new AppError('VALIDATION', 'Switch to another verification mode before clearing the age requirement.');
    return this.repository.updateSettings(actor.guildId, { minAccountAgeSeconds: seconds }, actor.userId);
  }
  async setRulesAck(actor: Actor, required: boolean) {
    await this.require(actor, 'ADMIN');
    return this.repository.updateSettings(actor.guildId, { requireRulesAck: required }, actor.userId);
  }
  async memberStatus(actor: Actor, userId: string) {
    await this.require(actor, 'MODERATOR');
    if (!snowflake.test(userId)) throw new AppError('VALIDATION', 'Invalid member.');
    return { settings: await this.repository.ensureSettings(actor.guildId), member: await this.repository.getMember(actor.guildId, userId) };
  }

  async publishPanel(actor: Actor) {
    await this.require(actor, 'ADMIN');
    const settings = await this.repository.ensureSettings(actor.guildId);
    if (!settings.verificationChannelId) throw new AppError('NOT_FOUND', 'Configure a verification channel first.');
    const gateway = await this.gatewayForGuild(actor.guildId);
    const panel = buildVerificationPanel(settings);
    const messageId = await gateway.sendPanel(settings.verificationChannelId, panel);
    await this.repository.updateSettings(actor.guildId, { panelMessageId: messageId }, actor.userId);
    return { messageId, channelId: settings.verificationChannelId };
  }

  /** Join handling is best-effort per step: a missing role must never crash the join or lose the pending row. */
  async handleJoin(input: VerificationJoinInput): Promise<VerificationJoinOutcome> {
    return this.serializeMember(input.guildId, input.userId, () => this.handleJoinLocked(input));
  }
  private async handleJoinLocked(input: VerificationJoinInput): Promise<VerificationJoinOutcome> {
    const settings = await this.repository.ensureSettings(input.guildId);
    if (!settings.enabled) return { status: 'DISABLED', quarantined: false };
    const row = await this.repository.resetForRejoin(input.guildId, input.userId, input.joinedAt, input.accountCreatedAt);
    if (row.status === 'VERIFIED' || row.status === 'BYPASSED') return { status: row.status, quarantined: false };
    if (settings.mode === 'BUTTON_AND_ACCOUNT_AGE' && settings.minAccountAgeSeconds && input.accountCreatedAt) {
      const ageSeconds = accountAgeSeconds(input.accountCreatedAt, input.joinedAt);
      if (ageSeconds < settings.minAccountAgeSeconds) {
        await this.repository.mergeMetadata(input.guildId, input.userId, { accountTooYoung: true, accountAgeSeconds: ageSeconds });
      }
    }
    let quarantined = false;
    if (settings.quarantineRoleId) {
      try {
        const gateway = await this.gatewayForGuild(input.guildId);
        await gateway.assertRoleUsable(settings.quarantineRoleId);
        await gateway.applyQuarantine(input.userId, settings.quarantineRoleId);
        quarantined = true;
      } catch (error) {
        await this.reportConfigProblem(input.guildId, 'quarantine role', error);
      }
    }
    await this.notify?.(input.guildId, 'general', 'Member pending verification',
      [{ name: 'User ID', value: input.userId }], { targetId: input.userId });
    return { status: row.status as VerificationStatus, quarantined };
  }

  async acknowledgeRules(guildId: string, userId: string) {
    if (!snowflake.test(guildId) || !snowflake.test(userId)) throw new AppError('VALIDATION', 'Invalid verification context.');
    const settings = await this.repository.ensureSettings(guildId);
    if (!settings.enabled) throw new AppError('DISABLED', 'Verification is currently disabled.');
    await this.repository.upsertPending(guildId, userId, null);
    const record = await this.repository.acknowledgeRules(guildId, userId);
    if (!record) throw new AppError('NOT_FOUND', 'No verification record found. Please try again.');
    return record;
  }

  async verifyWithButton(input: { guildId: string; userId: string; accountCreatedAt: Date | null }): Promise<VerificationResult> {
    return this.serializeMember(input.guildId, input.userId, () => this.verifyButtonLocked(input));
  }
  private async verifyButtonLocked(input: { guildId: string; userId: string; accountCreatedAt: Date | null }): Promise<VerificationResult> {
    if (!snowflake.test(input.guildId) || !snowflake.test(input.userId))
      throw new AppError('VALIDATION', 'Invalid verification context.');
    const settings = await this.repository.ensureSettings(input.guildId);
    if (!settings.enabled) throw new AppError('DISABLED', 'Verification is currently disabled.');
    if (settings.mode === 'MANUAL') throw new AppError('DISABLED', 'This server uses manual verification. Please wait for staff review.');
    const row = await this.repository.upsertPending(input.guildId, input.userId, input.accountCreatedAt);
    if (row.status === 'VERIFIED' || row.status === 'BYPASSED') return { status: row.status, alreadyVerified: true };
    if (row.status === 'REJECTED') throw new AppError('PERMISSION', 'Your verification was rejected. Please contact staff.');
    if (await this.emergencyActive?.(input.guildId)) {
      await this.repository.mergeMetadata(input.guildId, input.userId,
        { requiresManualReview: true, manualReviewReason: 'emergency_mode' });
      throw new AppError('DISABLED', 'Staff review is required during emergency mode. Please wait for a moderator.');
    }
    if (row.metadata.requiresManualReview === true)
      throw new AppError('DISABLED', 'Staff review is required for new accounts right now. Please wait for a moderator.');
    if (settings.requireRulesAck && !row.rulesAcknowledgedAt)
      throw new AppError('VALIDATION', 'Please acknowledge the rules first.');
    const accountCreatedAt = input.accountCreatedAt ?? row.accountCreatedAt;
    if (settings.mode === 'BUTTON_AND_ACCOUNT_AGE' && !settings.minAccountAgeSeconds)
      throw new AppError('VALIDATION', 'Account-age verification is not configured. Please contact staff.');
    if (settings.mode === 'BUTTON_AND_ACCOUNT_AGE' && settings.minAccountAgeSeconds) {
      if (!accountCreatedAt || !Number.isFinite(accountCreatedAt.getTime()))
        throw new AppError('VALIDATION', 'Account age could not be determined. Ask staff to review your account.');
      const ageSeconds = accountAgeSeconds(accountCreatedAt, new Date());
      if (ageSeconds < settings.minAccountAgeSeconds) {
        await this.repository.mergeMetadata(input.guildId, input.userId, { accountTooYoung: true, accountAgeSeconds: ageSeconds });
        await this.notify?.(input.guildId, 'security', 'Verification blocked by account age', [
          { name: 'User ID', value: input.userId },
          { name: 'Account age (seconds)', value: String(ageSeconds) },
          { name: 'Required age (seconds)', value: String(settings.minAccountAgeSeconds) },
        ], { targetId: input.userId });
        throw new AppError('VALIDATION', 'Your account is too new to verify automatically. Staff review may be required.');
      }
    }
    return this.finishVerification(settings, input.guildId, input.userId, 'BUTTON', null, ['PENDING']);
  }

  async approve(actor: Actor, userId: string, reason?: string) {
    return this.serializeMember(actor.guildId, userId, () => this.approveLocked(actor, userId, reason));
  }
  private async approveLocked(actor: Actor, userId: string, reason?: string) {
    await this.require(actor, 'MODERATOR');
    if (!snowflake.test(userId)) throw new AppError('VALIDATION', 'Invalid member.');
    if (reason !== undefined && reason.length > 400) throw new AppError('VALIDATION', 'Reason must be up to 400 characters.');
    const settings = await this.repository.ensureSettings(actor.guildId);
    const existing = await this.repository.getMember(actor.guildId, userId) ??
      await this.repository.upsertPending(actor.guildId, userId, null);
    if (existing.status === 'VERIFIED' || existing.status === 'BYPASSED') return { status: existing.status, alreadyVerified: true } as VerificationResult;
    const result = await this.finishVerification(settings, actor.guildId, userId, 'MANUAL', actor.userId, ['PENDING', 'REJECTED'], reason);
    await this.notify?.(actor.guildId, 'moderation', 'Verification approved', [
      { name: 'Member ID', value: userId }, { name: 'Staff ID', value: actor.userId },
      ...(reason ? [{ name: 'Reason', value: reason }] : []),
    ], { targetId: userId, actorId: actor.userId });
    return result;
  }

  async reject(actor: Actor, userId: string, reason: string) {
    return this.serializeMember(actor.guildId, userId, () => this.rejectLocked(actor, userId, reason));
  }
  private async rejectLocked(actor: Actor, userId: string, reason: string) {
    await this.require(actor, 'MODERATOR');
    if (!snowflake.test(userId) || !reason.trim() || reason.length > 400)
      throw new AppError('VALIDATION', 'Provide a valid member and a reason up to 400 characters.');
    const existing = await this.repository.getMember(actor.guildId, userId);
    if (!existing) throw new AppError('NOT_FOUND', 'No pending verification for that member.');
    if (existing.status === 'VERIFIED')
      throw new AppError('CONFLICT', 'That member is already verified; use moderation actions instead.');
    const updated = await this.repository.transition(actor.guildId, userId, ['PENDING'], 'REJECTED', {
      rejectedAt: new Date(), rejectedBy: actor.userId, reason: reason.trim(),
    });
    if (!updated) {
      const current = await this.repository.getMember(actor.guildId, userId);
      if (current?.status === 'REJECTED') return current;
      throw new AppError('CONFLICT', 'Verification state changed. Review the member before retrying.');
    }
    await this.notify?.(actor.guildId, 'security', 'Verification rejected', [
      { name: 'Member ID', value: userId }, { name: 'Staff ID', value: actor.userId }, { name: 'Reason', value: reason.trim() },
    ], { targetId: userId, actorId: actor.userId });
    return updated;
  }

  async listPending(actor: Actor) {
    await this.require(actor, 'MODERATOR');
    return this.repository.listPending(actor.guildId);
  }

  /** Called by anti-raid when emergency mode requires staff approval for a member. */
  async markManualReview(guildId: string, userId: string, reason: string, joinedAt?: Date) {
    if (!snowflake.test(guildId) || !snowflake.test(userId)) return;
    await this.serializeMember(guildId, userId, async () => {
      const row = joinedAt
        ? await this.repository.resetForRejoin(guildId, userId, joinedAt, null)
        : await this.repository.upsertPending(guildId, userId, null);
      if (row.status === 'VERIFIED' && row.method === 'MANUAL') return;
      await this.repository.mergeMetadata(guildId, userId, { requiresManualReview: true, manualReviewReason: reason });
      if (row.status === 'VERIFIED' || row.status === 'BYPASSED')
        await this.restrictVerifiedMember(guildId, userId, row.status);
    });
  }

  private async restrictVerifiedMember(guildId: string, userId: string, status: VerificationStatus) {
    try {
      const settings = await this.repository.ensureSettings(guildId);
      if (!settings.quarantineRoleId || !settings.verifiedRoleId)
        throw new AppError('VALIDATION', 'Verification roles are not configured for emergency review.');
      const gateway = await this.gatewayForGuild(guildId);
      await gateway.assertRoleUsable(settings.quarantineRoleId);
      await gateway.assertRoleUsable(settings.verifiedRoleId);
      await gateway.applyQuarantine(userId, settings.quarantineRoleId);
      await gateway.removeVerifiedRole(userId, settings.verifiedRoleId);
      const updated = await this.repository.transition(guildId, userId, [status], 'PENDING', {
        method: null, verifiedAt: null, verifiedBy: null, rulesAcknowledgedAt: null,
      });
      if (!updated) throw new AppError('CONFLICT', 'Verification state changed during emergency restriction.');
    } catch (error) {
      this.logger.warn({ guildId, userId, errorType: error instanceof Error ? error.name : 'unknown' },
        'Emergency review could not reconcile verification roles; manual intervention required');
      await this.reportConfigProblem(guildId, 'emergency verification review', error);
    }
  }

  /** Called by anti-raid; returns false when quarantine could not be applied. */
  async quarantineForRaid(guildId: string, userId: string, reason: string, source: 'join' | 'message' = 'join') {
    if (!snowflake.test(guildId) || !snowflake.test(userId)) return false;
    return this.serializeMember(guildId, userId, () => this.quarantineForRaidLocked(guildId, userId, reason, source));
  }
  private async quarantineForRaidLocked(guildId: string, userId: string, reason: string, source: 'join' | 'message') {
    // A delayed duplicate join must not re-quarantine a member already approved
    // for this membership epoch. Message-based abuse is handled separately.
    const existing = await this.repository.getMember(guildId, userId);
    if (source === 'join' && (existing?.status === 'VERIFIED' || existing?.status === 'BYPASSED')) return false;
    const settings = await this.repository.ensureSettings(guildId);
    if (!settings.quarantineRoleId) {
      this.logger.warn({ guildId }, 'Anti-raid quarantine requested without a configured quarantine role');
      await this.notify?.(guildId, 'security', 'Anti-raid quarantine unavailable',
        [{ name: 'Detail', value: 'No quarantine role is configured in verification settings.' }]);
      return false;
    }
    try {
      const gateway = await this.gatewayForGuild(guildId);
      await gateway.assertRoleUsable(settings.quarantineRoleId);
      await gateway.applyQuarantine(userId, settings.quarantineRoleId);
      const row = await this.repository.upsertPending(guildId, userId, null);
      await this.repository.mergeMetadata(guildId, userId, { raidQuarantined: true, raidReason: reason,
        ...(source === 'message' ? { requiresManualReview: true, manualReviewReason: reason } : {}) });
      if (source === 'message' && (row.status === 'VERIFIED' || row.status === 'BYPASSED')) {
        await this.restrictVerifiedMember(guildId, userId, row.status);
        return (await this.repository.getMember(guildId, userId))?.status === 'PENDING';
      }
      return true;
    } catch (error) {
      await this.reportConfigProblem(guildId, 'anti-raid quarantine', error);
      return false;
    }
  }

  private async finishVerification(settings: VerificationSettings, guildId: string, userId: string,
    method: VerificationMethod, actorId: string | null,
    from: readonly VerificationStatus[], reason?: string): Promise<VerificationResult> {
    await this.assertConfiguredRoles(guildId, settings);
    const gateway = await this.gatewayForGuild(guildId);
    if (!await gateway.memberExists(userId)) throw new AppError('NOT_FOUND', 'The member is no longer in the server.');
    const verifiedRoleId = settings.verifiedRoleId!;
    const { quarantineRemoved } = await gateway.completeVerification(userId, verifiedRoleId, settings.quarantineRoleId);
    let updated: MemberVerification | undefined;
    try {
      updated = await this.repository.transition(guildId, userId, from, 'VERIFIED', {
        method, verifiedAt: new Date(), verifiedBy: actorId, ...(reason !== undefined ? { reason } : {}),
      });
    } catch (error) {
      this.logger.error({ guildId, userId, errorType: error instanceof Error ? error.name : 'unknown' },
        'Verification role granted but database transition failed; manual role reconciliation required');
      throw error;
    }
    if (!updated) {
      const current = await this.repository.getMember(guildId, userId);
      if (current?.status === 'VERIFIED' || current?.status === 'BYPASSED')
        return { status: current.status, alreadyVerified: true };
      this.logger.error({ guildId, userId }, 'Verification role granted but state changed; manual role reconciliation required');
      throw new AppError('CONFLICT', 'Verification state changed. Please contact staff to reconcile roles.');
    }
    if (!quarantineRemoved) {
      await this.notify?.(guildId, 'security', 'Verification cleanup incomplete', [
        { name: 'Member ID', value: userId },
        { name: 'Detail', value: 'The verified role was granted but the quarantine role could not be removed; manual cleanup is required.' },
      ], { targetId: userId });
    }
    if (actorId === null) {
      await this.notify?.(guildId, 'general', 'Member verified',
        [{ name: 'Member ID', value: userId }, { name: 'Method', value: method }], { targetId: userId });
    }
    return { status: 'VERIFIED', verified: true, quarantined: !quarantineRemoved };
  }

  private async reportConfigProblem(guildId: string, area: string, error: unknown) {
    const detail = error instanceof AppError ? error.message : 'Unexpected Discord error';
    this.logger.warn({ guildId, area, errorType: error instanceof Error ? error.name : 'unknown' }, 'Verification configuration problem');
    await this.notify?.(guildId, 'security', 'Verification configuration problem', [
      { name: 'Area', value: area }, { name: 'Detail', value: detail },
    ]);
  }
}

export function accountAgeSeconds(accountCreatedAt: Date, at: Date) {
  return Math.max(0, Math.floor((at.getTime() - accountCreatedAt.getTime()) / 1000));
}

export type { MemberVerification };
