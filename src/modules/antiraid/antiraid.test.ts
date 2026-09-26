import { describe, expect, it, vi } from 'vitest';
import { Events } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import { PermissionService, type Actor } from '../../core/permissions/permission-service.js';
import type { Logger } from '../../core/logger/logger.js';
import type { Services } from '../../app/services.js';
import { ModuleService } from '../../services/module-service.js';
import { dispatchEvent } from '../../core/events/event.js';
import { buildRegistry, manifests } from '../../app/registry.js';
import { AntiRaidService, type RaidAlertSink, type RaidVerificationPort } from './service.js';
import { antiraidEvents } from './events.js';
import { MessageActivityTracker } from './tracker.js';
import type { AntiRaidRepository, AntiRaidSettings, JoinHistoryInput, JoinHistoryRecord } from './repository.js';

const guildId = '12345678901234567';
const ownerId = '22345678901234567';
const userId = '32345678901234567';
const staffRoleId = '42345678901234567';
const owner: Actor = { guildId, guildOwnerId: ownerId, userId: ownerId, roleIds: [] };
const seniorModerator: Actor = { ...owner, userId: '52345678901234567', roleIds: [staffRoleId] };

class FakeAntiRaidRepository {
  settings = new Map<string, AntiRaidSettings>();
  history: JoinHistoryRecord[] = [];
  async getSettings(id: string) { return this.settings.get(id); }
  async ensureSettings(id: string) {
    if (!this.settings.has(id)) {
      this.settings.set(id, {
        guildId: id, enabled: false, joinWindowSeconds: 60, joinThreshold: 5,
        youngAccountAgeSeconds: 7 * 86400, youngAccountWeight: 25, messageSpamThreshold: 10,
        messageSpamWindowSeconds: 30, mentionThreshold: 5, autoQuarantine: true, alertChannelId: null,
        emergencyMode: false, emergencyActivatedAt: null, emergencyReason: null, emergencyActorId: null,
        emergencyJoinCount: null, emergencyWindowSeconds: null, updatedBy: null, updatedAt: new Date(),
      });
    }
    return this.settings.get(id)!;
  }
  async updateSettings(id: string, patch: Partial<AntiRaidSettings>) {
    const settings = await this.ensureSettings(id);
    Object.assign(settings, patch, { updatedAt: new Date() });
    return settings;
  }
  async findJoin(id: string, target: string, joinedAt: Date) {
    return this.history.find(row => row.guildId === id && row.userId === target && +row.joinedAt === +joinedAt);
  }
  async recordJoin(values: JoinHistoryInput) {
    const existing = await this.findJoin(values.guildId, values.userId, values.joinedAt);
    if (existing) return existing;
    const row = { id: this.history.length + 1, ...values } as JoinHistoryRecord;
    this.history.push(row);
    return row;
  }
  async countJoinsSince(id: string, since: Date) {
    return this.history.filter(row => row.guildId === id && row.joinedAt >= since).length;
  }
  async evaluateJoin(values: JoinHistoryInput) {
    const settings = await this.ensureSettings(values.guildId);
    const windowSeconds = settings.joinWindowSeconds;
    const threshold = settings.joinThreshold;
    const existing = await this.findJoin(values.guildId, values.userId, values.joinedAt);
    const joinCount = this.history.filter(row => row.guildId === values.guildId
      && row.joinedAt >= new Date(+values.joinedAt - windowSeconds * 1000) && row.joinedAt <= values.joinedAt).length + (existing ? 0 : 1);
    if (existing) return { settings, record: existing, duplicate: true, joinCount, emergencyActivated: false };
    const young = values.accountAgeSeconds !== null && values.accountAgeSeconds < settings.youngAccountAgeSeconds;
    const burst = joinCount >= threshold;
    const emergency = settings.emergencyMode;
    const signals = [burst ? 'join_burst' : '', young ? 'young_account' : '', emergency ? 'emergency_mode' : ''].filter(Boolean);
    const record = await this.recordJoin({ ...values, signals, riskScore: (burst ? 60 : 0)
      + (young ? settings.youngAccountWeight : 0) + (emergency ? 20 : 0) });
    if (burst && !emergency) await this.setEmergency(values.guildId,
      { enabled: true, actorId: 'SYSTEM', reason: 'join_burst', joinCount, windowSeconds });
    return { settings: { ...settings, emergencyMode: emergency }, record, duplicate: false, joinCount,
      emergencyActivated: burst && !emergency };
  }
  async setEmergency(id: string, state: { enabled: boolean; actorId: string; reason: string; joinCount?: number | null; windowSeconds?: number | null }) {
    const settings = await this.ensureSettings(id);
    if (state.enabled) {
      settings.emergencyMode = true; settings.emergencyActivatedAt = new Date();
      settings.emergencyJoinCount = state.joinCount ?? null; settings.emergencyWindowSeconds = state.windowSeconds ?? null;
    } else {
      settings.emergencyMode = false;
    }
    settings.emergencyReason = state.reason; settings.emergencyActorId = state.actorId;
    return settings;
  }
  async recentJoins(id: string) { return this.history.filter(row => row.guildId === id); }
}
function permissions(level = 'ADMIN') {
  return new PermissionService({ getRoleLevels: async (_guild, roles) => roles.length ? [level] : [] });
}
function fixture(level = 'ADMIN', hasSecurityLogDestination: (guildId: string) => Promise<boolean> = async () => true) {
  const repository = new FakeAntiRaidRepository();
  const quarantineForRaid = vi.fn(async () => true);
  const markManualReview = vi.fn(async () => {});
  const verification: RaidVerificationPort = { quarantineForRaid, markManualReview };
  const notify = vi.fn(async () => {});
  const sendTo = vi.fn(async () => {});
  const alertSink: RaidAlertSink = { sendTo };
  const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const tracker = new MessageActivityTracker();
  const service = new AntiRaidService(repository as unknown as AntiRaidRepository, permissions(level), logger,
    notify, verification, alertSink, tracker, hasSecurityLogDestination);
  return { service, repository, verification, notify, sendTo, tracker, quarantineForRaid, markManualReview };
}
async function enable(service: AntiRaidService, patch: Partial<AntiRaidSettings> = {}) {
  await service.setEnabled(owner, true);
  return patch;
}
const oldAccount = () => new Date(Date.now() - 365 * 86400_000);
const youngAccount = () => new Date(Date.now() - 3600_000);

