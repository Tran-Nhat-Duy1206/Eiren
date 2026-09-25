import { describe, expect, it, vi } from 'vitest';
import { GuildRepository } from './guild-repository.js';
import type { Database } from '../core/database/connection.js';

// Model the on-conflict semantics of the two transactional INSERTs.
describe('guild setup persistence contract', () => {
  it('inserts once and preserves existing configuration across repeated setup', async () => {
    const guildIds = new Set<string>();
    const settings = new Map<string, { guildId: string; language: string; timezone: string }>();
    const insert = vi.fn((table: { _: { name: string } }) => ({
      values: (data: { id?: string; guildId?: string }) => ({
        onConflictDoNothing: async () => {
          if (data.id) guildIds.add(data.id);
          if (data.guildId && !settings.has(data.guildId)) settings.set(data.guildId, { guildId: data.guildId, language: 'en', timezone: 'UTC' });
        },
      }),
    }));
    const tx = {
      insert,
      select: () => ({ from: () => ({ where: async () => [settings.get('22345678901234567')] }) }),
    };
    const db = { transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) };
    const repository = new GuildRepository(db as unknown as Database);
    const first = await repository.setup('22345678901234567');
    expect(first.language).toBe('en');
    settings.set(first.guildId, { ...first, timezone: 'Asia/Tokyo' });
    const second = await repository.setup('22345678901234567');
    expect(second.timezone).toBe('Asia/Tokyo');
    expect(guildIds.size).toBe(1);
    expect(settings.size).toBe(1);
    expect(insert).toHaveBeenCalledTimes(4);
  });
});
