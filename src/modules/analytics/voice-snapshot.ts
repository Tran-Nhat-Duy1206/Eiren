import type { Guild } from 'discord.js';

/** An incomplete gateway snapshot must never be used to delete persisted sessions. */
export async function observedHumanVoice(guild: Guild): Promise<{ userId: string; channelId: string }[] | null> {
  const present = [...guild.voiceStates.cache.values()].filter(state => state.channelId && state.channelId !== guild.afkChannelId);
  if (present.length > 1000) return null;
  const live: { userId: string; channelId: string }[] = [];
  let fetches = 0;
  for (const state of present) {
    // GuildMembers intent is optional: only targeted REST lookups, never bulk fetch.
    let member = state.member;
    if (!member) {
      if (++fetches > 50) return null;
      try { member = await guild.members.fetch({ user: state.id, force: true }); }
      catch { return null; }
    }
    if (!member) return null;
    if (!member.user.bot) live.push({ userId: state.id, channelId: state.channelId! });
  }
  return live;
}
