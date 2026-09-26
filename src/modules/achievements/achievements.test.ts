import { describe, expect, it, vi } from 'vitest';
import { ACHIEVEMENTS, ACHIEVEMENTS_VERSION } from './registry.js';
import { AchievementsService } from './service.js';
import type { AchievementRepository } from './repository.js';

function fixture(enabled: string[] = ['achievements', 'levels', 'reputation', 'events', 'giveaways']) {
  const records = new Map<string, Date>();
  const repo = {
    award: vi.fn(async (_g: string, _u: string, id: string) => {
      if (records.has(id)) return false;
      records.set(id, new Date('2025-01-01T00:00:00Z')); return true;
    }),
    list: vi.fn(async () => [...records].map(([achievementId, awardedAt]) => ({ guildId: 'g', userId: 'u', achievementId, awardedAt }))),
  };
  const modules = { isEnabled: vi.fn(async (_g: string, key: string) => enabled.includes(key)) };
  return { records, repo, modules, service: new AchievementsService(repo as unknown as AchievementRepository, modules) };
}

describe('achievements', () => {
  it('has immutable stable versioned public registry', () => {
    expect(ACHIEVEMENTS_VERSION).toBe(1);
    expect(new Set(ACHIEVEMENTS.map(a => a.id)).size).toBe(9);
    expect(ACHIEVEMENTS.every(a => a.name && a.description && a.category)).toBe(true);
  });
  it('awards thresholds only when reached; repeated and concurrent awards are idempotent', async () => {
    const { service, records } = fixture();
    expect(await service.onLevel('g', 'u', 0, 0)).toEqual([]);
    expect(await service.onLevel('g', 'u', 4, 99)).toEqual(['first-message']);
    const [first, second] = await Promise.all([service.onLevel('g', 'u', 10, 100), service.onLevel('g', 'u', 10, 100)]);
    expect([...first, ...second].sort()).toEqual(['level-10', 'level-5', 'messages-100']);
    expect(records.size).toBe(4);
    expect(await service.onReputation('g', 'u', 0)).toEqual([]);
    expect(await service.onReputation('g', 'u', 10)).toEqual(['reputation-1', 'reputation-10']);
  });
  it('retroactively checks only enabled durable sources for the requested member', async () => {
    const { repo, modules } = fixture(['achievements', 'levels', 'events']);
    const level = { member: vi.fn(async () => ({ guildId: 'g', userId: 'u', xp: 10000, messageCount: 101,
      lastXpAt: null, lastMessageId: null, lastFingerprint: null, createdAt: new Date(), updatedAt: new Date() })) };
    const reputation = { score: vi.fn(async () => 15) };
    const eventJoin = vi.fn(async () => true), eventAttend = vi.fn(async () => false), giveawayWin = vi.fn(async () => true);
    const service = new AchievementsService(repo as unknown as AchievementRepository, modules,
      { level, reputation, eventJoin, eventAttend, giveawayWin });
    const rows = await service.evaluateMember('g', 'u');
    expect(rows.map(row => row.id)).toEqual(['first-message', 'messages-100', 'level-5', 'level-10', 'event-rsvp-1']);
    expect(level.member).toHaveBeenCalledWith('g', 'u');
    expect(reputation.score).not.toHaveBeenCalled();
    expect(giveawayWin).not.toHaveBeenCalled();
  });
  it('suppresses hook writes and prior awards for disabled sources', async () => {
    const { records, repo, modules, service } = fixture(['achievements']);
    records.set('reputation-1', new Date());
    expect(await service.onReputation('g', 'u', 10)).toEqual([]);
    expect(await service.onEventAttend('g', 'u')).toEqual([]);
    expect(await service.onGiveawayWin('g', 'u')).toEqual([]);
    expect(repo.award).not.toHaveBeenCalled();
    expect(await service.evaluateMember('g', 'u')).toEqual([]);
    expect(modules.isEnabled).toHaveBeenCalledWith('g', 'achievements');
  });
});
