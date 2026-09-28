import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { DashboardAccess } from './dashboard-access.js';
import { PermissionService } from '../../core/permissions/permission-service.js';

const USER = '111111111111111111';
const GUILD = '222222222222222222';
const OTHER = '333333333333333333';
const OWNER = '444444444444444444';
const ROLE = '555555555555555555';

function setup(options: { botAbsent?: boolean; memberAbsent?: boolean; owner?: string; mapped?: boolean } = {}) {
  let roles = [ROLE];
  const memberFetch = vi.fn(async () => {
    if (options.memberAbsent) throw new Error('Unknown Member');
    return { id: USER, guild: { id: GUILD }, roles: { cache: new Map(roles.map(id => [id, { id }])) }, permissions: { has: () => true } };
  });
  const guild = { id: GUILD, name: 'Test', ownerId: options.owner ?? OWNER, memberCount: 4,
    members: { fetch: memberFetch }, roles: { fetch: vi.fn(async () => new Map()) } };
  const guildFetch = vi.fn(async () => {
    if (options.botAbsent) throw new Error('Unknown Guild');
    return guild;
  });
  const repository = { getRoleLevels: vi.fn(async (_guildId: string, ids: string[]) => options.mapped && ids.includes(ROLE) ? ['HELPER'] : []) };
  const permissions = new PermissionService(repository as never);
  const service = new DashboardAccess({ guilds: { fetch: guildFetch } } as unknown as Client, permissions);
  const session = { userId: USER, oauthGuildIds: [GUILD] };
  return { service, session, guildFetch, memberFetch, repository, setRoles: (next: string[]) => { roles = next; } };
}

describe('DashboardAccess', () => {
  it('rejects IDOR before querying Discord', async () => {
    const { service, session, guildFetch } = setup({ mapped: true });
    await expect(service.authorize(OTHER, session, 'HELPER')).rejects.toMatchObject({ code: 'PERMISSION' });
    expect(guildFetch).not.toHaveBeenCalled();
  });
  it('denies absent bot and absent current member', async () => {
    for (const options of [{ botAbsent: true }, { memberAbsent: true }]) {
      const { service, session } = setup({ ...options, mapped: true });
      await expect(service.authorize(GUILD, session, 'HELPER')).rejects.toMatchObject({ code: 'PERMISSION' });
      expect(await service.listAccessible(session)).toEqual([]);
    }
  });
  it('ignores Discord Administrator when there is no internal mapping', async () => {
    const { service, session } = setup();
    await expect(service.authorize(GUILD, session, 'HELPER')).rejects.toMatchObject({ code: 'PERMISSION' });
  });
  it('rechecks targeted current member roles after role changes', async () => {
    const { service, session, memberFetch, setRoles } = setup({ mapped: true });
    await expect(service.authorize(GUILD, session, 'HELPER')).resolves.toMatchObject({ roleIds: [ROLE] });
    setRoles([]);
    await expect(service.authorize(GUILD, session, 'HELPER')).rejects.toMatchObject({ code: 'PERMISSION' });
    expect(memberFetch).toHaveBeenCalledTimes(2);
    expect(memberFetch).toHaveBeenCalledWith({ user: USER, force: true });
  });
  it('recognizes actual guild owner through internal permission resolver', async () => {
    const { service, session } = setup({ owner: USER });
    await expect(service.authorize(GUILD, session, 'GUILD_OWNER')).resolves.toMatchObject({ guildOwnerId: USER });
    await expect(service.listAccessible(session)).resolves.toEqual([{ id: GUILD, name: 'Test', owner: USER, memberCount: 4 }]);
  });
  it('bounds OAuth discovery and fails closed when role retrieval fails', async () => {
    const { service, session, guildFetch } = setup({ mapped: true });
    await expect(service.listAccessible({ ...session, oauthGuildIds: Array(201).fill(GUILD) })).resolves.toEqual([]);
    expect(guildFetch).not.toHaveBeenCalled();
    const guild = await guildFetch();
    guild.roles.fetch.mockRejectedValueOnce(new Error('no roles'));
    await expect(service.authorize(GUILD, session, 'HELPER')).rejects.toMatchObject({ code: 'PERMISSION' });
  });
});
