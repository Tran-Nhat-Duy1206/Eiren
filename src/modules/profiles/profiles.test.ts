import { describe, expect, it, vi } from 'vitest';
import { ProfileService } from './service.js';

const guild = 'guild'; const user = 'member';
describe('read-only member profiles', () => {
  it('combines only enabled social modules without storing another copy', async () => {
    const modules = { isEnabled: vi.fn(async (_guild: string, key: string) => key === 'levels' || key === 'reputation') };
    const rank = vi.fn(async () => ({ xp: 330, level: 1, progress: 230, nextLevelXp: 300, rank: 4, messageCount: 33 }));
    const score = vi.fn(async () => 5);
    const service = new ProfileService(modules as never, rank, score);
    expect(await service.get(guild, user)).toEqual({ guildId: guild, userId: user, levels: await rank(), reputation: 5 });
    expect(rank).toHaveBeenCalledWith(guild, user);
    expect(score).toHaveBeenCalledWith(guild, user);
  });
  it('omits disabled source modules and does not query their private data', async () => {
    const rank = vi.fn(); const score = vi.fn();
    const service = new ProfileService({ isEnabled: vi.fn(async () => false) } as never, rank, score);
    expect(await service.get(guild, user)).toEqual({ guildId: guild, userId: user });
    expect(rank).not.toHaveBeenCalled(); expect(score).not.toHaveBeenCalled();
  });
  it('keeps the profile available when levels are disabled but reputation is enabled', async () => {
    const rank = vi.fn();
    const service = new ProfileService({ isEnabled: vi.fn(async (_guild: string, key: string) => key === 'reputation') } as never,
      rank, async () => 3);
    expect(await service.get(guild, user)).toMatchObject({ reputation: 3 });
    expect(rank).not.toHaveBeenCalled();
  });
});
