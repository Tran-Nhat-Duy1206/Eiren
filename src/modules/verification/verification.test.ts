import { describe, expect, it, vi } from 'vitest';
import { Events, MessageFlags } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import { presentationColor } from '../../core/presentation/index.js';
import { PermissionService, type Actor } from '../../core/permissions/permission-service.js';
import type { Logger } from '../../core/logger/logger.js';
import type { Services } from '../../app/services.js';
import { ModuleService } from '../../services/module-service.js';
import { dispatchButton, type ButtonHandler } from '../../core/components/component.js';
import { dispatchEvent } from '../../core/events/event.js';
import { buildRegistry, type ModuleManifest } from '../../app/registry.js';
import { VerificationService } from './service.js';
import { verificationEvents } from './events.js';
import { verificationButtons } from './components.js';
import { buildVerificationPanel, RULES_ACK_BUTTON_ID, VERIFY_BUTTON_ID } from './panel.js';
import type { VerificationGateway } from './discord-gateway.js';
import type { MemberVerification, VerificationRepository, VerificationSettings } from './repository.js';

const guildId = '12345678901234567';
const ownerId = '22345678901234567';
const userId = '32345678901234567';
const otherUserId = '42345678901234567';
const verifiedRoleId = '52345678901234567';
const quarantineRoleId = '62345678901234567';
const staffRoleId = '72345678901234567';
const owner: Actor = { guildId, guildOwnerId: ownerId, userId: ownerId, roleIds: [] };
const moderator: Actor = { ...owner, userId: '82345678901234567', roleIds: [staffRoleId] };