describe('anti-raid join scoring', () => {
  it('does not act on normal join traffic', async () => {
    const { service, repository, quarantineForRaid, notify } = fixture();
    await enable(service);
    const result = await service.handleJoin({ guildId, userId, joinedAt: new Date(), accountCreatedAt: oldAccount() });
    expect(result).toMatchObject({ enabled: true, riskScore: 0, signals: [], burst: false, emergencyActivated: false, quarantined: false });
    expect(quarantineForRaid).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(repository.history).toHaveLength(1);
    expect(repository.history[0]?.riskScore).toBe(0);
  });
  it('adds young-account weight but a single young account is not a raid', async () => {
    const { service, quarantineForRaid, notify } = fixture();
    await enable(service);
    const result = await service.handleJoin({ guildId, userId, joinedAt: new Date(), accountCreatedAt: youngAccount() });
    expect(result.signals).toEqual(['young_account']);
    expect(result.riskScore).toBe(25);
    expect(result.burst).toBe(false);
    expect(result.emergencyActivated).toBe(false);
    expect(quarantineForRaid).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it('detects a join burst, persists emergency mode, alerts, and quarantines instead of banning', async () => {
    const { service, repository, quarantineForRaid, markManualReview, notify, sendTo } = fixture();
    await enable(service);
    await service.configure(owner, 'join_threshold', '3');
    await service.configure(owner, 'alert_channel', '92345678901234567');
    const base = Date.now();
    await service.handleJoin({ guildId, userId: '10000000000000001', joinedAt: new Date(base), accountCreatedAt: oldAccount() });
    const second = await service.handleJoin({ guildId, userId: '10000000000000002', joinedAt: new Date(base + 1000), accountCreatedAt: oldAccount() });
    expect(second.burst).toBe(false);
    const thirdJoinedAt = new Date(base + 2000);
    const third = await service.handleJoin({ guildId, userId: '10000000000000003', joinedAt: thirdJoinedAt, accountCreatedAt: youngAccount() });
    expect(third).toMatchObject({ burst: true, emergencyActivated: true, quarantined: true });
    expect(third.signals).toEqual(['join_burst', 'young_account']);
    expect(repository.settings.get(guildId)?.emergencyMode).toBe(true);
    expect(repository.settings.get(guildId)?.emergencyActorId).toBe('SYSTEM');
    expect(repository.settings.get(guildId)?.emergencyReason).toBe('join_burst');
    expect(repository.settings.get(guildId)?.emergencyJoinCount).toBe(3);
    expect(quarantineForRaid).toHaveBeenCalledWith(guildId, '10000000000000003', expect.stringContaining('join_burst'), 'join');
    expect(markManualReview).toHaveBeenCalledWith(guildId, '10000000000000003', 'emergency_mode', thirdJoinedAt);
    expect(markManualReview.mock.invocationCallOrder[0]!).toBeLessThan(quarantineForRaid.mock.invocationCallOrder[0]!);
    expect(markManualReview.mock.invocationCallOrder[0]!).toBeLessThan(sendTo.mock.invocationCallOrder[0]!);
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Emergency mode activated: join burst', expect.anything());
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Member auto-quarantined', expect.anything(), expect.anything());
    expect(sendTo).toHaveBeenCalledWith(guildId, '92345678901234567', 'security', expect.stringContaining('Emergency mode activated'), expect.anything());
    expect(repository.history).toHaveLength(3);
  });
  it('does not retain personal join history while disabled', async () => {
    const { service, repository, quarantineForRaid, notify } = fixture();
    const result = await service.handleJoin({ guildId, userId, joinedAt: new Date(), accountCreatedAt: youngAccount() });
    expect(result).toMatchObject({ enabled: false, riskScore: 0, quarantined: false });
    expect(repository.history).toHaveLength(0);
    expect(quarantineForRaid).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it('treats duplicate join events idempotently', async () => {
    const { service, repository, quarantineForRaid, markManualReview } = fixture();
    await enable(service);
    await service.configure(owner, 'join_threshold', '2');
    const joinedAt = new Date();
    await service.handleJoin({ guildId, userId, joinedAt, accountCreatedAt: oldAccount() });
    const first = await service.handleJoin({ guildId, userId: '10000000000000009', joinedAt: new Date(), accountCreatedAt: oldAccount() });
    expect(first.emergencyActivated).toBe(true);
    const repeated = await service.handleJoin({ guildId, userId, joinedAt, accountCreatedAt: oldAccount() });
    expect(repeated.duplicate).toBe(true);
    expect(repeated.emergencyActivated).toBe(false);
    expect(repository.history).toHaveLength(2);
    expect(repository.settings.get(guildId)?.emergencyActivatedAt).toBeInstanceOf(Date);
    expect(quarantineForRaid).toHaveBeenCalledTimes(2); // replay repairs the first join after emergency activation
    expect(markManualReview).toHaveBeenCalledTimes(2);
    expect(markManualReview).toHaveBeenNthCalledWith(2, guildId, userId, 'emergency_mode', joinedAt);
    expect(markManualReview.mock.invocationCallOrder[1]!).toBeLessThan(quarantineForRaid.mock.invocationCallOrder[1]!);
  });
});

describe('anti-raid configuration and emergency mode', () => {
  it('rejects activation without an alert destination without enabling the module setting', async () => {
    const { service, repository } = fixture('ADMIN', async () => false);
    await expect(service.setEnabled(owner, true)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(repository.settings.get(guildId)?.enabled).toBe(false);
    await service.configure(owner, 'alert_channel', '92345678901234567');
    await expect(service.setEnabled(owner, true)).resolves.toMatchObject({ enabled: true });
  });
  it('validates and persists configuration with ADMIN permission', async () => {
    const { service } = fixture('ADMIN');
    await enable(service);
    expect((await service.configure(owner, 'join_threshold', '7')).joinThreshold).toBe(7);
    expect((await service.configure(owner, 'young_account_age', '12h')).youngAccountAgeSeconds).toBe(43200);
    expect((await service.configure(owner, 'young_account_age', 'none')).youngAccountAgeSeconds).toBe(0);
    expect((await service.configure(owner, 'auto_quarantine', 'false')).autoQuarantine).toBe(false);
    expect((await service.configure(owner, 'alert_channel', '92345678901234567')).alertChannelId).toBe('92345678901234567');
    expect((await service.configure(owner, 'alert_channel', 'clear')).alertChannelId).toBeNull();
    await expect(service.configure(owner, 'join_threshold', '-1')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.configure(owner, 'join_window_seconds', 'abc')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.configure(owner, 'unknown_field', '1')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('denies configuration below ADMIN and emergency below SENIOR_MODERATOR', async () => {
    const moderatorFixture = fixture('MODERATOR');
    await expect(moderatorFixture.service.setEnabled(seniorModerator, true)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(moderatorFixture.service.emergency(seniorModerator, true)).rejects.toMatchObject({ code: 'PERMISSION' });
    const seniorFixture = fixture('SENIOR_MODERATOR');
    await expect(seniorFixture.service.emergency(seniorModerator, true, 'drill')).resolves.toMatchObject({ emergencyMode: true });
    await expect(seniorFixture.service.configure(seniorModerator, 'join_threshold', '6')).rejects.toMatchObject({ code: 'PERMISSION' });
  });
  it('persists emergency mode across restarts and only disables on explicit action', async () => {
    const { service, repository, notify } = fixture();
    await service.emergency(owner, true, 'drill');
    expect(repository.settings.get(guildId)).toMatchObject({ emergencyMode: true, emergencyReason: 'drill', emergencyActorId: ownerId });
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Emergency mode enabled', expect.anything(), expect.anything());
    const restarted = new AntiRaidService(repository as unknown as AntiRaidRepository, permissions(),
      { warn: vi.fn() } as unknown as Logger, notify);
    expect((await restarted.status(owner)).emergencyMode).toBe(true);
    await restarted.emergency(owner, false);
    expect(repository.settings.get(guildId)?.emergencyMode).toBe(false);
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Emergency mode disabled', expect.anything(), expect.anything());
  });
});

describe('anti-raid message metadata signals', () => {
  it('detects message spam and quarantines using counts only, with duplicate and cooldown protection', async () => {
    const { service, quarantineForRaid, notify } = fixture();
    await enable(service);
    await service.configure(owner, 'message_spam_threshold', '3');
    const base = Date.now();
    expect((await service.handleMessage({ guildId, userId, messageId: 'm1', at: base, mentionCount: 0 })).spam).toBe(false);
    expect((await service.handleMessage({ guildId, userId, messageId: 'm2', at: base + 1000, mentionCount: 0 })).spam).toBe(false);
    const third = await service.handleMessage({ guildId, userId, messageId: 'm3', at: base + 2000, mentionCount: 0 });
    expect(third).toMatchObject({ spam: true, alerted: true, quarantined: true });
    expect(third.signals).toEqual(['message_spam']);
    expect(quarantineForRaid).toHaveBeenCalledWith(guildId, userId, 'message_spam', 'message');
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Suspicious message activity', expect.anything());
    const duplicate = await service.handleMessage({ guildId, userId, messageId: 'm3', at: base + 2500, mentionCount: 0 });
    expect(duplicate.duplicate).toBe(true);
    const suppressed = await service.handleMessage({ guildId, userId, messageId: 'm4', at: base + 3000, mentionCount: 0 });
    expect(suppressed).toMatchObject({ spam: true, suppressed: true, alerted: false });
    expect(quarantineForRaid).toHaveBeenCalledTimes(1);
  });
  it('retries quarantine on the next suspicious message when the first attempt fails', async () => {
    const { service, quarantineForRaid } = fixture();
    await enable(service);
    await service.configure(owner, 'mention_threshold', '2');
    quarantineForRaid.mockResolvedValueOnce(false);
    const at = Date.now();
    expect((await service.handleMessage({ guildId, userId, messageId: 'retry-1', at, mentionCount: 3 })).quarantined).toBe(false);
    const retry = await service.handleMessage({ guildId, userId, messageId: 'retry-2', at: at + 1000, mentionCount: 3 });
    expect(retry).toMatchObject({ suppressed: true, quarantined: true });
    expect(quarantineForRaid).toHaveBeenCalledTimes(2);
  });
  it('flags mass mentions and ignores disabled protection', async () => {
    const { service, notify } = fixture();
    const disabled = await service.handleMessage({ guildId, userId, messageId: 'm1', at: Date.now(), mentionCount: 9 });
    expect(disabled.ignored).toBe(true);
    await enable(service);
    await service.configure(owner, 'mention_threshold', '2');
    const flagged = await service.handleMessage({ guildId, userId, messageId: 'm2', at: Date.now(), mentionCount: 3 });
    expect(flagged).toMatchObject({ mentions: true, signals: ['mass_mentions'] });
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Suspicious message activity', expect.anything());
  });
});

describe('anti-raid module integration', () => {
  it('enforces the verification dependency through the module system', async () => {
    const state = new Map<string, boolean>();
    const repository = {
      getModuleState: async (_guild: string, key: string) => state.get(key),
      setModuleState: async (_guild: string, key: string, enabled: boolean) => { state.set(key, enabled); },
      listModuleStates: async () => [],
    };
    const modules = new ModuleService(repository, [
      { key: 'core', defaultEnabled: true },
      { key: 'verification', defaultEnabled: false },
      { key: 'antiraid', defaultEnabled: false, dependencies: ['verification'] },
    ]);
    await expect(modules.setEnabled(guildId, 'antiraid', true, ownerId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await modules.isEnabled(guildId, 'antiraid')).toBe(false);
    await modules.setEnabled(guildId, 'verification', true, ownerId);
    await modules.setEnabled(guildId, 'antiraid', true, ownerId);
    expect(await modules.isEnabled(guildId, 'antiraid')).toBe(true);
    await expect(modules.setEnabled(guildId, 'verification', false, ownerId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await modules.setEnabled(guildId, 'antiraid', false, ownerId);
    await modules.setEnabled(guildId, 'verification', false, ownerId);
    expect(await modules.isEnabled(guildId, 'verification')).toBe(false);
    expect(manifests.find(module => module.definition.key === 'antiraid')?.definition.dependencies).toEqual(['verification']);
    expect(buildRegistry(manifests).commands.has('antiraid')).toBe(true);
  });
  it('gates join and message events on the antiraid module', async () => {
    const state = new Map<string, boolean>();
    const modules = new ModuleService({
      getModuleState: async (_guild, key) => state.get(key),
      setModuleState: async (_guild, key, enabled) => { state.set(key, enabled); },
      listModuleStates: async () => [],
    }, [{ key: 'core', defaultEnabled: true }, { key: 'antiraid', defaultEnabled: false }]);
    const handleJoin = vi.fn(async (_input: Record<string, unknown>) => {});
    const handleMessage = vi.fn(async (_input: Record<string, unknown>) => {});
    const services = { modules, antiraid: { handleJoin, handleMessage } } as unknown as Services;
    const joinEvent = antiraidEvents.find(item => item.name === Events.GuildMemberAdd)!;
    const messageEvent = antiraidEvents.find(item => item.name === Events.MessageCreate)!;
    const member = { id: userId, guild: { id: guildId }, user: { createdAt: new Date() }, joinedAt: new Date() };
    const message = { guildId, id: 'm1', channelId: 'c1', createdTimestamp: Date.now(), author: { id: userId, bot: false }, mentions: { users: { size: 0 } } };
    await dispatchEvent(joinEvent, services, member);
    await dispatchEvent(messageEvent, services, message);
    expect(handleJoin).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    await modules.setEnabled(guildId, 'antiraid', true, ownerId);
    await dispatchEvent(joinEvent, services, member);
    await dispatchEvent(messageEvent, services, message);
    expect(handleJoin).toHaveBeenCalledWith(expect.objectContaining({ guildId, userId }));
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({ guildId, userId, messageId: 'm1', mentionCount: 0 }));
    expect(handleMessage.mock.calls[0]?.[0]).not.toHaveProperty('content');
    await dispatchEvent(messageEvent, services, { ...message, author: { id: userId, bot: true } });
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
  it('quarantine failures are reported without throwing', async () => {
    const { service, repository, quarantineForRaid, notify } = fixture();
    await enable(service);
    await service.configure(owner, 'join_threshold', '2');
    quarantineForRaid.mockRejectedValueOnce(new AppError('PERMISSION', 'missing role'));
    await service.handleJoin({ guildId, userId, joinedAt: new Date(), accountCreatedAt: oldAccount() });
    const result = await service.handleJoin({ guildId, userId: '10000000000000001', joinedAt: new Date(Date.now() + 1000), accountCreatedAt: oldAccount() });
    expect(result.burst).toBe(true);
    expect(result.quarantined).toBe(false);
    expect(repository.settings.get(guildId)?.emergencyMode).toBe(true);
    expect(notify).toHaveBeenCalledWith(guildId, 'security', 'Emergency mode activated: join burst', expect.anything());
  });
});
