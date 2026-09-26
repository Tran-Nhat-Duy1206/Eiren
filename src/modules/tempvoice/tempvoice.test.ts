import { describe, expect, it, vi } from 'vitest';
import { ChannelType, DiscordAPIError, PermissionFlagsBits } from 'discord.js';
import { DiscordTempvoiceGateway } from './discord-gateway.js';
import { AppError } from '../../core/errors/errors.js';
import { EMPTY_GRACE_MS, TempvoiceService, roomLimit, roomName } from './service.js';

const actor = { userId: '123456789012345678', guildId: '123456789012345679', guildOwnerId: '123456789012345678', roleIds: [] };
const lobby = '123456789012345670';
const channel = '123456789012345671';
function fixture() {
  const room = { id: 1, guildId: actor.guildId, ownerId: actor.userId, channelId: channel, status: 'ACTIVE', emptySince: new Date(0), createdAt: new Date(0), updatedAt: new Date(0) };
  const repo = { settings: vi.fn().mockResolvedValue({ enabled: true, lobbyChannelId: lobby, categoryId: '123456789012345672', userLimit: 0, defaultPrivate: true }), reserve: vi.fn().mockResolvedValue({ row: room, created: false }), markEmpty: vi.fn(), attach: vi.fn(), rejoin: vi.fn(async (_guild, _owner, _channel, callback) => { await callback(); return true; }), byChannel: vi.fn().mockResolvedValue(room), withActive: vi.fn(async (_guild, _channel, owner, callback) => { if (owner !== room.ownerId) throw new AppError('PERMISSION', 'Not owner'); return callback(room); }), pending: vi.fn().mockResolvedValue([room]), outstanding: vi.fn().mockResolvedValue([]), outstandingDue: vi.fn().mockResolvedValue([]), deferUnresolved: vi.fn(), activate: vi.fn(), close: vi.fn(), transfer: vi.fn(async (_guild, _channel, _owner, _target, apply) => { await apply(room); return room; }), cleanup: vi.fn(async (_id, eligible, remove) => { if (eligible(room)) return remove(room); return false; }) };
  const gateway = { inChannel: vi.fn().mockResolvedValue(true), exists: vi.fn().mockResolvedValue(true), occupants: vi.fn().mockResolvedValue([]), move: vi.fn(), delete: vi.fn(), rename: vi.fn(), limit: vi.fn(), lock: vi.fn(), kick: vi.fn(), access: vi.fn(), transfer: vi.fn().mockResolvedValue(vi.fn()), member: vi.fn().mockResolvedValue(true), humanMember: vi.fn().mockResolvedValue(true), seal: vi.fn().mockResolvedValue(vi.fn()), findReservation: vi.fn().mockResolvedValue([]), validate: vi.fn(), create: vi.fn(), };
  const service = new TempvoiceService(repo as never, { require: vi.fn() } as never, { error: vi.fn() } as never, async () => gateway as never);
  return { service, repo, gateway, room };
}
describe('temporary voice invariants', () => {
  it('rejects invalid names and limits before Discord writes', () => {
    expect(() => roomName(' '.repeat(4))).toThrow(AppError);
    expect(() => roomName('x'.repeat(101))).toThrow(AppError);
    expect(() => roomLimit(-1)).toThrow(AppError);
    expect(() => roomLimit(100)).toThrow(AppError);
    expect(roomLimit(0)).toBe(0);
  });
  it('does not duplicate a reservation on a repeated lobby join', async () => {
    const { service, repo, gateway } = fixture();
    await service.joinedLobby(actor.guildId, actor.userId, lobby);
    expect(repo.reserve).toHaveBeenCalledOnce();
    expect(gateway.move).toHaveBeenCalledWith(actor.userId, channel);
  });
  it('rejects control from anyone except the owner', async () => {
    const { service, gateway } = fixture();
    await expect(service.control({ ...actor, userId: '123456789012345673' }, channel, 'rename', 'new')).rejects.toThrow(AppError);
    expect(gateway.rename).not.toHaveBeenCalled();
  });
  it('routes owner room controls with validated arguments', async () => {
    const { service, gateway } = fixture();
    const target = '123456789012345673';
    await service.control(actor, channel, 'rename', '  Community  ');
    await service.control(actor, channel, 'limit', 99);
    await service.control(actor, channel, 'lock');
    await service.control(actor, channel, 'unlock');
    await service.control(actor, channel, 'allow', target);
    await service.control(actor, channel, 'deny', target);
    await service.control(actor, channel, 'kick', target);
    await service.control(actor, channel, 'status');
    expect(gateway.rename).toHaveBeenCalledWith(channel, 'Community');
    expect(gateway.limit).toHaveBeenCalledWith(channel, 99);
    expect(gateway.lock.mock.calls).toEqual([[channel, true], [channel, false]]);
    expect(gateway.access.mock.calls).toEqual([[channel, target, true], [channel, target, false]]);
    expect(gateway.kick).toHaveBeenCalledWith(channel, target);
    await expect(service.control(actor, channel, 'limit', -1)).rejects.toThrow(AppError);
    await expect(service.control(actor, channel, 'rename', ' ')).rejects.toThrow(AppError);
    expect(gateway.limit).toHaveBeenCalledTimes(1);
  });
  it('rejects self, guild, guild owner, malformed and bot targets for sensitive controls', async () => {
    const { service, gateway } = fixture();
    for (const id of [actor.userId, actor.guildId, actor.guildOwnerId, 'invalid']) {
      await expect(service.control(actor, channel, 'deny', id)).rejects.toThrow(AppError);
      await expect(service.control(actor, channel, 'kick', id)).rejects.toThrow(AppError);
    }
    gateway.humanMember.mockResolvedValue(false);
    await expect(service.control(actor, channel, 'kick', '123456789012345673')).rejects.toThrow(AppError);
    expect(gateway.access).not.toHaveBeenCalled(); expect(gateway.kick).not.toHaveBeenCalled();
  });
  it('rechecks both members after locking transfer row and rejects departed targets', async () => {
    const { service, repo, gateway } = fixture();
    const target = '123456789012345673';
    gateway.inChannel.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(service.control(actor, channel, 'transfer', target)).rejects.toThrow('Both members');
    expect(repo.transfer).toHaveBeenCalledOnce(); expect(gateway.transfer).not.toHaveBeenCalled();
  });
  it('transfers only when both occupants remain and blocks nonowner transfer', async () => {
    const { service, gateway, repo } = fixture();
    const target = '123456789012345673';
    await service.control(actor, channel, 'transfer', target);
    expect(gateway.transfer).toHaveBeenCalledWith(channel, actor.userId, target);
    repo.transfer.mockRejectedValueOnce(new AppError('PERMISSION', 'Not owner'));
    await expect(service.control({ ...actor, userId: target }, channel, 'transfer', '123456789012345674')).rejects.toThrow(AppError);
  });
  it('closes mapped room on external deletion and clears empty marker on rejoin', async () => {
    const { service, repo, gateway, room } = fixture();
    await service.channelDeleted(actor.guildId, channel);
    expect(repo.close).toHaveBeenCalledWith(room.id);
    await service.joinedLobby(actor.guildId, actor.userId, lobby);
    expect(repo.rejoin).toHaveBeenCalledWith(actor.guildId, actor.userId, channel, expect.any(Function));
    expect(gateway.move).toHaveBeenCalledWith(actor.userId, channel);
  });
  it('rechecks occupants during due cleanup before deleting', async () => {
    const { service, gateway } = fixture();
    gateway.occupants.mockResolvedValueOnce([actor.userId]);
    await service.runDue(new Date(EMPTY_GRACE_MS + 1));
    expect(gateway.delete).not.toHaveBeenCalled();
  });
  it('rejects bot targets even when they occupy a room', async () => {
    const { service, gateway } = fixture();
    gateway.humanMember.mockResolvedValue(false);
    await expect(service.control(actor, channel, 'transfer', '123456789012345673')).rejects.toThrow(AppError);
    await expect(service.control(actor, channel, 'allow', '123456789012345673')).rejects.toThrow(AppError);
  });
  it('recovers a channel created before reservation attachment using its marker', async () => {
    const { service, repo, gateway, room } = fixture();
    room.status = 'CREATING'; room.channelId = null as never;
    repo.outstandingDue.mockResolvedValue([room]); repo.pending.mockResolvedValue([]);
    gateway.findReservation.mockResolvedValue([channel]); repo.attach = vi.fn().mockResolvedValue({ ...room, channelId: channel });
    await service.runDue(new Date(EMPTY_GRACE_MS + 1));
    expect(repo.attach).toHaveBeenCalledWith(room.id, channel);
    expect(gateway.findReservation).toHaveBeenCalledWith(room.id, room.ownerId);
  });
  it('retains unresolved CREATING reservation after category reconfiguration or unknown create outcome', async () => {
    const { service, repo, gateway, room } = fixture();
    room.status = 'CREATING'; room.channelId = null as never;
    repo.outstandingDue.mockResolvedValue([room]); repo.pending.mockResolvedValue([]);
    repo.settings.mockResolvedValue({ categoryId: 'different-category' });
    gateway.findReservation.mockResolvedValue([]);
    await service.runDue(new Date(EMPTY_GRACE_MS + 1));
    expect(gateway.findReservation).toHaveBeenCalledWith(room.id, room.ownerId);
    expect(repo.attach).not.toHaveBeenCalled();
    expect(repo.cleanup).not.toHaveBeenCalled();
    expect(repo.close).not.toHaveBeenCalled();
    expect(repo.deferUnresolved).toHaveBeenCalledWith(room.id, new Date(EMPTY_GRACE_MS + 1));
  });
  it('bounds each due tick and leaves unresolved reservations queued behind older work', async () => {
    const { service, repo, room } = fixture();
    repo.pending.mockResolvedValue([]);
    repo.outstandingDue.mockResolvedValue([room]);
    await service.runDue(new Date(EMPTY_GRACE_MS + 1));
    expect(repo.pending).toHaveBeenCalledWith(new Date(EMPTY_GRACE_MS + 1), EMPTY_GRACE_MS);
    expect(repo.outstandingDue).toHaveBeenCalledWith(new Date(EMPTY_GRACE_MS + 1), EMPTY_GRACE_MS);
    expect(repo.outstanding).not.toHaveBeenCalled();
  });
  it('releases a reservation on definitive Discord create rejection but retains ambiguous failures', async () => {
    const { service, repo, gateway, room } = fixture();
    repo.reserve.mockResolvedValue({ row: { ...room, status: 'CREATING', channelId: null }, created: true });
    const denied = new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'POST', '/guilds/1/channels', {});
    gateway.create.mockRejectedValueOnce(denied).mockRejectedValueOnce(new Error('transport timed out'));
    await expect(service.joinedLobby(actor.guildId, actor.userId, lobby)).rejects.toBe(denied);
    expect(repo.close).toHaveBeenCalledWith(room.id);
    repo.close.mockClear();
    await expect(service.joinedLobby(actor.guildId, actor.userId, lobby)).rejects.toThrow('transport timed out');
    expect(repo.close).not.toHaveBeenCalled();
  });
  it('releases a reservation when pre-create validation fails', async () => {
    const { service, repo, gateway, room } = fixture();
    repo.reserve.mockResolvedValue({ row: { ...room, status: 'CREATING', channelId: null }, created: true });
    gateway.validate.mockRejectedValue(new AppError('PERMISSION', 'Missing bot permissions'));
    await expect(service.joinedLobby(actor.guildId, actor.userId, lobby)).rejects.toThrow('Missing bot permissions');
    expect(repo.close).toHaveBeenCalledWith(room.id);
    expect(gateway.create).not.toHaveBeenCalled();
  });
  it('retains a room when activation fails after the owner has moved', async () => {
    const { service, repo, gateway, room } = fixture();
    repo.reserve.mockResolvedValue({ row: { ...room, status: 'CREATING', channelId: null }, created: true });
    gateway.validate = vi.fn(); gateway.create = vi.fn().mockResolvedValue(channel);
    repo.attach.mockResolvedValue({ ...room, status: 'CREATING' });
    repo.activate = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce(room);
    await expect(service.joinedLobby(actor.guildId, actor.userId, lobby)).rejects.toThrow('database unavailable');
    expect(gateway.delete).not.toHaveBeenCalled();
    expect(repo.activate).toHaveBeenCalledTimes(2);
  });
  it('treats Discord unknown-channel 10003 as absent for exists and idempotent delete', async () => {
    const notFound = new DiscordAPIError({ code: 10003, message: 'Unknown Channel' }, 10003, 404, 'GET', '/channels/1', {});
    const guild = { id: actor.guildId, channels: { fetch: vi.fn().mockRejectedValue(notFound) } };
    const discord = new DiscordTempvoiceGateway(guild as never);
    expect(await discord.exists(channel)).toBe(false);
    await expect(discord.delete(channel)).resolves.toBeUndefined();
    await expect(discord.occupants(channel)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('counts human voice states without bulk member fetching, ignoring bots', async () => {
    const human = '123456789012345673';
    const bot = '123456789012345674';
    const fetch = vi.fn();
    const guild = { id: actor.guildId, available: true, client: { isReady: () => true },
      channels: { fetch: vi.fn().mockResolvedValue({ guildId: actor.guildId, type: ChannelType.GuildVoice }) },
      voiceStates: { cache: new Map([[human, { id: human, channelId: channel, member: { user: { bot: false } } }],
        [bot, { id: bot, channelId: channel, member: { user: { bot: true } } }],
        [actor.userId, { id: actor.userId, channelId: lobby, member: { user: { bot: false } } }]]) },
      members: { cache: new Map(), fetch } };
    expect(await new DiscordTempvoiceGateway(guild as never).occupants(channel)).toEqual([human]);
    expect(fetch).not.toHaveBeenCalled();
    guild.voiceStates.cache.set(human, { id: human, channelId: lobby, member: { user: { bot: false } } });
    expect(await new DiscordTempvoiceGateway(guild as never).occupants(channel)).toEqual([]);
  });
  it('fetches only missing occupant identities and fails closed on errors or startup gaps', async () => {
    const unknown = '123456789012345673';
    const fetch = vi.fn().mockResolvedValue({ user: { bot: false } });
    const guild = { id: actor.guildId, available: true, client: { isReady: () => true },
      channels: { fetch: vi.fn().mockResolvedValue({ guildId: actor.guildId, type: ChannelType.GuildVoice }) },
      voiceStates: { cache: new Map([[unknown, { id: unknown, channelId: channel, member: null }]]) },
      members: { cache: new Map(), fetch } };
    const gateway = new DiscordTempvoiceGateway(guild as never);
    expect(await gateway.occupants(channel)).toEqual([unknown]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(unknown);
    fetch.mockRejectedValueOnce(new Error('Discord member API unavailable'));
    await expect(gateway.occupants(channel)).rejects.toThrow('Discord member API unavailable');
    fetch.mockResolvedValueOnce(null);
    await expect(gateway.occupants(channel)).rejects.toMatchObject({ code: 'CONFLICT' });
    guild.client.isReady = () => false;
    await expect(gateway.occupants(channel)).rejects.toMatchObject({ code: 'CONFLICT' });
    guild.client.isReady = () => true;
    guild.available = false;
    await expect(gateway.occupants(channel)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('locks and unlocks Connect without exposing private ViewChannel', async () => {
    const edit = vi.fn();
    const voice = { guildId: actor.guildId, type: ChannelType.GuildVoice, permissionOverwrites: { edit } };
    const guild = { id: actor.guildId, channels: { fetch: vi.fn().mockResolvedValue(voice) } };
    const discord = new DiscordTempvoiceGateway(guild as never);
    await discord.lock(channel, true); await discord.lock(channel, false);
    expect(edit.mock.calls).toEqual([[actor.guildId, { Connect: false }], [actor.guildId, { Connect: true }]]);
    expect(edit.mock.calls.some(([, permissions]) => 'ViewChannel' in permissions)).toBe(false);
  });
  it('refuses reservation recovery from unrelated channel without marker and owner/bot permission evidence', async () => {
    const permissions = new Map([[actor.userId, { allow: { has: (bit: bigint) => bit === PermissionFlagsBits.Connect } }],
      ['bot', { allow: { has: (bit: bigint) => bit === PermissionFlagsBits.ManageChannels } }]]);
    const voice = { id: channel, guildId: actor.guildId, type: ChannelType.GuildVoice, parentId: 'category', name: 'temp-1-room', permissionOverwrites: { cache: permissions } };
    const guild = { id: actor.guildId, client: { user: { id: 'bot' } }, channels: { fetch: vi.fn().mockResolvedValue(new Map([[channel, voice]])) } };
    const discord = new DiscordTempvoiceGateway(guild as never);
    expect(await discord.findReservation(1, actor.userId)).toEqual([channel]);
    voice.parentId = 'changed-category'; expect(await discord.findReservation(1, actor.userId)).toEqual([channel]);
    voice.name = 'other-name'; expect(await discord.findReservation(1, actor.userId)).toEqual([]);
    voice.name = 'temp-1-room'; permissions.delete('bot'); expect(await discord.findReservation(1, actor.userId)).toEqual([]);
    permissions.set('bot', { allow: { has: () => false } }); expect(await discord.findReservation(1, actor.userId)).toEqual([]);
  });
  it('deletes empty due rooms after grace', async () => {
    const { service, gateway } = fixture();
    await service.runDue(new Date(EMPTY_GRACE_MS + 1));
    expect(gateway.delete).toHaveBeenCalledWith(channel);
  });
});