type Row = MemberVerification;
class FakeVerificationRepository {
  settings = new Map<string, VerificationSettings>();
  members = new Map<string, Row>();
  async getSettings(id: string) { return this.settings.get(id); }
  async ensureSettings(id: string) {
    if (!this.settings.has(id)) {
      this.settings.set(id, {
        guildId: id, enabled: false, mode: 'BUTTON', verificationChannelId: null,
        verifiedRoleId, quarantineRoleId, minAccountAgeSeconds: null,
        requireRulesAck: false, panelMessageId: null, updatedBy: null, updatedAt: new Date(),
      });
    }
    return this.settings.get(id)!;
  }
  async updateSettings(id: string, patch: Partial<VerificationSettings>) {
    const settings = await this.ensureSettings(id);
    Object.assign(settings, patch, { updatedAt: new Date() });
    return settings;
  }
  async getMember(id: string, target: string) { return this.members.get(`${id}:${target}`); }
  async upsertPending(id: string, target: string, accountCreatedAt: Date | null) {
    const key = `${id}:${target}`;
    if (!this.members.has(key)) {
      this.members.set(key, {
        id: this.members.size + 1, guildId: id, userId: target, status: 'PENDING', method: null, reason: null,
        accountCreatedAt, createdAt: new Date(), updatedAt: new Date(), verifiedAt: null, verifiedBy: null,
        rejectedAt: null, rejectedBy: null, rulesAcknowledgedAt: null, metadata: {},
      });
    }
    return this.members.get(key)!;
  }
  async resetForRejoin(id: string, target: string, joinedAt: Date, accountCreatedAt: Date | null) {
    const existing = await this.getMember(id, target);
    const row = await this.upsertPending(id, target, accountCreatedAt);
    if (!existing || joinedAt.getTime() > row.createdAt.getTime()) Object.assign(row, {
      status: 'PENDING', method: null, reason: null, accountCreatedAt, createdAt: joinedAt,
      verifiedAt: null, verifiedBy: null, rejectedAt: null, rejectedBy: null, rulesAcknowledgedAt: null, metadata: {},
    });
    return row;
  }
  async transition(id: string, target: string, from: string[], to: string, fields: Record<string, unknown> = {}) {
    const row = this.members.get(`${id}:${target}`);
    if (!row || !from.includes(row.status)) return undefined;
    Object.assign(row, { status: to, updatedAt: new Date(), ...fields });
    return row;
  }
  async acknowledgeRules(id: string, target: string) {
    const row = this.members.get(`${id}:${target}`);
    if (row?.status === 'PENDING') Object.assign(row, { rulesAcknowledgedAt: new Date() });
    return row?.status === 'PENDING' ? row : undefined;
  }
  async mergeMetadata(id: string, target: string, patch: Record<string, string | number | boolean | null>) {
    const row = this.members.get(`${id}:${target}`);
    if (row) row.metadata = { ...row.metadata, ...patch };
    return row;
  }
  async listPending(id: string) { return [...this.members.values()].filter(row => row.guildId === id && row.status === 'PENDING'); }
}
function permissions(level = 'ADMIN') {
  return new PermissionService({ getRoleLevels: async (_guild, roles) => roles.length ? [level] : [] });
}
function fixture(level = 'ADMIN', emergencyActive?: (guildId: string) => Promise<boolean>) {
  const repository = new FakeVerificationRepository();
  const applied: string[] = [];
  const gateway: VerificationGateway = {
    assertRoleUsable: vi.fn(async (roleId: string) => {
      if (roleId === '00000000000000000') throw new AppError('NOT_FOUND', 'A configured verification role no longer exists. Ask staff to reconfigure it.');
      if (roleId === '11111111111111111') throw new AppError('PERMISSION', 'The bot role must be higher than the configured verification role.');
      return { id: roleId, name: `role-${roleId}` };
    }),
    applyQuarantine: vi.fn(async (memberId: string, roleId: string) => { applied.push(`quarantine:${memberId}:${roleId}`); }),
    removeVerifiedRole: vi.fn(async (memberId: string, roleId: string) => { applied.push(`remove-verified:${memberId}:${roleId}`); }),
    completeVerification: vi.fn(async (memberId: string, role: string, quarantine: string | null) => {
      applied.push(`verify:${memberId}:${role}`);
      if (quarantine) applied.push(`unquarantine:${memberId}:${quarantine}`);
      return { quarantineRemoved: true };
    }),
    memberExists: vi.fn(async () => true),
    sendPanel: vi.fn(async () => 'panel-message-id'),
  };
  const notify = vi.fn(async () => {});
  const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const service = new VerificationService(repository as unknown as VerificationRepository,
    permissions(level), logger, async () => gateway, notify, emergencyActive);
  return { service, repository, gateway, applied, notify, logger };
}

