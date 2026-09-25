import { describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { PermissionService, type Actor } from '../../core/permissions/permission-service.js';
import type { Logger } from '../../core/logger/logger.js';
import { ModerationService, type ModerationGateway } from './service.js';
import { DiscordModerationGateway } from './discord-gateway.js';
import { parseDuration, modCommand } from './commands.js';
import type { ModerationCase, ModerationRepository } from './repository.js';

const guildId = '12345678901234567';
const ownerId = '22345678901234567';
const modId = '32345678901234567';
const targetId = '42345678901234567';
const roleId = '52345678901234567';
const owner: Actor = { guildId, guildOwnerId: ownerId, userId: ownerId, roleIds: [] };
const moderator: Actor = { ...owner, userId: modId, roleIds: [roleId] };
function fixture(level = 'MODERATOR') {
  const repository = {
    createCase: vi.fn(async values => ({ ...values, id: 42, status: 'PENDING', createdAt: new Date(), claimedAt: null } as ModerationCase)),
    complete: vi.fn(async (id: number, status: string, metadata: unknown) => ({ id, status, metadata } as ModerationCase)),
    setStatus: vi.fn(async () => {}), getCase: vi.fn(async (): Promise<ModerationCase | undefined> => undefined),
    history: vi.fn(async () => [{ id: 42 }]), notes: vi.fn(async () => [{ content: 'private' }]),
    addNote: vi.fn(async (_guild: string, _target: string, _actor: string, content: string) => ({ id: 1, content })),
    claimDue: vi.fn(async () => [] as ModerationCase[]),
  };
  const permissions = new PermissionService({ getRoleLevels: async (_guild, roles) => roles.length ? [level] : [] });
  const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const notify = vi.fn(async () => {});
  const service = new ModerationService(repository as unknown as ModerationRepository, permissions, logger, notify);
  const gateway: ModerationGateway = { assertCan: vi.fn(async () => {}), apply: vi.fn(async () => ({})), expire: vi.fn(async () => 'EXPIRED' as const) };
  return { service, gateway, repository, notify };
}
function caseRecord(overrides: Partial<ModerationCase> = {}): ModerationCase {
  return { id: 42, guildId, targetId, moderatorId: modId, action: 'TEMPBAN', reason: 'spam', durationSeconds: 3600,
    expiresAt: new Date(Date.now() - 1000), status: 'PROCESSING', createdAt: new Date(), claimedAt: new Date(), metadata: {}, ...overrides };
}

describe('moderation policy and persistence', () => {
  it('enforces bot permission mapping independently of command dispatcher', async () => {
    const { service, gateway, repository } = fixture();
    await expect(service.perform({ actor: { ...moderator, roleIds: [] }, action: 'WARN', targetId, reason: 'spam' }, gateway))
      .rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(service.perform({ actor: moderator, action: 'BAN', targetId, reason: 'spam' }, gateway))
      .rejects.toMatchObject({ code: 'PERMISSION' });
    expect(repository.createCase).not.toHaveBeenCalled();
  });
  it('rejects self/owner actions, invalid durations and invalid purge counts before API', async () => {
    const { service, gateway } = fixture('SENIOR_MODERATOR');
    for (const user of [modId, ownerId]) {
      await expect(service.perform({ actor: moderator, action: 'BAN', targetId: user, reason: 'no' }, gateway)).rejects.toMatchObject({ code: 'PERMISSION' });
    }
    await expect(service.perform({ actor: moderator, action: 'TIMEOUT', targetId, reason: 'no', durationSeconds: 28 * 86400 + 1 }, gateway))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.perform({ actor: moderator, action: 'PURGE', targetId: modId,
      reason: 'cleanup', metadata: { channelId: guildId, count: 101 } }, gateway)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(() => parseDuration('0m')).toThrow();
    expect(() => parseDuration('bad')).toThrow();
    expect(modCommand.data.toJSON().name).toBe('mod');
  });
  it('creates a durable case and status after successful action, without leaking private notes', async () => {
    const { service, gateway, repository, notify } = fixture();
    const record = await service.perform({ actor: moderator, action: 'WARN', targetId, reason: 'spam' }, gateway);
    expect(record.status).toBe('COMPLETED');
    expect(repository.createCase).toHaveBeenCalledWith(expect.objectContaining({ guildId, targetId, moderatorId: modId, action: 'WARN' }));
    expect(repository.complete).toHaveBeenCalledWith(42, 'COMPLETED', {});
    expect(notify).toHaveBeenCalledOnce();
  });
  it('marks failed API actions without recording them as completed', async () => {
    const { service, gateway, repository } = fixture();
    vi.mocked(gateway.apply).mockRejectedValue(new Error('Discord API failure'));
    await expect(service.perform({ actor: moderator, action: 'WARN', targetId, reason: 'spam' }, gateway)).rejects.toThrow('Discord API failure');
    expect(repository.setStatus).toHaveBeenCalledWith(42, 'PENDING', 'FAILED');
    expect(repository.complete).not.toHaveBeenCalled();
  });
  it('retains temporary cases for expiry when Discord API result is ambiguous', async () => {
    const { service, gateway, repository } = fixture('SENIOR_MODERATOR');
    vi.mocked(gateway.apply).mockRejectedValue(new Error('Gateway timeout'));
    await expect(service.perform({ actor: moderator, action: 'TEMPBAN', targetId, reason: 'spam', durationSeconds: 60 }, gateway))
      .rejects.toThrow('Gateway timeout');
    expect(repository.complete).toHaveBeenCalledWith(42, 'ACTIVE', expect.objectContaining({ ambiguousApiResult: true }));
    expect(repository.setStatus).not.toHaveBeenCalledWith(42, 'PENDING', 'FAILED');
  });
  it('protects case lookup/history and private notes for authorized staff only', async () => {
    const { service, repository } = fixture();
    const unprivileged = { ...moderator, roleIds: [] };
    for (const call of [() => service.getCase(unprivileged, 42), () => service.history(unprivileged, targetId),
      () => service.notes(unprivileged, targetId), () => service.addNote(unprivileged, targetId, 'secret')]) {
      await expect(call()).rejects.toMatchObject({ code: 'PERMISSION' });
    }
    expect(await service.history(moderator, targetId)).toHaveLength(1);
    expect((await service.addNote(moderator, targetId, 'private')).content).toBe('private');
    expect(await service.notes(moderator, targetId)).toHaveLength(1);
    expect(repository.getCase).not.toHaveBeenCalled();
    repository.getCase.mockResolvedValueOnce(caseRecord({ action: 'WARN', status: 'COMPLETED' }));
    expect((await service.getCase(moderator, 42)).id).toBe(42);
    expect(repository.getCase).toHaveBeenCalledWith(guildId, 42);
  });
  it('excludes in-flight temporary actions from expiration claims', async () => {
    const { service, gateway, repository } = fixture('SENIOR_MODERATOR');
    let finish!: (value: Record<string, string>) => void;
    vi.mocked(gateway.apply).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = service.perform({ actor: moderator, action: 'TEMPBAN', targetId, reason: 'spam', durationSeconds: 60 }, gateway);
    await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalled());
    await service.expireDue(async () => gateway);
    expect(repository.claimDue).toHaveBeenCalledWith(expect.any(Date), 20, [42]);
    finish({});
    await pending;
  });
  it('idempotently processes claimed expirations and releases failed claims for retry', async () => {
    const { service, repository, gateway } = fixture();
    repository.claimDue.mockResolvedValueOnce([caseRecord()]).mockResolvedValueOnce([]);
    await service.expireDue(async () => gateway);
    expect(gateway.expire).toHaveBeenCalledTimes(1);
    expect(repository.setStatus).toHaveBeenCalledWith(42, 'PROCESSING', 'EXPIRED');
    await service.expireDue(async () => gateway);
    expect(gateway.expire).toHaveBeenCalledTimes(1);
    repository.claimDue.mockResolvedValueOnce([caseRecord()]);
    vi.mocked(gateway.expire).mockRejectedValueOnce(new Error('retry'));
    await service.expireDue(async () => gateway);
    expect(repository.setStatus).toHaveBeenCalledWith(42, 'PROCESSING', 'ACTIVE');
  });
});

