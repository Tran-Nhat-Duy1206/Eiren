/** Level n begins at 100*n*n total XP. Integer square-root avoids floating point boundary drift. */
export function levelForXp(xp: number): number {
  if (!Number.isSafeInteger(xp) || xp < 0) throw new RangeError('XP must be a nonnegative safe integer.');
  let low = 0, high = Math.min(9_490_626, Math.floor(Math.sqrt(xp / 100)) + 1);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (middle * middle * 100 <= xp) low = middle;
    else high = middle - 1;
  }
  return low;
}
export function xpForLevel(level: number): number {
  if (!Number.isSafeInteger(level) || level < 0 || level > 9_490_626 || level * level * 100 > Number.MAX_SAFE_INTEGER)
    throw new RangeError('Level exceeds safe integer XP range.');
  return level * level * 100;
}
export function progressForXp(xp: number) {
  const level = levelForXp(xp);
  const floor = xpForLevel(level);
  const next = 100 * (level + 1) * (level + 1);
  // A bigint-backed XP aggregate is deliberately capped to JS safe integers. At the terminal
  // representable level, no next reachable threshold exists and UI must not throw.
  return { level, progress: xp - floor, nextLevelXp: Number.isSafeInteger(next) ? next - floor : null };
}
export function eligibleMessage(input: { messageId: string; at: number; content?: string | null },
  prior: { lastMessageId: string | null; lastXpAt: Date | null; lastFingerprint: string | null },
  cooldownSeconds: number, fingerprint: string | null): boolean {
  if (input.messageId === prior.lastMessageId || !Number.isFinite(input.at) || input.at < 0) return false;
  if (prior.lastXpAt && input.at < prior.lastXpAt.getTime() + cooldownSeconds * 1000) return false;
  if (fingerprint && fingerprint === prior.lastFingerprint) return false;
  return true;
}