describe('verification configuration', () => {
  it('persists settings and validates roles through the gateway', async () => {
    const { service, repository, gateway } = fixture();
    expect((await service.setMode(owner, 'MANUAL')).mode).toBe('MANUAL');
    expect((await service.setEnabled(owner, true)).enabled).toBe(true);
    expect((await service.setRole(owner, 'verified', verifiedRoleId)).verifiedRoleId).toBe(verifiedRoleId);
    expect(gateway.assertRoleUsable).toHaveBeenCalledWith(verifiedRoleId);
    await expect(service.setRole(owner, 'quarantine', '00000000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.setMode(owner, 'CAPTCHA')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.setMinAccountAge(owner, 30)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await service.setMinAccountAge(owner, 86400)).minAccountAgeSeconds).toBe(86400);
    expect((await service.settings(owner)).mode).toBe('MANUAL');
  });
  it('enforces ADMIN for configuration and MODERATOR for review', async () => {
    const { service } = fixture('MODERATOR');
    await expect(service.setEnabled(moderator, true)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(service.approve(moderator, userId)).resolves.toBeDefined();
  });
  it('posts a panel, stores its message ID, and uses stable component IDs', async () => {
    const { service, gateway, repository } = fixture();
    await service.setChannel(owner, guildId);
    const result = await service.publishPanel(owner);
    expect(result.messageId).toBe('panel-message-id');
    expect((await repository.ensureSettings(guildId)).panelMessageId).toBe('panel-message-id');
    expect(gateway.sendPanel).toHaveBeenCalledWith(guildId, expect.anything());
    const panel = buildVerificationPanel({ mode: 'BUTTON', minAccountAgeSeconds: null, requireRulesAck: false });
    expect(panel.embeds[0]!.toJSON()).toMatchObject({ title: 'Verification', color: presentationColor('INFO') });
    expect(VERIFY_BUTTON_ID).toBe('eiren:v2:verify');
    expect(RULES_ACK_BUTTON_ID).toBe('eiren:v2:ack');
    const ids = panel.components.flatMap(row => row.components.map(button => (button.toJSON() as { custom_id?: string }).custom_id));
    expect(ids).toEqual([VERIFY_BUTTON_ID]);
    const withAck = buildVerificationPanel({ mode: 'BUTTON', minAccountAgeSeconds: null, requireRulesAck: true });
    const ackIds = withAck.components.flatMap(row => row.components.map(button => (button.toJSON() as { custom_id?: string }).custom_id));
    expect(ackIds).toEqual([RULES_ACK_BUTTON_ID, VERIFY_BUTTON_ID]);
    const manual = buildVerificationPanel({ mode: 'MANUAL', minAccountAgeSeconds: null, requireRulesAck: false });
    expect(manual.components).toEqual([]);
    await expect(service.publishPanel({ ...owner, guildId: '99999999999999999' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('verification join handling', () => {
  it('quarantines and records pending state for enabled verification', async () => {
    const { service, repository, applied, notify } = fixture();
    await service.setEnabled(owner, true);
    await service.setRole(owner, 'quarantine', quarantineRoleId);
    const outcome = await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(Date.now() - 90 * 86400_000), joinedAt: new Date() });
    expect(outcome).toEqual({ status: 'PENDING', quarantined: true });
    expect((await repository.getMember(guildId, userId))?.status).toBe('PENDING');
    expect(applied).toEqual([`quarantine:${userId}:${quarantineRoleId}`]);
    expect(notify).toHaveBeenCalledWith(guildId, 'general', 'Member pending verification', expect.anything(), expect.anything());
  });
  it('stays safe when the quarantine role is missing or unusable', async () => {
    const { service, repository, notify } = fixture();
    await service.setEnabled(owner, true);
    (await repository.ensureSettings(guildId)).quarantineRoleId = '11111111111111111';
    const outcome = await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() });
    expect(outcome).toEqual({ status: 'PENDING', quarantined: false });
    expect((await repository.getMember(guildId, userId))?.status).toBe('PENDING');
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Verification configuration problem', expect.anything());
  });
  it('does nothing when verification is disabled and tolerates duplicate join events', async () => {
    const { service, repository, applied } = fixture();
    expect(await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() }))
      .toEqual({ status: 'DISABLED', quarantined: false });
    expect(await repository.getMember(guildId, userId)).toBeUndefined();
    await service.setEnabled(owner, true);
    await service.setRole(owner, 'quarantine', quarantineRoleId);
    await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() });
    await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() });
    expect(repository.members.size).toBe(1);
    expect(applied.filter(item => item.startsWith('quarantine'))).toHaveLength(2);
  });
});