describe('Discord hierarchy and expiration safety', () => {
  function guild(actorPosition = 1, targetPosition = 2, botPosition = 3) {
    const roles = (position: number) => ({ highest: { comparePositionTo: () => position } });
    const target = { roles: roles(targetPosition), permissions: { has: () => false }, communicationDisabledUntilTimestamp: null };
    const actor = { roles: roles(actorPosition) };
    const bot = { roles: roles(botPosition), permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.BanMembers } };
    const fetch = vi.fn(async (id: string) => id === targetId ? target : actor);
    const fetchMe = vi.fn(async () => bot);
    const bans = { fetch: vi.fn(async () => ({ reason: '[Eiren case #42] spam' })), remove: vi.fn(async () => {}) };
    const instance = { ownerId, client: { user: { id: '99999999999999999' } }, members: { fetch, fetchMe }, bans };
    return { instance, target, bans };
  }
  it('rejects actor hierarchy and bot hierarchy independently', async () => {
    await expect(new DiscordModerationGateway(guild(-1).instance as never, modId).assertCan('BAN', targetId)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(new DiscordModerationGateway(guild(1, 2, 0).instance as never, modId).assertCan('BAN', targetId)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(new DiscordModerationGateway(guild().instance as never, modId).assertCan('BAN', ownerId)).rejects.toMatchObject({ code: 'PERMISSION' });
  });
  it('validates purge counts and prevents invalid timeout on administrators', async () => {
    const { instance, target } = guild();
    const gateway = new DiscordModerationGateway(instance as never, modId);
    await expect(gateway.apply('PURGE', modId, 'cleanup', 42, undefined,
      { channelId: guildId, count: 101 })).rejects.toMatchObject({ code: 'VALIDATION' });
    target.permissions.has = () => true;
    await expect(gateway.assertCan('TIMEOUT', targetId)).rejects.toMatchObject({ code: 'PERMISSION' });
  });
  it('refuses to replace an existing indefinite ban with a tempban', async () => {
    const { instance, bans } = guild();
    await expect(new DiscordModerationGateway(instance as never, modId).assertCan('TEMPBAN', targetId))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(bans.remove).not.toHaveBeenCalled();
  });
  it('unbans only when the current ban references this case', async () => {
    const { instance, bans } = guild();
    const gateway = new DiscordModerationGateway(instance as never, modId);
    expect(await gateway.expire(caseRecord())).toBe('EXPIRED');
    expect(bans.remove).toHaveBeenCalledOnce();
    bans.fetch.mockResolvedValueOnce({ reason: 'different moderator ban' });
    expect(await gateway.expire(caseRecord())).toBe('SUPERSEDED');
    expect(bans.remove).toHaveBeenCalledOnce();
  });
});
