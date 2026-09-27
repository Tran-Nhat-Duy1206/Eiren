import type { Guild } from 'discord.js';

/** An incomplete gateway snapshot must never be used to delete persisted sessions. */
export async function observedHumanVoice(guild: Guild): Promise<{ userId: string; channelId: string }[] | null> {
  // Copy IDs/channels synchronously at the boundary; cache VoiceState objects can change during REST fetches.
  const present = [...guild.voiceStates.cache.values()]
    .map(state => ({ userId: state.id, channelId: state.channelId, member: state.member }))
    .filter((state): state is { userId: string; channelId: string; member: typeof state.member } =>
      state.channelId !== null && state.channelId !== guild.afkChannelId);
  if (present.length > 1000) return null;
  const live: { userId: string; channelId: string }[] = [];
  let fetches = 0;
  for (const state of present) {
    // GuildMembers intent is optional: only targeted REST lookups, never bulk fetch.
    let member = state.member;
    if (!member) {
      if (++fetches > 50) return null;
      try { member = await guild.members.fetch({ user: state.userId, force: true }); }
      catch { return null; }
    }
    if (!member) return null;
    if (!member.user.bot) live.push({ userId: state.userId, channelId: state.channelId });
  }
  return live;
}
