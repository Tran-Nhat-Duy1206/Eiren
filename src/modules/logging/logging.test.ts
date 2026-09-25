import { describe, expect, it, vi } from 'vitest';
import { Events } from 'discord.js';
import type { Client } from 'discord.js';
import type { GuildConfigService } from '../../services/guild-config-service.js';
import type { Logger } from '../../core/logger/logger.js';
import type { Services } from '../../app/services.js';
import { GuildLogService } from './guild-log-service.js';
import { loggingEvents } from './events.js';

const guild = '12345678901234567';
const author = '22345678901234567';
function fixture() {
  const send = vi.fn(async (_payload: unknown) => {});
  const fetch = vi.fn(async (channelId: string) => ({ guildId: guild, id: channelId, isTextBased: () => true, send }));
  const get = vi.fn(async () => ({ logChannelId: 'general', modLogChannelId: 'moderation', securityLogChannelId: 'security' }));
  const warn = vi.fn();
  const logs = new GuildLogService(
    { channels: { fetch } } as unknown as Client,
    { get } as unknown as GuildConfigService,
    { warn } as unknown as Logger,
  );
  return { logs, send, fetch, get, warn };
}
function event(name: string) {
  const found = loggingEvents.find(item => item.name === name);
  if (!found) throw new Error(`Missing event ${name}`);
  return found;
}

describe('guild log delivery', () => {
  it('routes each category only to its own configured channel and disables mentions', async () => {
    const { logs, fetch, send } = fixture();
    await logs.send(guild, 'general', 'General');
    await logs.send(guild, 'moderation', 'Moderation');
    await logs.send(guild, 'security', 'Security');
    expect(fetch.mock.calls.map(([channelId]) => channelId)).toEqual(['general', 'moderation', 'security']);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ allowedMentions: { parse: [] } });
  });
  it('skips unconfigured channels, ignores wrong-guild channels and absorbs delivery failures', async () => {
    const { logs, get, fetch, send, warn } = fixture();
    get.mockResolvedValueOnce({ logChannelId: 'general', modLogChannelId: 'moderation', securityLogChannelId: null } as never);
    await logs.send(guild, 'security', 'Never sent');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce({ guildId: 'different', isTextBased: () => true, send } as never);
    await logs.send(guild, 'general', 'Wrong guild');
    expect(send).not.toHaveBeenCalled();
    send.mockRejectedValueOnce(new Error('Missing permissions'));
    await expect(logs.send(guild, 'moderation', 'No permissions')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('logging adapters', () => {
  it('exports only dispatcher-gated optional logging events', () => {
    expect(loggingEvents.every(item => item.moduleKey === 'logging')).toBe(true);
    expect(loggingEvents.map(item => item.name)).toContain(Events.GuildMemberUpdate);
    expect(loggingEvents.map(item => item.name)).toContain(Events.VoiceStateUpdate);
  });
  it('logs message edit and delete by identifiers only, never message content', async () => {
    const send = vi.fn(async () => {});
    const services = { guildLogs: { send } } as unknown as Services;
    const before = { guildId: guild, channelId: 'channel', id: 'message', content: 'private before' };
    const after = { ...before, content: 'private after', author: { id: author } };
    await event(Events.MessageUpdate).handle(services, before, after);
    await event(Events.MessageDelete).handle(services, after);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.slice(0, 3)).toEqual([guild, 'general', 'Message edited']);
    expect(send.mock.calls[1]?.slice(0, 3)).toEqual([guild, 'general', 'Message deleted']);
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/private before|private after/);
    expect(JSON.stringify(send.mock.calls)).toContain('message');
    await event(Events.MessageDelete).handle(services, { ...after, guildId: null });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('logs only role or nickname member updates to moderation channel', async () => {
    const send = vi.fn(async () => {});
    const services = { guildLogs: { send } } as unknown as Services;
    const before = { guild: { id: guild }, id: author, nickname: 'old', roles: { cache: new Map([['role1', {}]]) } };
    const after = { guild: { id: guild }, id: author, nickname: 'new', roles: { cache: new Map([['role2', {}]]) } };
    await event(Events.GuildMemberUpdate).handle(services, before, after);
    expect(send).toHaveBeenCalledWith(guild, 'moderation', 'Member updated', expect.arrayContaining([
      { name: 'Role IDs added', value: 'role2' }, { name: 'Role IDs removed', value: 'role1' },
    ]), { targetId: author });
    await event(Events.GuildMemberUpdate).handle(services, after, after);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
