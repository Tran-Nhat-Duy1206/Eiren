import { describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import { assertAutomationTargets, eligibleAutomationChannels, parseAutomationDraft } from './automation-management.js';

const guildId = '123456789012345678', channelId = '223456789012345678';
const form = (overrides: Record<string, string> = {}) => ({ csrfToken: 'csrf', name: 'Static scheduled notice',
  scheduleKind: 'daily', dailyTime: '09:30', onceAt: '', timezone: 'UTC', cooldownSeconds: '30', enabled: 'false',
  action0Type: 'STATIC_MESSAGE', action0ChannelId: channelId, action0Message: '@everyone <@123456789012345678>',
  action1Type: 'NONE', action1ChannelId: '', action1Message: '', ...overrides });
function fixture(opts: { guildId?: string; channelType?: ChannelType; view?: boolean; send?: boolean } = {}) {
  const channel = { id: channelId, name: '<img src=x onerror=bad()>', guildId: opts.guildId ?? guildId,
    type: opts.channelType ?? ChannelType.GuildText,
    permissionsFor: vi.fn(() => ({ has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel ? opts.view !== false : opts.send !== false })),
    send: vi.fn() };
  const guild = { id: guildId, members: { fetch: vi.fn(async () => ({ id: '323456789012345678' })) },
    channels: { fetch: vi.fn(async (id?: string) => id ? channel : new Map([[channelId, channel]])) } };
  const client = { user: { id: '323456789012345678' }, guilds: { fetch: vi.fn(async () => guild) } } as unknown as Client;
  return { client, guild, channel };
}

describe('bounded Automation dashboard forms and safe channel selection', () => {
  it('parses an exact one-action daily draft without changing administrator text', () => {
    const draft = parseAutomationDraft(form());
    expect(draft.config.enabled).toBe(false);
    expect(draft.config.trigger).toEqual({ id: 'SCHEDULED', version: 1,
      config: { kind: 'daily', time: '09:30', timezone: 'UTC' } });
    expect(draft.config.actions).toEqual([{ id: 'STATIC_MESSAGE', version: 1,
      config: { channelId, message: '@everyone <@123456789012345678>' } }]);
  });
  it('parses one-time UTC and ordered two distinct supported actions', () => {
    const draft = parseAutomationDraft(form({ scheduleKind: 'once', onceAt: '2027-01-01T12:00:00.000Z',
      action1Type: 'STAFF_LOG', action1ChannelId: channelId, action1Message: 'Staff-only static note' }));
    expect(draft.config.trigger.config).toEqual({ kind: 'once', at: '2027-01-01T12:00:00.000Z' });
    expect(draft.config.actions.map(action => action.id)).toEqual(['STATIC_MESSAGE', 'STAFF_LOG']);
  });
  it.each([
    { action0Message: 'x'.repeat(1001) }, { action1Type: 'AI' }, { action1Type: 'STAFF_LOG', action1Message: '' },
    { dailyTime: '24:99' }, { scheduleKind: 'once', onceAt: '2027-01-01T12:00:00+02:00' },
    { action2Type: 'STAFF_LOG' }, { action0ChannelId: 'wrong' }, { enabled: 'on' },
  ])('rejects unbounded, unsupported or malformed form fields %j', overrides => {
    expect(() => parseAutomationDraft(form(overrides as unknown as Record<string, string>))).toThrow();
  });
  it('only lists current sendable same-guild text channels', async () => {
    const f = fixture();
    expect(await eligibleAutomationChannels(f.client, guildId)).toEqual([{ id: channelId, name: f.channel.name }]);
    expect(f.guild.channels.fetch).toHaveBeenCalledWith();
    for (const opts of [{ guildId: '999999999999999999' }, { channelType: ChannelType.GuildVoice },
      { channelType: ChannelType.PublicThread }, { view: false }, { send: false }]) {
      const invalid = fixture(opts);
      expect(await eligibleAutomationChannels(invalid.client, guildId)).toEqual([]);
    }
  });
  it('revalidates every submitted channel through guild-scoped V7.4 preflight without sending', async () => {
    const f = fixture();
    const draft = parseAutomationDraft(form({ action1Type: 'STAFF_LOG', action1ChannelId: channelId, action1Message: 'second' }));
    await assertAutomationTargets(f.client, guildId, draft);
    expect(f.guild.channels.fetch).toHaveBeenCalledTimes(1); // duplicate channel resolved once
    expect(f.channel.send).not.toHaveBeenCalled();
    const foreign = fixture({ guildId: '999999999999999999' });
    await expect(assertAutomationTargets(foreign.client, guildId, draft)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(foreign.channel.send).not.toHaveBeenCalled();
  });
});
