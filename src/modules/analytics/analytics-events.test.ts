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
  const reserveIngestion = vi.fn(async (guildId: string): Promise<{ guildId: string; epoch: number } | null> =>
    ({ guildId, epoch: 7 }));
  return { services: { analytics: { recordMessage, recordVoice, recordMember, reserveVoiceObservation,
    finalizeVoiceObservation, reserveIngestion } } as unknown as Services,
  recordMessage, recordVoice, recordMember, reserveVoiceObservation, finalizeVoiceObservation, reserveIngestion };
}
const guild = { id: '123', afkChannelId: 'afk', members: { fetch: vi.fn(async ({ user }: { user: string }) => ({ user: { bot: user === 'bot' } })) } };
describe('analytics gateway metadata filters', () => {
  it('records only human metadata with a stable message ID; never reads message content', async () => {
    const { services, recordMessage } = fixture();
    const message = { guildId: '123', id: '456', channelId: '789', createdAt: new Date('2026-01-01T00:00:00Z'), author: { bot: false }, system: false, webhookId: null };
    await messageEvent.handle(services, { ...message, content: '<private>' });
    expect(recordMessage).toHaveBeenCalledWith({ guildId: '123', epoch: 7 }, '456', '789', message.createdAt,
      false, false, false);
    for (const changes of [{ author: { bot: true } }, { system: true }, { webhookId: 'hook' }])
      await messageEvent.handle(services, { ...message, ...changes });
    expect(recordMessage).toHaveBeenCalledTimes(1);
  });
  it('reserves message and member ingress before any generic async module precheck', async () => {
    const { services, reserveIngestion, recordMessage, recordMember } = fixture();
    const isEnabled = vi.fn(async () => false);
    const dispatched = { ...services, modules: { isEnabled }, logger: { error: vi.fn() } } as unknown as Services;
    const message = { guildId: '123', id: 'early', channelId: 'channel', createdAt: new Date(),
      author: { bot: false }, system: false, webhookId: null };
    await dispatchEvent(messageEvent, dispatched, message);
    const member = { guild, id: 'human', user: { bot: false } };
    await dispatchEvent(joinEvent, dispatched, member);
    await dispatchEvent(leaveEvent, dispatched, member);
    expect(isEnabled).not.toHaveBeenCalled();
    expect(reserveIngestion).toHaveBeenCalledTimes(3);
    expect(recordMessage).toHaveBeenCalledWith({ guildId: '123', epoch: 7 }, 'early', 'channel', message.createdAt,
      false, false, false);
    expect(recordMember).toHaveBeenCalledWith({ guildId: '123', epoch: 7 }, 'human', true, expect.any(Date));
    expect(recordMember).toHaveBeenLastCalledWith({ guildId: '123', epoch: 7 }, 'human', false, expect.any(Date));
  });
  it('drops message and member telemetry when the ingress reservation is disabled', async () => {
    const { services, reserveIngestion, recordMessage, recordMember } = fixture();
    reserveIngestion.mockResolvedValue(null);
    const payload = { guildId: '123', id: 'excluded', channelId: 'channel', createdAt: new Date(),
      author: { bot: false }, system: false, webhookId: null };
    await dispatchEvent(messageEvent, services, payload);
    await dispatchEvent(joinEvent, services, { guild, id: 'human', user: { bot: false } });
    expect(recordMessage).not.toHaveBeenCalled();
    expect(recordMember).not.toHaveBeenCalled();
  });
  it('keeps the same message/member epoch when final persistence resumes after a toggle', async () => {
    for (const [event, payload] of [
      [messageEvent, { guildId: '123', id: 'delayed', channelId: 'channel', createdAt: new Date(),
        author: { bot: false }, system: false, webhookId: null }],
      [joinEvent, { guild, id: 'human', user: { bot: false } }],
      [leaveEvent, { guild, id: 'human', user: { bot: false } }],
    ] as const) {
      let reachedWriter!: () => void;
      let release!: () => void;
      let currentEpoch = 7;
      const writerStarted = new Promise<void>(resolve => { reachedWriter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const attempts: boolean[] = [];
      const writer = vi.fn(async (token: { epoch: number }) => {
        reachedWriter();
        await gate;
        attempts.push(token.epoch === currentEpoch);
      });
      const { services, reserveIngestion } = fixture();
      const dispatched = { ...services, analytics: { ...services.analytics, recordMessage: writer, recordMember: writer },
        logger: { error: vi.fn() } } as unknown as Services;
      const pending = dispatchEvent(event, dispatched, payload);
      await writerStarted;
      currentEpoch = 9; // disable/re-enable between ingress and final persistence
      release();
      await pending;
      expect(reserveIngestion).toHaveBeenCalledExactlyOnceWith('123');
      expect(writer.mock.calls[0]?.[0]).toEqual({ guildId: '123', epoch: 7 });
      expect(attempts).toEqual([false]);
    }
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
    expect(recordMember).toHaveBeenNthCalledWith(1, { guildId: '123', epoch: 7 }, 'human', true, expect.any(Date));
    expect(recordMember).toHaveBeenNthCalledWith(2, { guildId: '123', epoch: 7 }, 'human', false, expect.any(Date));
  });
});