describe('verification outcomes', () => {
  it('verifies via button, removes quarantine, and is idempotent on duplicate clicks', async () => {
    const { service, repository, gateway, applied } = fixture();
    await service.setEnabled(owner, true);
    (await repository.ensureSettings(guildId)).quarantineRoleId = quarantineRoleId;
    await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() });
    const first = await service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() });
    expect(first.status).toBe('VERIFIED');
    expect(applied).toContain(`verify:${userId}:${verifiedRoleId}`);
    expect(applied).toContain(`unquarantine:${userId}:${quarantineRoleId}`);
    const second = await service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() });
    expect(second.alreadyVerified).toBe(true);
    expect(gateway.completeVerification).toHaveBeenCalledTimes(1);
  });
  it('holds young accounts instead of rejecting them and records the decision', async () => {
    const { service, repository, gateway, notify } = fixture();
    await service.setEnabled(owner, true);
    await expect(service.setMode(owner, 'BUTTON_AND_ACCOUNT_AGE')).rejects.toMatchObject({ code: 'VALIDATION' });
    await service.setMinAccountAge(owner, 7 * 86400);
    await service.setMode(owner, 'BUTTON_AND_ACCOUNT_AGE');
    await expect(service.setMinAccountAge(owner, null)).rejects.toMatchObject({ code: 'VALIDATION' });
    const youngAccount = new Date(Date.now() - 3600_000);
    await service.handleJoin({ guildId, userId, accountCreatedAt: youngAccount, joinedAt: new Date() });
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: youngAccount }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    const row = await repository.getMember(guildId, userId);
    expect(row?.status).toBe('PENDING');
    expect(row?.metadata.accountTooYoung).toBe(true);
    expect(row?.metadata.accountAgeSeconds).toBeTypeOf('number');
    expect(gateway.completeVerification).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Verification blocked by account age', expect.anything(), expect.anything());
  });
  it('requires rules acknowledgement before verifying when configured', async () => {
    const { service, repository } = fixture();
    await service.setEnabled(owner, true);
    await service.setRulesAck(owner, true);
    (await repository.ensureSettings(guildId)).requireRulesAck = true;
    await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() });
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await service.acknowledgeRules(guildId, userId);
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() }))
      .resolves.toMatchObject({ status: 'VERIFIED' });
  });
  it('refuses button verification while emergency review is required', async () => {
    const { service, repository } = fixture();
    await service.setEnabled(owner, true);
    await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() });
    await service.markManualReview(guildId, userId, 'emergency_mode');
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() }))
      .rejects.toMatchObject({ code: 'DISABLED' });
    expect((await repository.getMember(guildId, userId))?.status).toBe('PENDING');
  });
  it('blocks verification while the mode is MANUAL', async () => {
    const { service } = fixture();
    await service.setEnabled(owner, true);
    await service.setMode(owner, 'MANUAL');
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() }))
      .rejects.toMatchObject({ code: 'DISABLED' });
  });
  it('approves manually and rejects without banning', async () => {
    const { service, repository, notify } = fixture();
    await service.setEnabled(owner, true);
    await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() });
    const approved = await service.approve(moderator, userId, 'known member');
    expect(approved).toMatchObject({ status: 'VERIFIED' });
    expect((await repository.getMember(guildId, userId))?.method).toBe('MANUAL');
    expect((await repository.getMember(guildId, userId))?.verifiedBy).toBe(moderator.userId);
    await service.handleJoin({ guildId, userId: otherUserId, accountCreatedAt: new Date(), joinedAt: new Date() });
    const rejected = await service.reject(moderator, otherUserId, 'suspicious behaviour');
    expect(rejected.status).toBe('REJECTED');
    expect((await repository.getMember(guildId, otherUserId))?.rejectedBy).toBe(moderator.userId);
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Verification rejected', expect.anything(), expect.anything());
    await expect(service.reject(moderator, userId, 'again')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.reject(moderator, '92345678901234567', 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await service.approve(moderator, userId)).toMatchObject({ alreadyVerified: true });
  });
  it('fails safely when the verified role is missing or the bot hierarchy is too low', async () => {
    const { service, repository, gateway } = fixture();
    await service.setEnabled(owner, true);
    await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() });
    (await repository.ensureSettings(guildId)).verifiedRoleId = '00000000000000000';
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    (await repository.ensureSettings(guildId)).verifiedRoleId = '11111111111111111';
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() }))
      .rejects.toMatchObject({ code: 'PERMISSION' });
    expect(gateway.completeVerification).not.toHaveBeenCalled();
    expect((await repository.getMember(guildId, userId))?.status).toBe('PENDING');
  });
  it('keeps state across a fresh service instance', async () => {
    const { service, repository, gateway } = fixture();
    await service.setEnabled(owner, true);
    await service.handleJoin({ guildId, userId, accountCreatedAt: new Date(), joinedAt: new Date() });
    await service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() });
    const restarted = new VerificationService(repository as unknown as VerificationRepository,
      permissions(), { warn: vi.fn(), error: vi.fn() } as unknown as Logger, async () => gateway, vi.fn(async () => {}));
    const { member, settings } = await restarted.memberStatus(owner, userId);
    expect(settings.enabled).toBe(true);
    expect(member?.status).toBe('VERIFIED');
    await expect(restarted.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() }))
      .resolves.toMatchObject({ alreadyVerified: true });
  });
});

