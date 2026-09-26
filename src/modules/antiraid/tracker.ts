/**
 * In-memory message activity counters. Metadata only (counts and timestamps) is kept;
 * message content is never read, stored, or logged.
 */
export class MessageActivityTracker {
  private readonly events = new Map<string, number[]>();
  private readonly seen = new Map<string, number>();
  private readonly alerts = new Map<string, number>();
  constructor(private readonly maxSeen = 5000) {}
  /** Returns the windowed count, or null when this message ID was already delivered. */
  record(guildId: string, userId: string, messageId: string, at: number, windowSeconds: number): number | null {
    const seenKey = `${guildId}:${messageId}`;
    if (this.seen.has(seenKey)) return null;
    this.seen.set(seenKey, at);
    if (this.seen.size > this.maxSeen) {
      const cutoff = at - 10 * 60_000;
      for (const [key, timestamp] of this.seen) if (timestamp < cutoff) this.seen.delete(key);
      while (this.seen.size > this.maxSeen) this.seen.delete(this.seen.keys().next().value!);
    }
    if (this.events.size > this.maxSeen) {
      for (const [key, timestamps] of this.events) {
        if (timestamps[timestamps.length - 1]! < at - 86400_000) this.events.delete(key);
      }
      while (this.events.size > this.maxSeen) this.events.delete(this.events.keys().next().value!);
    }
    if (this.alerts.size > this.maxSeen) {
      for (const [key, timestamp] of this.alerts) if (timestamp < at - 86400_000) this.alerts.delete(key);
      while (this.alerts.size > this.maxSeen) this.alerts.delete(this.alerts.keys().next().value!);
    }
    const key = `${guildId}:${userId}`;
    const window = (this.events.get(key) ?? []).filter(timestamp => timestamp >= at - windowSeconds * 1000);
    window.push(at);
    this.events.set(key, window);
    return window.length;
  }
  shouldAlert(guildId: string, userId: string, at: number, cooldownSeconds = 60): boolean {
    const key = `${guildId}:${userId}`;
    const last = this.alerts.get(key);
    if (last !== undefined && at - last < cooldownSeconds * 1000) return false;
    this.alerts.set(key, at);
    return true;
  }
  reset() {
    this.events.clear();
    this.seen.clear();
    this.alerts.clear();
  }
}
