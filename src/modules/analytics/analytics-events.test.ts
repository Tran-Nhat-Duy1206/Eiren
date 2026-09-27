import { describe, expect, it, vi } from 'vitest';
import { Events } from 'discord.js';
import type { Services } from '../../app/services.js';
import { analyticsEvents } from './events.js';

const messageEvent = analyticsEvents.find(event => event.name === Events.MessageCreate)!;
const voiceEvent = analyticsEvents.find(event => event.name === Events.VoiceStateUpdate)!;
const joinEvent = analyticsEvents.find(event => event.name === Events.GuildMemberAdd)!;
const leaveEvent = analyticsEvents.find(event => event.name === Events.GuildMemberRemove)!;
function fixture() {
  const recordMessage = vi.fn(); const recordVoice = vi.fn(); const recordMember = vi.fn(); const fenceUnknownVoice = vi.fn();
  return { services: { analytics: { recordMessage, recordVoice, recordMember, fenceUnknownVoice } } as unknown as Services,
    recordMessage, recordVoice, recordMember, fenceUnknownVoice };
}
const guild = { id: '123', afkChannelId: 'afk', members: { fetch: vi.fn(async ({ user }: { user: string }) => ({ user: { bot: user === 'bot' } })) } };
describe('analytics gateway metadata filters', () => {
  it('records only human metadata with a stable message ID; never reads message content', async () => {
    const { services, recordMessage } = fixture();
    const message = { guildId: '123', id: '456', channelId: '789', createdAt: new Date('2026-01-01T00:00:00Z'), author: { bot: false }, system: false, webhookId: null };
    await messageEvent.handle(services, { ...message, content: '<private>' });
    expect(recordMessage).toHaveBeenCalledWith('123', '456', '789', message.createdAt, false, false, false);
    for (const changes of [{ author: { bot: true } }, { system: true }, { webhookId: 'hook' }])
      await messageEvent.handle(services, { ...message, ...changes });
    expect(recordMessage).toHaveBeenCalledTimes(1);
  });
  it('ignores bots, duplicate channel updates and AFK; classifies uncached members by targeted fetch', async () => {
    const { services, recordVoice } = fixture();
    const before = { guild, id: 'bot', member: null, channelId: null };
    const after = { ...before, channelId: 'voice' };
    await voiceEvent.handle(services, before, after);
    expect(recordVoice).not.toHaveBeenCalled();
    await voiceEvent.handle(services, { ...before, id: 'human' }, { ...after, id: 'human' });
    expect(recordVoice).toHaveBeenCalledWith('123', 'human', 'voice', expect.any(Date));
    await voiceEvent.handle(services, { ...after, id: 'human' }, { ...after, id: 'human' });
    expect(recordVoice).toHaveBeenCalledTimes(1);
    await voiceEvent.handle(services, { ...after, id: 'human' }, { ...after, id: 'human', channelId: 'afk' });
    expect(recordVoice).toHaveBeenLastCalledWith('123', 'human', null, expect.any(Date));
  });
  it('fences unclassified gateway updates without crediting an unverified participant', async () => {
    const { services, recordVoice, fenceUnknownVoice } = fixture();
    const unavailable = { ...guild, members: { fetch: vi.fn().mockRejectedValue(new Error('member unavailable')) } };
    await voiceEvent.handle(services, { guild: unavailable, id: 'unknown', member: null, channelId: 'A' },
      { guild: unavailable, id: 'unknown', member: null, channelId: 'B' });
    expect(fenceUnknownVoice).toHaveBeenCalledWith('123', 'unknown', expect.any(Date));
    expect(recordVoice).not.toHaveBeenCalled();
  });
  it('observes member transitions only for real users when gateway intent is available', async () => {
    const { services, recordMember } = fixture();
    const member = { guild, id: 'human', user: { bot: false } };
    await joinEvent.handle(services, member);
    await leaveEvent.handle(services, member);
    await joinEvent.handle(services, { ...member, user: { bot: true } });
    expect(recordMember).toHaveBeenCalledTimes(2);
    expect(recordMember).toHaveBeenNthCalledWith(1, '123', 'human', true, expect.any(Date));
    expect(recordMember).toHaveBeenNthCalledWith(2, '123', 'human', false, expect.any(Date));
  });
});
