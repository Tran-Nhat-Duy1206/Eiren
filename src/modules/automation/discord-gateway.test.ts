import { describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import { createAutomationDiscordGateway } from './discord-gateway.js';

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const messageId = '323456789012345678';
function fixture(options: { guildId?: string; type?: ChannelType; view?: boolean; send?: boolean; result?: unknown } = {}) {
  const send = vi.fn().mockResolvedValue(options.result ?? { id: messageId });
  const permissionsFor = vi.fn().mockReturnValue({ has: (permission: bigint) =>
    permission === PermissionFlagsBits.ViewChannel ? options.view !== false : options.send !== false });
  const channel = { guildId: options.guildId ?? guildId, type: options.type ?? ChannelType.GuildText, permissionsFor, send };
  const fetchChannel = vi.fn().mockResolvedValue(channel);
  const fetchMember = vi.fn().mockResolvedValue({ id: '423456789012345678' });
  const fetchGuild = vi.fn().mockResolvedValue({ id: guildId, channels: { fetch: fetchChannel }, members: { fetch: fetchMember } });
  const client = { user: { id: '423456789012345678' }, guilds: { fetch: fetchGuild } } as unknown as Client;
  return { gateway: createAutomationDiscordGateway(client), fetchGuild, fetchChannel, fetchMember, permissionsFor, send };
}
describe('guild-scoped Discord automation gateway', () => {
  it('fetches fresh guild/channel/member and sends exactly one restricted message', async () => {
    const f = fixture();
    const ready = await f.gateway.preflight(guildId, channelId);
    expect(f.fetchGuild).toHaveBeenCalledWith({ guild: guildId, force: true });
    expect(f.fetchChannel).toHaveBeenCalledWith(channelId, { force: true });
    expect(f.fetchMember).toHaveBeenCalledWith({ user: '423456789012345678', force: true });
    expect(ready.kind).toBe('READY');
    const mentionShaped = '@everyone <@123456789012345678> <@&123456789012345678>';
    if (ready.kind === 'READY') expect(await ready.send(mentionShaped)).toBe(messageId);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ content: mentionShaped, allowedMentions: { parse: [] } });
  });
  it('blocks wrong guild and unsupported channel kinds before fetching member', async () => {
    for (const opts of [{ guildId: '999999999999999999' }, ...[
      ChannelType.DM, ChannelType.GuildVoice, ChannelType.PublicThread, ChannelType.GuildForum,
    ].map(type => ({ type }))]) {
      const f = fixture(opts);
      expect((await f.gateway.preflight(guildId, channelId)).kind).toBe('BLOCKED');
      expect(f.fetchMember).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    }
  });
  it('blocks a missing channel before any bot lookup or message send', async () => {
    const f = fixture();
    f.fetchChannel.mockResolvedValueOnce(null);
    expect(await f.gateway.preflight(guildId, channelId)).toEqual({ kind: 'BLOCKED', code: 'CHANNEL_NOT_FOUND' });
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('blocks absent view or send permission', async () => {
    for (const options of [{ view: false }, { send: false }]) {
      const f = fixture(options);
      expect((await f.gateway.preflight(guildId, channelId)).kind).toBe('BLOCKED');
      expect(f.send).not.toHaveBeenCalled();
    }
  });
  it('treats malformed send result as ambiguous and propagates delivery failures', async () => {
    const f = fixture({ result: { id: 'bad' } });
    const ready = await f.gateway.preflight(guildId, channelId);
    if (ready.kind !== 'READY') throw new Error('Expected ready');
    await expect(ready.send('text')).rejects.toThrow('Ambiguous');
    f.send.mockRejectedValueOnce(new Error('transient'));
    await expect(ready.send('text')).rejects.toThrow('transient');
  });
  it('propagates transient preflight failures', async () => {
    const f = fixture();
    f.fetchChannel.mockRejectedValueOnce(new Error('network'));
    await expect(f.gateway.preflight(guildId, channelId)).rejects.toThrow('network');
  });
});
