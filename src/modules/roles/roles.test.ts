import { describe, expect, it, vi } from 'vitest';
import { BUTTON_PREFIX, SELECT_PREFIX, RoleMenuService, panel, parsePanelId } from './service.js';
import { AppError } from '../../core/errors/errors.js';
import type { RoleMenuRepository } from './repository.js';
import { PermissionFlagsBits, type Client } from 'discord.js';
import type { GuildLogNotifier } from '../../services/log-notifier.js';

const menu = { id: 12, guildId: 'guild', name: 'Team', kind: 'BUTTON', exclusive: false, maxValues: 2, enabled: true, channelId: 'channel', messageId: 'message' } as Parameters<typeof panel>[0];
const options = [1, 2, 3].map(id => ({ id, roleId: String(id), label: `Role ${id}`, position: id, requiredRoleId: id === 2 ? 'required' : null, forbiddenRoleId: id === 2 ? 'forbidden' : null })) as Parameters<typeof panel>[1];
function fixture(held: string[] = [], overrides: { exclusive?: boolean; maxValues?: number; kind?: 'BUTTON' | 'SELECT'; mapped?: boolean; dangerous?: boolean; notify?: GuildLogNotifier } = {}) {
  const roles = new Set(held);
  const add = vi.fn(async (id: string) => { roles.add(id); });
  const remove = vi.fn(async (id: string) => { roles.delete(id); });
  const member = { roles: { cache: { has: (id: string) => roles.has(id), keys: () => roles.values() }, add, remove } };
  const guild = { id: 'guild', members: { fetch: vi.fn(async () => member) }, roles: { fetch: vi.fn(async (id: string) => ({ id, managed: false, editable: true, permissions: { any: (bits: bigint) => !!overrides.dangerous && id === '1' && (bits & PermissionFlagsBits.ManageRoles) !== 0n } })) } };
  const repository = { get: vi.fn(async () => ({ ...menu, kind: overrides.kind ?? 'BUTTON', exclusive: overrides.exclusive ?? false, maxValues: overrides.maxValues ?? 2 })), options: vi.fn(async () => options), isPermissionRole: vi.fn(async (_guild: string, id: string) => !!overrides.mapped && id === '1'), locked: async (_guild: string, _menu: number, _user: string, fn: () => Promise<unknown>) => fn() };
  const service = new RoleMenuService(repository as unknown as RoleMenuRepository, { guilds: { fetch: async () => guild } } as unknown as Client, overrides.notify);
  const click = (ids: number[], kind: 'BUTTON' | 'SELECT' = 'BUTTON', action?: 'add' | 'remove') => service.interact('guild', 12, 'user', 'channel', 'message', kind, ids, action);
  return { click, roles, add, remove };
}
describe('role menu stable controls', () => {
  it('parses only canonical positive safe integer IDs and explicit actions', () => {
    expect(parsePanelId(`${BUTTON_PREFIX}12:3:remove`, BUTTON_PREFIX)).toEqual({ menuId: 12, optionId: 3, action: 'remove' });
    expect(parsePanelId(`${SELECT_PREFIX}12`, SELECT_PREFIX)).toEqual({ menuId: 12, optionId: undefined });
    for (const invalid of [`${BUTTON_PREFIX}12:0:add`, `${BUTTON_PREFIX}12:03:add`, `${BUTTON_PREFIX}12:3`, `${BUTTON_PREFIX}12:3:toggle`, `${BUTTON_PREFIX}9007199254740992:1:add`])
      expect(() => parsePanelId(invalid, BUTTON_PREFIX)).toThrow(AppError);
  });
  it('limits select maximum and groups 24 explicit buttons within five Discord rows', () => {
    const select = panel({ ...menu, kind: 'SELECT' }, options);
    expect(select.components[0]!.toJSON().components[0]).toMatchObject({ min_values: 0, max_values: 2 });
    const buttons = panel(menu, Array.from({ length: 12 }, (_, index) => ({ ...options[0]!, id: index + 1 })));
    expect(buttons.components).toHaveLength(5);
    expect(buttons.components.reduce((count, row) => count + row.toJSON().components.length, 0)).toBe(24);
    expect(() => panel(menu, Array.from({ length: 13 }, (_, index) => ({ ...options[0]!, id: index + 1 })))).toThrow(AppError);
  });
  it('replays assign and remove without toggling, even when required role is lost', async () => {
    const f = fixture(['2']);
    await f.click([2], 'BUTTON', 'remove'); await f.click([2], 'BUTTON', 'remove');
    expect(f.remove).toHaveBeenCalledTimes(1);
    await f.click([1], 'BUTTON', 'add'); await f.click([1], 'BUTTON', 'add');
    expect(f.add).toHaveBeenCalledTimes(1);
  });
  it('allows empty select to remove every menu role, and repeated removal is idempotent', async () => {
    const f = fixture(['1', '2'], { kind: 'SELECT' });
    await expect(f.click([], 'SELECT')).resolves.toEqual({ added: 0, removed: 2 });
    await expect(f.click([], 'SELECT')).resolves.toEqual({ added: 0, removed: 0 });
    expect(f.remove).toHaveBeenCalledTimes(2);
    await expect(fixture().click([], 'BUTTON', 'remove')).rejects.toThrow('Invalid role selection');
  });
  it('enforces exclusive and maximum, checking restrictions only for new grants', async () => {
    const exclusive = fixture(['1'], { exclusive: true, maxValues: 1 });
    await expect(exclusive.click([2], 'BUTTON', 'add')).rejects.toThrow('required role');
    expect(exclusive.roles.has('1')).toBe(true);
    const f = fixture(['1'], { maxValues: 1 });
    await expect(f.click([3], 'BUTTON', 'add')).rejects.toThrow('Too many roles');
    const valid = fixture(['1', 'required'], { exclusive: true, maxValues: 1 });
    await valid.click([2], 'BUTTON', 'add');
    expect([...valid.roles]).toEqual(['required', '2']);
    await valid.click([2], 'BUTTON', 'add'); expect(valid.add).toHaveBeenCalledTimes(1);
    await expect(fixture(['forbidden', 'required']).click([2], 'BUTTON', 'add')).rejects.toThrow('prevents');
  });
  it('rejects and security-logs dangerous and internally mapped roles before mutation', async () => {
    for (const overrides of [{ dangerous: true }, { mapped: true }]) {
      const notify = vi.fn(async (_guild: string, _category: string, _title: string, _fields: readonly { name: string; value: string }[]) => { throw Error('logging unavailable'); });
      const f = fixture([], { ...overrides, notify: notify as GuildLogNotifier });
      await expect(f.click([1], 'BUTTON', 'add')).rejects.toThrow('dangerous');
      expect(f.add).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith('guild', 'security', 'Unsafe role menu assignment rejected', [{ name: 'Role ID', value: '1' }]);
    }
  });
  it('refuses published panel changes that would desynchronize select labels or maximum, while allowing enable', async () => {
    const update = vi.fn(async (_guild: string, _id: number, patch: object) => ({ ...menu, ...patch }));
    const notify = vi.fn(async (_guildId: string, _category: 'general', _title: string) => { throw Error('logs unavailable'); });
    const service = new RoleMenuService({ lockMenu: async (_guild: string, _id: number, work: (tx: never, current: Parameters<typeof panel>[0]) => Promise<unknown>) => work({} as never, { ...menu, kind: 'SELECT' }), update,
      create: async (data: object) => ({ ...menu, ...data }) } as unknown as RoleMenuRepository, {} as Client, notify as GuildLogNotifier);
    await expect(service.edit('guild', 12, { name: 'Other' })).rejects.toThrow('Published panel settings');
    await expect(service.edit('guild', 12, { maxValues: 1 })).rejects.toThrow('Published panel settings');
    await expect(service.edit('guild', 12, { exclusive: true, maxValues: 1 })).rejects.toThrow('Published panel settings');
    expect(update).not.toHaveBeenCalled();
    await expect(service.edit('guild', 12, { enabled: false })).resolves.toMatchObject({ enabled: false });
    await expect(service.create('guild', 'actor', 'Fresh', 'SELECT', false, 2)).resolves.toMatchObject({ name: 'Fresh' });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map(call => call[2])).toEqual(['Role menu edited', 'Role menu created']);
  });
  it('enforces button and select label boundaries before insertion and on legacy rendering', async () => {
    for (const kind of ['BUTTON', 'SELECT'] as const) {
      const limit = kind === 'BUTTON' ? 78 : 80;
      const insert = vi.fn(async () => options[0]);
      const repo = { lockMenu: async (_guild: string, _id: number, work: (tx: never, current: Parameters<typeof panel>[0]) => Promise<unknown>) => work({} as never, { ...menu, kind, messageId: null }),
        options: async () => [], isPermissionRole: async () => false, addOption: insert };
      const guild = { id: 'guild', roles: { fetch: async (id: string) => ({ id, managed: false, editable: true, permissions: { any: () => false } }) } };
      const service = new RoleMenuService(repo as unknown as RoleMenuRepository, { guilds: { fetch: async () => guild } } as unknown as Client);
      await expect(service.addOption('guild', 12, '1', 'x'.repeat(limit), null, null, null)).resolves.toBeDefined();
      expect(insert).toHaveBeenCalledTimes(1);
      for (const length of [79, 80].filter(value => value > limit))
        await expect(service.addOption('guild', 12, '1', 'x'.repeat(length), null, null, null)).rejects.toThrow('Option label exceeds');
      expect(() => panel({ ...menu, kind }, [{ ...options[0]!, label: 'x'.repeat(limit + 1) }])).toThrow('Option label exceeds');
    }
  });
  it('serializes concurrent publish and cleans up sent messages after rollback', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    let association: string | null = null;
    let queue = Promise.resolve();
    const sent = { id: 'posted', delete: vi.fn(async () => {}) };
    const send = vi.fn(async () => { entered(); await held; return sent; });
    const repository = { lockMenu: (_guild: string, _id: number, work: (tx: object, current: Parameters<typeof panel>[0]) => Promise<unknown>) => {
      const pending = queue.then(() => work({}, { ...menu, messageId: association }));
      queue = pending.then(() => {}, () => {});
      return pending;
    }, options: vi.fn(async () => options), isPermissionRole: vi.fn(async () => false),
    update: vi.fn(async (_guild: string, _id: number, patch: { messageId: string }) => { association = patch.messageId; return { ...menu, ...patch }; }) };
    const channel = { type: 0, permissionsFor: () => ({ has: () => true }), send };
    const guild = { id: 'guild', channels: { fetch: async () => channel }, members: { fetchMe: async () => ({}) },
      roles: { fetch: async (id: string) => ({ id, managed: false, editable: true, permissions: { any: () => false } }) } };
    const service = new RoleMenuService(repository as unknown as RoleMenuRepository, { guilds: { fetch: async () => guild } } as unknown as Client);
    const winner = service.publish('guild', 12, 'channel');
    await firstEntered;
    const loser = service.publish('guild', 12, 'channel');
    release();
    await expect(winner).resolves.toBe(sent);
    await expect(loser).rejects.toThrow('already published');
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent.delete).not.toHaveBeenCalled();
    association = null;
    repository.update.mockRejectedValueOnce(Error('commit failed'));
    await expect(service.publish('guild', 12, 'channel')).rejects.toThrow('commit failed');
    expect(sent.delete).toHaveBeenCalledTimes(1);
  });
  it('never fails successful mutation when optional notifier fails', async () => {
    const f = fixture([], { notify: async () => { throw Error('logging offline'); } });
    await expect(f.click([1], 'BUTTON', 'add')).resolves.toEqual({ added: 1, removed: 0 });
  });
});
