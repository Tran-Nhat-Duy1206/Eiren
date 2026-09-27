import { describe, expect, it, vi } from 'vitest';
import { Events } from 'discord.js';
import type { Services } from '../../app/services.js';
import { analyticsEvents } from './events.js';
import { dispatchEvent } from '../../core/events/event.js';

const messageEvent = analyticsEvents.find(event => event.name === Events.MessageCreate)!;
const voiceEvent = analyticsEvents.find(event => event.name === Events.VoiceStateUpdate)!;
const joinEvent = analyticsEvents.find(event => event.name === Events.GuildMemberAdd)!;
const leaveEvent = analyticsEvents.find(event => event.name === Events.GuildMemberRemove)!;
function fixture() {
  const recordMessage = vi.fn(); const recordVoice = vi.fn(); const recordMember = vi.fn();
  const reserveVoiceObservation = vi.fn(async (guildId: string, userId: string, observedAt: Date) =>
    ({ guildId, userId, observedAt, epoch: 1, sequence: 1 }));
  const finalizeVoiceObservation = vi.fn(async () => true);
  return { services: { analytics: { recordMessage, recordVoice, recordMember, reserveVoiceObservation,
    finalizeVoiceObservation } } as unknown as Services,
  recordMessage, recordVoice, recordMember, reserveVoiceObservation, finalizeVoiceObservation };
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
    const { services, recordVoice, reserveVoiceObservation, finalizeVoiceObservation } = fixture();
    const before = { guild, id: 'bot', member: null, channelId: null };
    const after = { ...before, channelId: 'voice' };
    await voiceEvent.handle(services, before, after);
    expect(recordVoice).not.toHaveBeenCalled();
    expect(finalizeVoiceObservation).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'bot' }), null);
    await voiceEvent.handle(services, { ...before, id: 'human' }, { ...after, id: 'human' });
    expect(reserveVoiceObservation).toHaveBeenLastCalledWith('123', 'human', expect.any(Date));
    expect(finalizeVoiceObservation).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'human' }), 'voice');
    await voiceEvent.handle(services, { ...after, id: 'human' }, { ...after, id: 'human' });
    expect(reserveVoiceObservation).toHaveBeenCalledTimes(2);
    await voiceEvent.handle(services, { ...after, id: 'human' }, { ...after, id: 'human', channelId: 'afk' });
    expect(finalizeVoiceObservation).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'human' }), null);
  });
  it('fences unclassified gateway updates without crediting an unverified participant', async () => {
    const { services, recordVoice, reserveVoiceObservation, finalizeVoiceObservation } = fixture();
    const unavailable = { ...guild, members: { fetch: vi.fn().mockRejectedValue(new Error('member unavailable')) } };
    await voiceEvent.handle(services, { guild: unavailable, id: 'unknown', member: null, channelId: 'A' },
      { guild: unavailable, id: 'unknown', member: null, channelId: 'B' });
    expect(reserveVoiceObservation).toHaveBeenCalledWith('123', 'unknown', expect.any(Date));
    expect(finalizeVoiceObservation).toHaveBeenCalledWith(expect.objectContaining({ userId: 'unknown' }), null);
    expect(recordVoice).not.toHaveBeenCalled();
  });
  it('dispatches voice reservation before the generic asynchronous module lookup', async () => {
    const { services, reserveVoiceObservation } = fixture();
    const isEnabled = vi.fn(async () => false);
    const dispatched = { ...services, modules: { isEnabled } } as unknown as Services;
    const before = { guild, id: 'human', member: { user: { bot: false } }, channelId: 'A' };
    await dispatchEvent(voiceEvent, dispatched, before, { ...before, channelId: null });
    expect(isEnabled).not.toHaveBeenCalled();
    expect(reserveVoiceObservation).toHaveBeenCalledWith('123', 'human', expect.any(Date));
  });
  it('durably reserves ingress before a deferred targeted member lookup finishes', async () => {
    const { services, reserveVoiceObservation, finalizeVoiceObservation } = fixture();
    let resolveMember!: (value: { user: { bot: boolean } }) => void;
    let signalLookup!: () => void;
    const lookupStarted = new Promise<void>(resolve => { signalLookup = resolve; });
    const slowGuild = { ...guild, members: { fetch: vi.fn(() => {
      signalLookup();
      return new Promise<{ user: { bot: boolean } }>(resolve => { resolveMember = resolve; });
    }) } };
    const before = { guild: slowGuild, id: 'human', member: null, channelId: 'A' };
    const pending = voiceEvent.handle(services, before, { ...before, channelId: null });
    await lookupStarted;
    expect(reserveVoiceObservation).toHaveBeenCalledWith('123', 'human', expect.any(Date));
    expect(finalizeVoiceObservation).not.toHaveBeenCalled();
    resolveMember({ user: { bot: false } });
    await pending;
    expect(finalizeVoiceObservation).toHaveBeenCalledWith(expect.objectContaining({ userId: 'human' }), null);
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