describe('verification security regressions', () => {
  it('rejects stale and wrong-channel panels and absent members', async () => {
    const { service, repository, gateway } = fixture();
    await service.setEnabled(owner, true);
    await service.setChannel(owner, guildId);
    await service.publishPanel(owner);
    await expect(service.validatePanelInteraction(guildId, 'stale', guildId, userId)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.validatePanelInteraction(guildId, 'panel-message-id', otherUserId, userId)).rejects.toMatchObject({ code: 'VALIDATION' });
    vi.mocked(gateway.memberExists).mockResolvedValueOnce(false);
    await expect(service.validatePanelInteraction(guildId, 'panel-message-id', guildId, userId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await repository.ensureSettings(guildId)).panelMessageId).toBe('panel-message-id');
  });
  it('serializes simultaneous button clicks and competing staff rejection', async () => {
    const { service, gateway, repository } = fixture();
    await service.setEnabled(owner, true);
    await service.handleJoin({ guildId, userId, joinedAt: new Date(), accountCreatedAt: new Date() });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(gateway.completeVerification).mockImplementationOnce(async () => {
      await gate;
      return { quarantineRemoved: true };
    });
    const first = service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() });
    const second = service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() });
    const rejection = service.reject(moderator, userId, 'raced approval');
    release();
    expect((await first).status).toBe('VERIFIED');
    expect(await second).toMatchObject({ alreadyVerified: true });
    await expect(rejection).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(gateway.completeVerification).toHaveBeenCalledTimes(1);
    expect((await repository.getMember(guildId, userId))?.status).toBe('VERIFIED');
  });
  it('fails closed on unknown account age and rejects identical role configuration', async () => {
    const { service, repository, gateway } = fixture();
    await expect(service.setRole(owner, 'verified', quarantineRoleId)).rejects.toMatchObject({ code: 'VALIDATION' });
    await service.setEnabled(owner, true);
    await service.setMinAccountAge(owner, 86400);
    await service.setMode(owner, 'BUTTON_AND_ACCOUNT_AGE');
    await service.handleJoin({ guildId, userId, joinedAt: new Date(), accountCreatedAt: null });
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: null })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(gateway.completeVerification).not.toHaveBeenCalled();
    (await repository.ensureSettings(guildId)).verifiedRoleId = quarantineRoleId;
    await expect(service.approve(moderator, userId)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('does not quarantine a verified duplicate join, resets a later membership epoch, and only acknowledges pending rows', async () => {
    const { service, repository, gateway } = fixture();
    await service.setEnabled(owner, true);
    const firstJoin = new Date(Date.now() - 60000);
    await service.handleJoin({ guildId, userId, joinedAt: firstJoin, accountCreatedAt: new Date(Date.now() - 86400000) });
    await service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date(Date.now() - 86400000) });
    vi.mocked(gateway.applyQuarantine).mockClear();
    expect((await service.handleJoin({ guildId, userId, joinedAt: firstJoin, accountCreatedAt: null })).status).toBe('VERIFIED');
    expect(gateway.applyQuarantine).not.toHaveBeenCalled();
    await expect(service.acknowledgeRules(guildId, userId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await service.handleJoin({ guildId, userId, joinedAt: new Date(), accountCreatedAt: null })).status).toBe('PENDING');
    expect((await repository.getMember(guildId, userId))?.rulesAcknowledgedAt).toBeNull();
  });
});

