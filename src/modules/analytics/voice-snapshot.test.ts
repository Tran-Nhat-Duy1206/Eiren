import { describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import { observedHumanVoice } from './voice-snapshot.js';

function fixture(states: Array<{ id: string; channelId: string | null; member?: { user: { bot: boolean } } | null }>,
  fetch = vi.fn(async ({ user }: { user: string }) => ({ user: { bot: user === 'bot' } }))) {
  return { guild: { afkChannelId: 'afk', voiceStates: { cache: new Map(states.map(state => [state.id, state])) }, members: { fetch } } as unknown as Guild, fetch };
}
describe('voice snapshot classification without GuildMembers intent', () => {
  it('uses bounded targeted member lookup and excludes bots and AFK', async () => {
    const { guild, fetch } = fixture([
      { id: 'human', channelId: 'voice', member: null },
      { id: 'bot', channelId: 'voice', member: null },
      { id: 'afk-human', channelId: 'afk', member: null },
    ]);
    expect(await observedHumanVoice(guild)).toEqual([{ userId: 'human', channelId: 'voice' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith({ user: 'human', force: true });
  });
  it('fails closed rather than deleting stored sessions when identity cannot be verified', async () => {
    const { guild } = fixture([{ id: 'unknown', channelId: 'voice', member: null }], vi.fn().mockRejectedValue(new Error('no member intent')));
    expect(await observedHumanVoice(guild)).toBeNull();
  });
  it('accepts only observed human voice states and bounds massive snapshots', async () => {
    const { guild, fetch } = fixture([{ id: 'member', channelId: 'voice', member: { user: { bot: false } } }]);
    expect(await observedHumanVoice(guild)).toEqual([{ userId: 'member', channelId: 'voice' }]);
    expect(fetch).not.toHaveBeenCalled();
    const oversized = fixture(Array.from({ length: 1001 }, (_, id) => ({ id: String(id), channelId: 'voice' })));
    expect(await observedHumanVoice(oversized.guild)).toBeNull();
    expect(oversized.fetch).not.toHaveBeenCalled();
    const incomplete = fixture(Array.from({ length: 51 }, (_, id) => ({ id: String(id), channelId: 'voice', member: null })));
    expect(await observedHumanVoice(incomplete.guild)).toBeNull();
    expect(incomplete.fetch).toHaveBeenCalledTimes(50);
  });
});
