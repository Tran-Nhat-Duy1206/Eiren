import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import type { PermissionService } from '../../core/permissions/permission-service.js';
import type { Actor } from '../../core/permissions/permission-service.js';
import type { ReputationRepository } from './repository.js';
import { ReputationService } from './service.js';

const actor: Actor = { guildId: 'guild', userId: 'giver', guildOwnerId: 'owner', roleIds: [] };
function fixture(options: { bot?: boolean; missing?: boolean; age?: number; giverAge?: number } = {}) {
  const grant = vi.fn(async () => 1);
  const configure = vi.fn(async (_guild: string, config: object) => config);
  const repository = { grant, configure, settings: async () => ({ globalCooldownSeconds: 86400, sameTargetCooldownSeconds: 604800 }), score: async () => 0 } as unknown as ReputationRepository;
  const requirePermission = vi.fn(async (_actor: Actor, level: string) => { if (level === 'ADMIN') throw Error('denied'); });
  const permissions = { require: requirePermission } as unknown as PermissionService;
  const fetchMember = vi.fn(async (userId: string) => { if (options.missing) throw Error('unknown member');
    return { user: { bot: userId === 'giver' ? false : options.bot ?? false,
      createdAt: new Date(Date.now() - (userId === 'giver' ? options.giverAge ?? 10000 : options.age ?? 10000) * 1000) } }; });
  const client = { user: { id: 'the-bot' }, guilds: { fetch: async () => ({ members: { fetch: fetchMember } }) } } as unknown as Client;
  return { service: new ReputationService(repository, permissions, client, 3600), grant, configure, fetchMember, requirePermission };
}
describe('reputation authorization and validation', () => {
  it('grants only to existing, human, sufficiently old guild members', async () => {
    const f = fixture();
    await expect(f.service.grant(actor, 'target')).resolves.toBe(1);
    expect(f.fetchMember).toHaveBeenCalledWith('target');
    expect(f.grant).toHaveBeenCalledWith('guild', 'giver', 'target');
    for (const options of [{ bot: true }, { missing: true }, { age: 1 }, { giverAge: 1 }]) {
      const invalid = fixture(options);
      await expect(invalid.service.grant(actor, 'target')).rejects.toThrow();
      expect(invalid.grant).not.toHaveBeenCalled();
    }
  });
  it('rejects self and bot giver before writing', async () => {
    const f = fixture();
    await expect(f.service.grant(actor, 'giver')).rejects.toThrow('yourself');
    await expect(f.service.grant(actor, 'target', true)).rejects.toThrow('Bots');
    expect(f.grant).not.toHaveBeenCalled();
  });
  it('requires ADMIN to inspect and configure, and validates cooldown bounds', async () => {
    const f = fixture();
    await expect(f.service.settings(actor)).rejects.toThrow('denied');
    await expect(f.service.configure(actor, { globalCooldownSeconds: 1, sameTargetCooldownSeconds: 2 })).rejects.toThrow('denied');
    expect(f.configure).not.toHaveBeenCalled();
  });
});