describe('emergency review interleavings', () => {
  it('preserves a review marker installed before the verification join event', async () => {
    const { service, repository, gateway } = fixture();
    await service.setEnabled(owner, true);
    const joinedAt = new Date(Date.now() - 1000);
    await service.markManualReview(guildId, userId, 'emergency_mode', joinedAt);
    await service.handleJoin({ guildId, userId, joinedAt, accountCreatedAt: new Date(Date.now() - 86400000) });
    expect((await repository.getMember(guildId, userId))?.metadata.requiresManualReview).toBe(true);
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date(Date.now() - 86400000) }))
      .rejects.toMatchObject({ code: 'DISABLED' });
    expect(gateway.completeVerification).not.toHaveBeenCalled();
  });
  it('revokes a button verification when emergency review arrives afterwards', async () => {
    const { service, repository, applied } = fixture();
    await service.setEnabled(owner, true);
    const joinedAt = new Date(Date.now() - 1000);
    await service.handleJoin({ guildId, userId, joinedAt, accountCreatedAt: new Date(Date.now() - 86400000) });
    await service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date(Date.now() - 86400000) });
    await service.markManualReview(guildId, userId, 'emergency_mode', joinedAt);
    expect(applied).toContain(`remove-verified:${userId}:${verifiedRoleId}`);
    expect((await repository.getMember(guildId, userId))?.status).toBe('PENDING');
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: null })).rejects.toMatchObject({ code: 'DISABLED' });
  });
  it('checks persisted emergency mode before granting the verified role', async () => {
    const { service, repository, gateway } = fixture('ADMIN', async () => true);
    await service.setEnabled(owner, true);
    await service.handleJoin({ guildId, userId, joinedAt: new Date(), accountCreatedAt: new Date() });
    await expect(service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() })).rejects.toMatchObject({ code: 'DISABLED' });
    expect((await repository.getMember(guildId, userId))?.metadata.requiresManualReview).toBe(true);
    expect(gateway.completeVerification).not.toHaveBeenCalled();
  });
  it('ignores a delayed duplicate join after staff approval', async () => {
    const { service, repository, gateway } = fixture();
    await service.setEnabled(owner, true);
    const joinedAt = new Date(Date.now() - 1000);
    await service.handleJoin({ guildId, userId, joinedAt, accountCreatedAt: new Date() });
    await service.approve(moderator, userId);
    vi.mocked(gateway.applyQuarantine).mockClear();
    await service.markManualReview(guildId, userId, 'emergency_mode', joinedAt);
    expect(await service.quarantineForRaid(guildId, userId, 'join_burst', 'join')).toBe(false);
    expect(gateway.applyQuarantine).not.toHaveBeenCalled();
    expect((await repository.getMember(guildId, userId))?.status).toBe('VERIFIED');
  });
  it('revokes verified access on message-triggered quarantine', async () => {
    const { service, repository, applied } = fixture();
    await service.setEnabled(owner, true);
    await service.handleJoin({ guildId, userId, joinedAt: new Date(), accountCreatedAt: new Date() });
    await service.verifyWithButton({ guildId, userId, accountCreatedAt: new Date() });
    expect(await service.quarantineForRaid(guildId, userId, 'message_spam', 'message')).toBe(true);
    expect(applied).toContain(`remove-verified:${userId}:${verifiedRoleId}`);
    expect((await repository.getMember(guildId, userId))?.status).toBe('PENDING');
  });
});

