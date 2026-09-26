import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { eligibleMessage, levelForXp, xpForLevel } from './formula.js';
import { LevelsService } from './service.js';
import type { LevelsRepository } from './repository.js';

const prior = { lastMessageId: 'old', lastXpAt: new Date(100_000), lastFingerprint: 'abc' };
describe('levels formula and eligibility', () => {
  it('uses exact, monotonic integer boundaries including safe-XP ceiling', () => {
    expect(levelForXp(0)).toBe(0);
    for (const n of [1, 2, 100, 10000, 9_490_625]) {
      const boundary = xpForLevel(n);
      expect(levelForXp(boundary - 1)).toBe(n - 1);
      expect(levelForXp(boundary)).toBe(n);
    }
    expect(levelForXp(Number.MAX_SAFE_INTEGER)).toBe(9_490_626);
    expect(() => levelForXp(-1)).toThrow();
    expect(() => levelForXp(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it('rejects duplicate ID, old timestamps, cooldown and matching fingerprint', () => {
    expect(eligibleMessage({ messageId: 'old', at: 200_000 }, prior, 60, null)).toBe(false);
    expect(eligibleMessage({ messageId: 'new', at: 159_999 }, prior, 60, null)).toBe(false);
    expect(eligibleMessage({ messageId: 'new', at: 160_000 }, prior, 60, null)).toBe(true);
    expect(eligibleMessage({ messageId: 'new', at: 90_000 }, prior, 60, null)).toBe(false);
    expect(eligibleMessage({ messageId: 'new', at: 160_001 }, prior, 60, 'abc')).toBe(false);
    expect(eligibleMessage({ messageId: 'new', at: 160_001 }, prior, 60, 'different')).toBe(true);
    expect(eligibleMessage({ messageId: 'new', at: 160_001 }, prior, 60, null)).toBe(true);
  });
});
describe('levels service', () => {
  const settings = { guildId: 'g', cooldownSeconds: 60, xpPerMessage: 10, minLength: 12, levelUpChannelId: null };
  it('filters content when present and never passes raw content to storage', async () => {
    const award = vi.fn().mockResolvedValue({ xp: 10, before: 0, after: 0, rewards: [] });
    const repo = { settings: vi.fn().mockResolvedValue(settings), ignored: vi.fn().mockResolvedValue(false), award };
    const svc = new LevelsService(repo as unknown as LevelsRepository, {} as never);
    const base = { guildId: 'g', userId: 'u', channelId: 'c', messageId: 'm', at: 100_000 };
    await svc.handleMessage({ ...base, content: '!command with arguments' });
    await svc.handleMessage({ ...base, content: 'short' });
    expect(award).not.toHaveBeenCalled();
    await svc.handleMessage({ ...base, content: 'A sufficiently long message' });
    expect(award).toHaveBeenCalledTimes(1);
    expect(award.mock.calls[0]?.[0]).not.toHaveProperty('content');
    expect(award.mock.calls[0]?.[0].fingerprint).toMatch(/^[a-f0-9]{24}$/);
    await svc.handleMessage({ ...base, content: '' });
    expect(award.mock.calls[1]?.[0].fingerprint).toBeNull();
  });
  it('rejects unsafe rewards before storage', async () => {
    const addReward = vi.fn();
    const repo = { mappedRole: vi.fn().mockResolvedValue(false), addReward };
    const guild = { id: 'g', roles: { fetch: vi.fn().mockResolvedValue({ id: 'r', managed: true, editable: true, permissions: { any: () => false } }) } };
    const svc = new LevelsService(repo as unknown as LevelsRepository, { guilds: { fetch: async () => guild } } as never);
    await expect(svc.addReward('g', 1, 'r')).rejects.toThrow();
    expect(addReward).not.toHaveBeenCalled();
  });
  it('computes progress against the next level interval, not absolute XP', async () => {
    const repo = { member: vi.fn().mockResolvedValue({ xp: 330, messageCount: 33 }), rank: vi.fn().mockResolvedValue(4) };
    const svc = new LevelsService(repo as unknown as LevelsRepository, {} as never);
    await expect(svc.rank('g', 'u')).resolves.toMatchObject({ level: 1, xp: 330, progress: 230, nextLevelXp: 300, rank: 4 });
    repo.member.mockResolvedValueOnce(undefined);
    await expect(svc.rank('g', 'new')).resolves.toMatchObject({ level: 0, xp: 0, progress: 0, nextLevelXp: 100, rank: null });
  });
  it('validates announcement channel access before persisting configuration', async () => {
    const configure = vi.fn();
    const channel = { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => false }) };
    const guild = { channels: { fetch: vi.fn(async () => channel) }, members: { fetchMe: vi.fn(async () => ({})) } };
    const svc = new LevelsService({ configure } as unknown as LevelsRepository,
      { guilds: { fetch: async () => guild } } as never);
    await expect(svc.configure('g', { levelUpChannelId: 'announcements' })).rejects.toThrow('Bot cannot view or send');
    expect(configure).not.toHaveBeenCalled();
    await svc.configure('g', { levelUpChannelId: null });
    expect(configure).toHaveBeenCalledWith('g', { levelUpChannelId: null });
  });
  it('returns deterministic ordered leaderboard with computed levels', async () => {
    const repo = { top: vi.fn().mockResolvedValue([{ userId: 'a', xp: 400 }, { userId: 'b', xp: 100 }]) };
    const svc = new LevelsService(repo as unknown as LevelsRepository, {} as never);
    expect((await svc.leaderboard('g')).map(row => [row.userId, row.level, row.rank])).toEqual([['a', 2, 1], ['b', 1, 2]]);
    expect(repo.top).toHaveBeenCalledWith('g', 10);
  });
});
