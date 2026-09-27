import { describe, expect, it, vi } from 'vitest';
import { hourStart, voiceSlices, type AnalyticsRepository } from './repository.js';
import { AnalyticsService } from './service.js';
import type { PermissionService } from '../../core/permissions/permission-service.js';
import { ModuleService } from '../../services/module-service.js';

const at = new Date('2025-01-01T00:59:58.000Z');
describe('analytics UTC allocation and privacy boundaries', () => {
  it('allocates voice across hours without counting overlapping milliseconds', () => {
    expect(voiceSlices(at, new Date('2025-01-01T01:00:03.000Z'))).toEqual([
      { bucketStart: new Date('2025-01-01T00:00:00.000Z'), seconds: 2 },
      { bucketStart: new Date('2025-01-01T01:00:00.000Z'), seconds: 3 },
    ]);
    expect(voiceSlices(at, at)).toEqual([]);
    expect(hourStart(at).toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });
  it('rejects excluded messages and invalid command duration before persistence', async () => {
    const repository = { message: vi.fn(), command: vi.fn() } as unknown as AnalyticsRepository;
    const service = new AnalyticsService(repository, {} as PermissionService, {} as ModuleService);
    expect(await service.recordMessage('g', 'm', 'c', at, true)).toBe(false);
    expect(await service.recordMessage('g', 'm', 'c', at, false, true)).toBe(false);
    expect(await service.recordMessage('g', 'm', 'c', at, false, false, true)).toBe(false);
    expect(repository.message).not.toHaveBeenCalled();
    await expect(service.recordCommand('g', 'i', 'ping', false, -1, at)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(repository.command).not.toHaveBeenCalled();
  });
  it('does not collect any gateway or command events when module is disabled', async () => {
    const repository = { message: vi.fn(), member: vi.fn(), voice: vi.fn(), command: vi.fn() } as unknown as AnalyticsRepository;
    const modules = { isEnabled: vi.fn(async () => false) } as unknown as ModuleService;
    const service = new AnalyticsService(repository, {} as PermissionService, modules);
    const now = new Date();
    expect(await service.recordMessage('g', 'm', 'c', now)).toBe(false);
    expect(await service.recordMember('g', 'u', true, now)).toBe(false);
    expect(await service.recordVoice('g', 'u', 'c', now)).toBe(false);
    expect(await service.recordCommand('g', 'i', 'ping', true, 23, now)).toBe(false);
    for (const method of ['message', 'member', 'voice', 'command'] as const) expect(repository[method]).not.toHaveBeenCalled();
  });
  it('never credits a persisted pre-restart voice session before a fresh guild baseline', async () => {
    const voice = vi.fn(async () => true);
    const baselineVoice = vi.fn(async () => true);
    const reconcileVoice = vi.fn(async () => 1);
    const modules = { isEnabled: vi.fn(async () => true) } as unknown as ModuleService;
    const service = new AnalyticsService({ voice, baselineVoice, reconcileVoice } as unknown as AnalyticsRepository, {} as PermissionService, modules);
    const now = new Date();
    expect(await service.recordVoice('guild', 'human', 'B', now)).toBe(true);
    expect(baselineVoice).toHaveBeenCalledWith('guild', 'human', 'B', now);
    expect(voice).not.toHaveBeenCalled();
    await service.reconcileVoice('guild', [{ userId: 'human', channelId: 'B' }], now);
    expect(await service.recordVoice('guild', 'human', 'B', new Date(now.getTime() + 1000))).toBe(true);
    expect(voice).toHaveBeenCalledTimes(1);
  });
  it('reconciles and heartbeats only enabled guilds with exact live snapshots', async () => {
    const reconcileVoice = vi.fn().mockResolvedValue(1);
    const heartbeat = vi.fn().mockResolvedValue(1);
    const repository = { reconcileVoice, heartbeat } as unknown as AnalyticsRepository;
    const modules = { isEnabled: vi.fn(async (guild: string) => guild === 'enabled') } as unknown as ModuleService;
    const service = new AnalyticsService(repository, {} as PermissionService, modules);
    const live = [{ userId: 'human', channelId: 'voice' }] as const;
    const now = new Date('2025-01-01T01:00:03.000Z');
    expect(await service.reconcileVoice('disabled', live, now)).toBe(0);
    expect(await service.heartbeat('disabled', live, now, 5)).toBe(0);
    expect(reconcileVoice).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(await service.reconcileVoice('enabled', live, now)).toBe(1);
    expect(await service.heartbeat('enabled', live, now, 5)).toBe(1);
    expect(reconcileVoice).toHaveBeenCalledExactlyOnceWith('enabled', live, now, now, 0);
    expect(heartbeat).toHaveBeenCalledExactlyOnceWith('enabled', live, now, 5, now, now, 0);
  });
  it('defers readiness after failed or incomplete recovery and retries without charging stale time', async () => {
    const baselineVoice = vi.fn(async () => true);
    const voice = vi.fn(async () => true);
    const reconcileVoice = vi.fn().mockRejectedValueOnce(new Error('incomplete snapshot')).mockResolvedValueOnce(1);
    const service = new AnalyticsService({ baselineVoice, voice, reconcileVoice } as unknown as AnalyticsRepository,
      {} as PermissionService, { isEnabled: vi.fn(async () => true) } as unknown as ModuleService);
    const at = new Date();
    await expect(service.reconcileVoice('guild', [{ userId: 'human', channelId: 'A' }], at)).rejects.toThrow('incomplete snapshot');
    expect(service.isVoiceReady('guild')).toBe(false);
    await service.recordVoice('guild', 'human', 'B', new Date(at.getTime() + 1000));
    expect(baselineVoice).toHaveBeenCalledTimes(1);
    expect(voice).not.toHaveBeenCalled();
    await service.reconcileVoice('guild', [{ userId: 'human', channelId: 'B' }], new Date(at.getTime() + 2000));
    expect(service.isVoiceReady('guild')).toBe(true);
  });
  it('invalidates voice readiness across generic, slash and dashboard module toggles', async () => {
    let enabled = true;
    const modules = new ModuleService({ getModuleState: vi.fn(async () => enabled),
      setModuleState: vi.fn(async (_guild, _key, value: boolean) => { enabled = value; }),
      listModuleStates: vi.fn(async () => []) } as never,
    [{ key: 'core', defaultEnabled: true }, { key: 'analytics', defaultEnabled: false }]);
    const repository = { reconcileVoice: vi.fn(async () => 1), baselineVoice: vi.fn(async () => true),
      voice: vi.fn(async () => true) } as unknown as AnalyticsRepository;
    const service = new AnalyticsService(repository, {} as PermissionService, modules);
    const at = new Date();
    await service.reconcileVoice('guild', [{ userId: 'human', channelId: 'A' }], at);
    expect(service.isVoiceReady('guild')).toBe(true);
    await modules.setEnabled('guild', 'analytics', false, 'actor');
    expect(service.isVoiceReady('guild')).toBe(false);
    await modules.setEnabled('guild', 'analytics', true, 'actor');
    expect(await service.recordVoice('guild', 'human', 'A', new Date(at.getTime() + 1000))).toBe(true);
    expect(repository.baselineVoice).toHaveBeenCalledTimes(1);
    expect(repository.voice).not.toHaveBeenCalled();
    await service.reconcileVoice('guild', [{ userId: 'human', channelId: 'A' }], new Date(at.getTime() + 2000));
    expect(service.isVoiceReady('guild')).toBe(true);
  });
  it('validates range and timezone before querying and preserves guild scope and UTC boundaries', async () => {
    const summary = vi.fn().mockResolvedValue({ guildId: 'guild-a', trend: [], localDays: [], details: {} });
    const service = new AnalyticsService({ summary } as unknown as AnalyticsRepository, {} as PermissionService, {} as ModuleService);
    const now = new Date('2025-03-09T08:30:00.000Z');
    await expect(service.summary('guild-a', 'bad' as never, 'UTC', now)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.summary('guild-a', 'toString' as never, 'UTC', now)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.summary('guild-a', '7d', 'Invalid/Zone', now)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(summary).not.toHaveBeenCalled();
    expect(await service.summary('guild-a', '24h', 'America/Los_Angeles', now)).toMatchObject({ guildId: 'guild-a', timezone: 'America/Los_Angeles', localDays: [], details: {} });
    expect(summary).toHaveBeenCalledExactlyOnceWith('guild-a', '24h', now, 'America/Los_Angeles');
    await service.summary('guild-b', '90d', 'UTC', now);
    expect(summary).toHaveBeenLastCalledWith('guild-b', '90d', now, 'UTC');
  });
  it('requires internal roles for config and summaries', async () => {
    const permissions = { require: vi.fn().mockRejectedValue(new Error('denied')) } as unknown as PermissionService;
    const repository = { configure: vi.fn(), summary: vi.fn() } as unknown as AnalyticsRepository;
    const service = new AnalyticsService(repository, permissions, {} as ModuleService);
    const actor = { userId: 'u', guildId: 'g', guildOwnerId: 'owner', roleIds: [] };
    await expect(service.configure(actor, 30)).rejects.toThrow('denied');
    await expect(service.summaryFor(actor, '24h')).rejects.toThrow('denied');
    expect(permissions.require).toHaveBeenCalledWith(actor, 'ADMIN');
    expect(permissions.require).toHaveBeenCalledWith(actor, 'HELPER');
    expect(repository.configure).not.toHaveBeenCalled();
  });
});