describe('verification dispatch gating', () => {
  it('gates the join event on the verification module', async () => {
    const state = new Map<string, boolean>();
    const modules = new ModuleService({
      getModuleState: async (_guild, key) => state.get(key),
      setModuleState: async (_guild, key, enabled) => { state.set(key, enabled); },
      listModuleStates: async () => [],
    }, [{ key: 'core', defaultEnabled: true }, { key: 'verification', defaultEnabled: false }]);
    const handleJoin = vi.fn(async () => {});
    const services = { modules, verification: { handleJoin } } as unknown as Services;
    const event = verificationEvents.find(item => item.name === Events.GuildMemberAdd)!;
    const member = { id: userId, guild: { id: guildId }, user: { createdAt: new Date() }, joinedAt: new Date() };
    await dispatchEvent(event, services, member);
    expect(handleJoin).not.toHaveBeenCalled();
    await modules.setEnabled(guildId, 'verification', true, ownerId);
    await dispatchEvent(event, services, member);
    expect(handleJoin).toHaveBeenCalledWith(expect.objectContaining({ guildId, userId }));
  });
  it('gates buttons on the module, guild context, and replies safely', async () => {
    const state = new Map<string, boolean>();
    const modules = new ModuleService({
      getModuleState: async (_guild, key) => state.get(key),
      setModuleState: async (_guild, key, enabled) => { state.set(key, enabled); },
      listModuleStates: async () => [],
    }, [{ key: 'core', defaultEnabled: true }, { key: 'verification', defaultEnabled: false }]);
    const verifyWithButton = vi.fn(async () => ({ status: 'VERIFIED' as const }));
    const services = { modules, logger: { warn: vi.fn(), error: vi.fn() }, verification: { verifyWithButton, validatePanelInteraction: vi.fn(async () => {}) } } as unknown as Services;
    const handlers = new Map<string, ButtonHandler>(verificationButtons.map(handler => [handler.customId, handler]));
    const reply = vi.fn(async () => {});
    const interaction = {
      customId: VERIFY_BUTTON_ID, guildId, channelId: guildId, message: { id: 'panel-message-id' }, guild: { id: guildId }, inGuild: () => true,
      user: { id: userId, createdAt: new Date() }, deferred: false, replied: false,
      deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}), reply, followUp: vi.fn(async () => {}),
    };
    await dispatchButton(interaction as never, handlers, services);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'This module is disabled in this server.' }));
    expect(verifyWithButton).not.toHaveBeenCalled();
    await modules.setEnabled(guildId, 'verification', true, ownerId);
    await dispatchButton(interaction as never, handlers, services);
    expect(verifyWithButton).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Verification complete') }));
    const guildless = { ...interaction, guildId: null, guild: null, inGuild: () => false };
    await dispatchButton(guildless as never, handlers, services);
    expect(guildless.reply).toBeDefined();
  });
  it('rejects duplicate or mis-owned components at registry build time', () => {
    const core: ModuleManifest = { definition: { key: 'core', defaultEnabled: true }, commands: [], events: [] };
    const handler: ButtonHandler = { customId: 'eiren:test:button', moduleKey: 'one', handle: vi.fn(async () => {}) };
    expect(buildRegistry([core, { definition: { key: 'one', defaultEnabled: false }, commands: [], events: [], components: [handler] }])
      .components.get('eiren:test:button')).toBe(handler);
    expect(() => buildRegistry([core,
      { definition: { key: 'one', defaultEnabled: false }, commands: [], events: [], components: [handler] },
      { definition: { key: 'two', defaultEnabled: false }, commands: [], events: [], components: [handler] },
    ])).toThrow('Invalid or duplicate component');
    expect(() => buildRegistry([core,
      { definition: { key: 'one', defaultEnabled: false }, commands: [], events: [],
        components: [{ ...handler, moduleKey: 'two' }] },
    ])).toThrow('Invalid or duplicate component');
  });
  it('exports only dispatcher-gated buttons with stable IDs', () => {
    expect(verificationButtons.every(button => button.moduleKey === 'verification')).toBe(true);
    expect(verificationButtons.map(button => button.customId)).toEqual([VERIFY_BUTTON_ID, RULES_ACK_BUTTON_ID]);
  });
});
