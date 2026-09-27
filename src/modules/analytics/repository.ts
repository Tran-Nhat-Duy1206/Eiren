import { and, eq, gte, isNotNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { analyticsSettings, analyticsGuildHourly as guildHour, analyticsChannelHourly as channelHour,
  analyticsCommandHourly as commandHour, analyticsEventDedupe as dedupe, analyticsMemberState as members,
  analyticsActiveVoiceSessions as voice, guildModules } from '../../core/database/schema.js';

export type AnalyticsRange = '24h' | '7d' | '30d' | '90d';
export const rangeHours: Record<AnalyticsRange, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };
export const hourStart = (at: Date) => new Date(Math.floor(at.getTime() / 3600000) * 3600000);
export type VoiceSlice = { bucketStart: Date; seconds: number };
export type VoiceReservation = { guildId: string; userId: string; epoch: number; sequence: number; observedAt: Date };
export type VoiceBoundary = { epoch: number; sequence: number; cutoff: Date };
/** Whole-second intervals are apportioned by UTC hour; subsecond residuals are deliberately discarded. */
export function voiceSlices(start: Date, end: Date): VoiceSlice[] {
  const result: VoiceSlice[] = [];
  let cursor = Math.ceil(start.getTime() / 1000) * 1000;
  const stop = Math.floor(end.getTime() / 1000) * 1000;
  while (cursor < stop) {
    const bucketStart = hourStart(new Date(cursor));
    const next = Math.min(stop, bucketStart.getTime() + 3600000);
    result.push({ bucketStart, seconds: (next - cursor) / 1000 });
    cursor = next;
  }
  return result;
}
export class AnalyticsMaintenanceError extends Error {
  constructor(readonly stage: string, cause: unknown) { super('Analytics maintenance stage failed', { cause }); }
}

export class AnalyticsRepository {
  constructor(private readonly db: Database) {}
  async settings(guildId: string) {
    const [row] = await this.db.select().from(analyticsSettings).where(eq(analyticsSettings.guildId, guildId));
    return row?.retentionDays ?? 180;
  }
  async configure(guildId: string, retentionDays: number) {
    await this.db.insert(analyticsSettings).values({ guildId, retentionDays }).onConflictDoUpdate({ target: analyticsSettings.guildId,
      set: { retentionDays, updatedAt: new Date() } });
  }
  private async stamp(tx: Parameters<Parameters<Database['transaction']>[0]>[0], guildId: string, eventKey: string, at: Date) {
    const inserted = await tx.insert(dedupe).values({ guildId, eventKey, createdAt: at }).onConflictDoNothing().returning({ eventKey: dedupe.eventKey });
    return inserted.length !== 0;
  }
  /** The analytics toggle shares this guild lock. Reject before writing even a dedupe key. */
  private async ingestionAllowed(tx: Parameters<Parameters<Database['transaction']>[0]>[0], guildId: string,
    expectedEpoch?: number) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), 0)`);
    const module = await this.voiceModuleState(tx, guildId);
    return Boolean(module?.enabled && (expectedEpoch === undefined || module.version === expectedEpoch));
  }
  async message(guildId: string, messageId: string, channelId: string, at: Date, expectedEpoch?: number) {
    return this.db.transaction(async tx => {
      if (!await this.ingestionAllowed(tx, guildId, expectedEpoch)) return false;
      if (!await this.stamp(tx, guildId, `m:${messageId}`, at)) return false;
      const bucketStart = hourStart(at);
      await tx.insert(guildHour).values({ guildId, bucketStart, messages: 1 }).onConflictDoUpdate({ target: [guildHour.guildId, guildHour.bucketStart], set: { messages: sql`${guildHour.messages} + 1` } });
      await tx.insert(channelHour).values({ guildId, channelId, bucketStart, messages: 1 }).onConflictDoUpdate({ target: [channelHour.guildId, channelHour.channelId, channelHour.bucketStart], set: { messages: sql`${channelHour.messages} + 1` } });
      return true;
    });
  }
  async member(guildId: string, userId: string, present: boolean, at: Date, expectedEpoch?: number) {
    return this.db.transaction(async tx => {
      if (!await this.ingestionAllowed(tx, guildId, expectedEpoch)) return false;
      // Same hierarchy as voice writers: guild analytics lock, then member lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), hashtext(${userId}))`);
      const [prior] = await tx.select({ present: members.present }).from(members)
        .where(and(eq(members.guildId, guildId), eq(members.userId, userId)));
      // An upsert with a conditional WHERE is a cross-process atomic state transition.
      const changed = await tx.insert(members).values({ guildId, userId, present, lastChangedAt: at })
        .onConflictDoUpdate({ target: [members.guildId, members.userId], set: { present, lastChangedAt: at },
          setWhere: sql`${members.present} <> ${present} AND ${members.lastChangedAt} < ${at}` })
        .returning({ userId: members.userId });
      if (!changed.length) return false;
      // A first observed removal is not evidence of an observed join.
      if (!prior && !present) return false;
      const bucketStart = hourStart(at);
      await tx.insert(guildHour).values({ guildId, bucketStart, joins: present ? 1 : 0, leaves: present ? 0 : 1 })
        .onConflictDoUpdate({ target: [guildHour.guildId, guildHour.bucketStart], set: present
          ? { joins: sql`${guildHour.joins} + 1` } : { leaves: sql`${guildHour.leaves} + 1` } });
      return true;
    });
  }
  async command(guildId: string, interactionId: string, commandName: string, failed: boolean, durationMs: number, at: Date,
    expectedEpoch?: number) {
    return this.db.transaction(async tx => {
      if (!await this.ingestionAllowed(tx, guildId, expectedEpoch)) return false;
      if (!await this.stamp(tx, guildId, `c:${interactionId}`, at)) return false;
      const bucketStart = hourStart(at);
      await tx.insert(commandHour).values({ guildId, commandName, bucketStart, invocations: 1, errors: Number(failed), totalDurationMs: durationMs })
        .onConflictDoUpdate({ target: [commandHour.guildId, commandHour.commandName, commandHour.bucketStart], set: {
          invocations: sql`${commandHour.invocations} + 1`, errors: sql`${commandHour.errors} + ${Number(failed)}`,
          totalDurationMs: sql`${commandHour.totalDurationMs} + ${durationMs}` } });
      return true;
    });
  }
  private async voiceModuleState(tx: Parameters<Parameters<Database['transaction']>[0]>[0], guildId: string) {
    const [state] = await tx.select({ enabled: guildModules.enabled, version: guildModules.version,
      voiceSequence: guildModules.voiceSequence }).from(guildModules)
      .where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, 'analytics')));
    return state;
  }
  /** Short transaction: durable sequence boundary, obtained before observing Discord state. */
  async voiceBoundary(guildId: string): Promise<VoiceBoundary | null> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), 0)`);
      const state = await this.voiceModuleState(tx, guildId);
      return state?.enabled ? { epoch: state.version, sequence: state.voiceSequence, cutoff: new Date() } : null;
    });
  }
  /** Reserve before any REST/classification await; pending rows are no-credit fences. */
  async reserveVoice(guildId: string, userId: string, observedAt: Date, reservedAt = new Date()): Promise<VoiceReservation | null> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), 0)`);
      const [clock] = await tx.update(guildModules).set({ voiceSequence: sql`${guildModules.voiceSequence} + 1` })
        .where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, 'analytics'), eq(guildModules.enabled, true)))
        .returning({ epoch: guildModules.version, sequence: guildModules.voiceSequence });
      if (!clock) return null;
      if (!Number.isSafeInteger(clock.sequence)) throw new Error('Voice observation sequence exhausted');
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), hashtext(${userId}))`);
      await tx.insert(voice).values({ guildId, userId, channelId: null, joinedAt: reservedAt, updatedAt: reservedAt,
        observationSeq: clock.sequence, observationEpoch: clock.epoch, pending: true })
        .onConflictDoUpdate({ target: [voice.guildId, voice.userId], set: {
          channelId: null, joinedAt: reservedAt, updatedAt: sql`GREATEST(${voice.updatedAt}, ${reservedAt})`,
          observationSeq: clock.sequence, observationEpoch: clock.epoch, pending: true } });
      return { guildId, userId, observedAt, epoch: clock.epoch, sequence: clock.sequence };
    });
  }
  /** Finalization may be delayed, but it can only complete its own current reservation. */
  async finalizeVoice(reservation: VoiceReservation, channelId: string | null, finalizedAt = new Date()) {
    const { guildId, userId, epoch, sequence } = reservation;
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), 0)`);
      const module = await this.voiceModuleState(tx, guildId);
      if (!module?.enabled || module.version !== epoch) return false;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), hashtext(${userId}))`);
      const [old] = await tx.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, userId)));
      if (!old?.pending || old.observationEpoch !== epoch || old.observationSeq !== sequence) return false;
      const baseline = new Date(Math.max(finalizedAt.getTime(), old.updatedAt.getTime()));
      await tx.update(voice).set({ channelId, joinedAt: baseline, updatedAt: baseline, pending: false })
        .where(and(eq(voice.guildId, guildId), eq(voice.userId, userId), eq(voice.observationSeq, sequence),
          eq(voice.observationEpoch, epoch), eq(voice.pending, true)));
      return true;
    });
  }
  private snapshotEligible(cutoff: Date, epoch: number, boundary: number) {
    return and(lt(voice.updatedAt, cutoff), or(ne(voice.observationEpoch, epoch),
      and(eq(voice.pending, false), lte(voice.observationSeq, boundary))));
  }
  private async voiceIn(tx: Parameters<Parameters<Database['transaction']>[0]>[0], guildId: string,
    userId: string, channelId: string | null, at: Date, readyAt?: Date) {
    // Every voice writer acquires the guild lock first, then the member lock, including snapshots.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), hashtext(${userId}))`);
    const [old] = await tx.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, userId)));
    if (old && (old.pending || at <= old.updatedAt)) return false;
    if (old?.channelId && (!readyAt || old.updatedAt >= readyAt) && at.getTime() - old.updatedAt.getTime() <= 600000) {
      for (const slice of voiceSlices(old.updatedAt, at)) {
        await tx.insert(guildHour).values({ guildId, bucketStart: slice.bucketStart, voiceSeconds: slice.seconds })
          .onConflictDoUpdate({ target: [guildHour.guildId, guildHour.bucketStart], set: { voiceSeconds: sql`${guildHour.voiceSeconds} + ${slice.seconds}` } });
        await tx.insert(channelHour).values({ guildId, channelId: old.channelId, bucketStart: slice.bucketStart, voiceSeconds: slice.seconds })
          .onConflictDoUpdate({ target: [channelHour.guildId, channelHour.channelId, channelHour.bucketStart], set: { voiceSeconds: sql`${channelHour.voiceSeconds} + ${slice.seconds}` } });
      }
    }
    const joinedAt = old?.channelId === channelId && (!readyAt || old.updatedAt >= readyAt) &&
      at.getTime() - old.updatedAt.getTime() <= 600000 ? old.joinedAt : at;
    await tx.insert(voice).values({ guildId, userId, channelId, joinedAt, updatedAt: at })
      .onConflictDoUpdate({ target: [voice.guildId, voice.userId], set: { channelId, joinedAt, updatedAt: at } });
    return true;
  }
  private async baselineVoiceIn(tx: Parameters<Parameters<Database['transaction']>[0]>[0], guildId: string,
    userId: string, channelId: string | null, at: Date) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), hashtext(${userId}))`);
    const rows = await tx.insert(voice).values({ guildId, userId, channelId, joinedAt: at, updatedAt: at })
      .onConflictDoUpdate({ target: [voice.guildId, voice.userId],
        set: { channelId, joinedAt: at, updatedAt: at }, setWhere: sql`${voice.updatedAt} < ${at} AND NOT ${voice.pending}` })
      .returning({ userId: voice.userId });
    return rows.length !== 0;
  }
  async voice(guildId: string, userId: string, channelId: string | null, at: Date, readyAt?: Date, readyEpoch?: number) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), 0)`);
      const module = await this.voiceModuleState(tx, guildId);
      if (module && !module.enabled) return false;
      // A different worker may have disabled/re-enabled since this process marked the guild ready.
      if (readyEpoch !== undefined && (module?.version ?? 0) !== readyEpoch)
        return this.baselineVoiceIn(tx, guildId, userId, channelId, at);
      return this.voiceIn(tx, guildId, userId, channelId, at, readyAt);
    });
  }
  /** Before guild readiness, persist an event fence without charging a persisted pre-restart interval. */
  async baselineVoice(guildId: string, userId: string, channelId: string | null, at: Date) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), 0)`);
      if ((await this.voiceModuleState(tx, guildId))?.enabled === false) return false;
      return this.baselineVoiceIn(tx, guildId, userId, channelId, at);
    });
  }
  /** The cutoff precedes snapshot collection; the later baseline never licenses touching newer gateway rows. */
  async reconcileVoice(guildId: string, live: readonly { userId: string; channelId: string }[], cutoff: Date,
    baselineAt = cutoff, observedEpoch?: number, observationBoundary = 0) {
    if (live.length > 1000 || baselineAt < cutoff) throw new Error('Invalid voice reconciliation boundary');
    const unique = new Map(live.map(item => [item.userId, item.channelId]));
    const applied = await this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), 0)`);
      const module = await this.voiceModuleState(tx, guildId);
      if (module?.enabled === false || (observedEpoch !== undefined && (module?.version ?? 0) !== observedEpoch)) return false;
      const epoch = module?.version ?? 0;
      // Pending reservations and observations beyond the pre-snapshot boundary always win.
      await tx.update(voice).set({ channelId: null, joinedAt: baselineAt, updatedAt: baselineAt,
        observationSeq: observationBoundary, observationEpoch: epoch, pending: false }).where(and(
        eq(voice.guildId, guildId), this.snapshotEligible(cutoff, epoch, observationBoundary),
        or(isNotNull(voice.channelId), ne(voice.observationEpoch, epoch)),
        ...(unique.size ? [notInArray(voice.userId, [...unique.keys()])] : [])));
      for (const [userId, channelId] of unique) {
        await tx.insert(voice).values({ guildId, userId, channelId, joinedAt: baselineAt, updatedAt: baselineAt,
          observationSeq: observationBoundary, observationEpoch: epoch, pending: false })
          .onConflictDoUpdate({ target: [voice.guildId, voice.userId], set: { channelId, joinedAt: baselineAt, updatedAt: baselineAt,
            observationSeq: observationBoundary, observationEpoch: epoch, pending: false },
            setWhere: this.snapshotEligible(cutoff, epoch, observationBoundary) });
      }
      return true;
    });
    return applied ? unique.size : -1;
  }
  /** One guild-locked transaction: only matching, older active sessions accrue observed time. */
  async heartbeat(guildId: string, live: readonly { userId: string; channelId: string }[], cutoff: Date,
    limit = 1000, baselineAt = cutoff, readyAt?: Date, readyEpoch?: number, observationBoundary = 0) {
    const cap = Math.min(1000, Math.max(1, limit));
    if (live.length > cap || baselineAt < cutoff) throw new Error('Voice heartbeat exceeds limit or has invalid boundary');
    const unique = new Map(live.map(item => [item.userId, item.channelId]));
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), 0)`);
      const module = await this.voiceModuleState(tx, guildId);
      if (module?.enabled === false || (readyEpoch !== undefined && (module?.version ?? 0) !== readyEpoch)) return -1;
      const epoch = module?.version ?? 0;
      for (const [userId, channelId] of unique) {
        const [old] = await tx.select().from(voice).where(and(eq(voice.guildId, guildId), eq(voice.userId, userId)));
        if (old && (old.updatedAt >= cutoff || (old.observationEpoch === epoch &&
          (old.pending || old.observationSeq > observationBoundary)))) continue;
        if (old?.channelId === channelId && old.observationEpoch === epoch && (!readyAt || old.updatedAt >= readyAt)) {
          await this.voiceIn(tx, guildId, userId, channelId, cutoff, readyAt);
          await tx.update(voice).set({ observationSeq: observationBoundary, observationEpoch: epoch })
            .where(and(eq(voice.guildId, guildId), eq(voice.userId, userId)));
        } else {
          // Snapshot disagrees with the last observed channel: reset, never attribute an uncertain interval.
          await tx.insert(voice).values({ guildId, userId, channelId, joinedAt: baselineAt, updatedAt: baselineAt,
            observationSeq: observationBoundary, observationEpoch: epoch, pending: false })
            .onConflictDoUpdate({ target: [voice.guildId, voice.userId],
              set: { channelId, joinedAt: baselineAt, updatedAt: baselineAt,
                observationSeq: observationBoundary, observationEpoch: epoch, pending: false },
              setWhere: this.snapshotEligible(cutoff, epoch, observationBoundary) });
        }
      }
      await tx.update(voice).set({ channelId: null, joinedAt: baselineAt, updatedAt: baselineAt,
        observationSeq: observationBoundary, observationEpoch: epoch, pending: false }).where(and(
        eq(voice.guildId, guildId), this.snapshotEligible(cutoff, epoch, observationBoundary),
        or(isNotNull(voice.channelId), ne(voice.observationEpoch, epoch)),
        ...(unique.size ? [notInArray(voice.userId, [...unique.keys()])] : [])));
      return unique.size;
    });
  }
  async prune(now = new Date(), limit = 500) {
    const runStage = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
      try { return await work(); }
      catch (error) { throw new AnalyticsMaintenanceError(stage, error); }
    };
    const cap = Math.min(1000, Math.max(1, limit));
    const dedupeCutoff = new Date(now.getTime() - 72 * 3600000);
    const removed = await runStage('analytics_event_dedupe', () => this.db.execute(sql`WITH doomed AS (SELECT guild_id, event_key FROM analytics_event_dedupe WHERE created_at < ${dedupeCutoff} LIMIT ${cap}) DELETE FROM analytics_event_dedupe d USING doomed WHERE d.guild_id = doomed.guild_id AND d.event_key = doomed.event_key`));
    let total = removed.rowCount ?? 0;
    for (const table of [guildHour, channelHour, commandHour] as const) {
      const name = table === guildHour ? sql`analytics_guild_hourly` : table === channelHour ? sql`analytics_channel_hourly` : sql`analytics_command_hourly`;
      const result = await runStage(table === guildHour ? 'analytics_guild_hourly' : table === channelHour ? 'analytics_channel_hourly' : 'analytics_command_hourly',
        () => this.db.execute(sql`WITH doomed AS (SELECT ctid FROM ${name} AS a WHERE a.bucket_start < ${now}::timestamptz - (COALESCE((SELECT s.retention_days FROM analytics_settings s WHERE s.guild_id = a.guild_id), 180) * interval '1 day') LIMIT ${cap}) DELETE FROM ${name} AS a USING doomed WHERE a.ctid = doomed.ctid`));
      total += result.rowCount ?? 0;
    }
    const stale = await runStage('analytics_member_state', () => this.db.execute(sql`WITH doomed AS (SELECT a.ctid FROM analytics_member_state a WHERE a.last_changed_at < ${now}::timestamptz - (COALESCE((SELECT s.retention_days FROM analytics_settings s WHERE s.guild_id = a.guild_id), 180) * interval '1 day') LIMIT ${cap}) DELETE FROM analytics_member_state a USING doomed WHERE a.ctid = doomed.ctid`));
    const abandonedVoice = await runStage('analytics_active_voice_sessions', () => this.db.execute(sql`WITH doomed AS (SELECT ctid FROM analytics_active_voice_sessions WHERE updated_at < ${now}::timestamptz - interval '72 hours' LIMIT ${cap}) DELETE FROM analytics_active_voice_sessions a USING doomed WHERE a.ctid = doomed.ctid`));
    return total + (stale.rowCount ?? 0) + (abandonedVoice.rowCount ?? 0);
  }
  async summary(guildId: string, range: AnalyticsRange, now = new Date(), timezone = 'UTC') {
    const since = new Date(now.getTime() - rangeHours[range] * 3600000);
    const bounds = (column: typeof guildHour.bucketStart) => and(eq(guildHour.guildId, guildId), gte(column, since), lt(column, now));
    const trend = await this.db.select().from(guildHour).where(bounds(guildHour.bucketStart)).orderBy(guildHour.bucketStart).limit(2160);
    const channels = await this.db.select({ channelId: channelHour.channelId, messages: sql<number>`sum(${channelHour.messages})::float8`, voiceSeconds: sql<number>`sum(${channelHour.voiceSeconds})::float8` })
      .from(channelHour).where(and(eq(channelHour.guildId, guildId), gte(channelHour.bucketStart, since), lt(channelHour.bucketStart, now)))
      .groupBy(channelHour.channelId).orderBy(sql`sum(${channelHour.messages}) DESC`).limit(10);
    const voiceChannels = await this.db.select({ channelId: channelHour.channelId,
      voiceSeconds: sql<number>`sum(${channelHour.voiceSeconds})::float8` }).from(channelHour)
      .where(and(eq(channelHour.guildId, guildId), gte(channelHour.bucketStart, since), lt(channelHour.bucketStart, now)))
      .groupBy(channelHour.channelId).orderBy(sql`sum(${channelHour.voiceSeconds}) DESC`).limit(10);
    const commands = await this.db.select({ commandName: commandHour.commandName, invocations: sql<number>`sum(${commandHour.invocations})::float8`, errors: sql<number>`sum(${commandHour.errors})::float8`, totalDurationMs: sql<number>`sum(${commandHour.totalDurationMs})::float8` })
      .from(commandHour).where(and(eq(commandHour.guildId, guildId), gte(commandHour.bucketStart, since), lt(commandHour.bucketStart, now)))
      .groupBy(commandHour.commandName).orderBy(sql`sum(${commandHour.invocations}) DESC`).limit(10);
    // Business events are authoritative, not duplicated. Linked child tables are scoped through their parent guild.
    const business = await this.db.execute(sql`SELECT
      (SELECT count(*)::int FROM moderation_cases WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now}) AS moderation_cases,
      (SELECT count(*)::int FROM tickets WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now}) AS tickets,
      (SELECT count(*)::int FROM suggestions WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now}) AS suggestions,
      (SELECT count(*)::int FROM community_events WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now}) AS events,
      (SELECT count(*)::int FROM event_attendance a JOIN community_events e ON e.id = a.event_id WHERE e.guild_id = ${guildId} AND a.marked_at >= ${since} AND a.marked_at < ${now}) AS attendance,
      (SELECT count(*)::int FROM giveaways WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now}) AS giveaways,
      (SELECT count(*)::int FROM giveaway_entries a JOIN giveaways g ON g.id = a.giveaway_id WHERE g.guild_id = ${guildId} AND a.entered_at >= ${since} AND a.entered_at < ${now}) AS giveaway_entries,
      (SELECT count(*)::int FROM giveaway_winners a JOIN giveaways g ON g.id = a.giveaway_id JOIN giveaway_draws d ON d.id = a.draw_id WHERE g.guild_id = ${guildId} AND d.created_at >= ${since} AND d.created_at < ${now}) AS giveaway_winners,
      (SELECT count(*)::int FROM member_levels WHERE guild_id = ${guildId}) AS level_members,
      (SELECT count(*)::int FROM member_reputation WHERE guild_id = ${guildId}) AS reputation_members,
      (SELECT count(*)::int FROM member_achievements WHERE guild_id = ${guildId} AND awarded_at >= ${since} AND awarded_at < ${now}) AS achievements`);
    // Fixed-domain projections are aggregate-only: no member identifiers, reasons, transcripts or content leave SQL.
    const projections = await this.db.execute(sql`SELECT
      (SELECT coalesce(jsonb_object_agg(action, n), '{}'::jsonb) FROM (SELECT action, count(*)::int n FROM moderation_cases WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now} GROUP BY action LIMIT 10) x) AS moderation_actions,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('day', day, 'count', n) ORDER BY day), '[]'::jsonb) FROM (SELECT (created_at AT TIME ZONE ${timezone})::date AS day, count(*)::int n FROM moderation_cases WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now} GROUP BY 1 ORDER BY 1 LIMIT 92) x) AS moderation_days,
      (SELECT count(*)::int FROM tickets WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now}) AS tickets_opened,
      (SELECT count(*)::int FROM tickets WHERE guild_id = ${guildId} AND closed_at >= ${since} AND closed_at < ${now}) AS tickets_closed,
      (SELECT count(*)::int FROM tickets WHERE guild_id = ${guildId} AND status IN ('OPEN','CLAIMED')) AS tickets_open,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('day', day, 'opened', opened, 'closed', closed) ORDER BY day), '[]'::jsonb)
         FROM (SELECT day, sum(opened)::int AS opened, sum(closed)::int AS closed FROM (
           SELECT (created_at AT TIME ZONE ${timezone})::date AS day, 1 AS opened, 0 AS closed
             FROM tickets WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now}
           UNION ALL
           SELECT (closed_at AT TIME ZONE ${timezone})::date AS day, 0 AS opened, 1 AS closed
             FROM tickets WHERE guild_id = ${guildId} AND closed_at >= ${since} AND closed_at < ${now}
         ) events GROUP BY day ORDER BY day LIMIT 92) daily) AS ticket_days,
      (SELECT avg(extract(epoch FROM (closed_at - created_at)))::float8 FROM tickets WHERE guild_id = ${guildId} AND closed_at >= ${since} AND closed_at < ${now} AND closed_at >= created_at) AS ticket_resolution_seconds,
      (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*)::int n FROM suggestions WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now} GROUP BY status LIMIT 10) x) AS suggestion_statuses,
      (SELECT count(*)::int FROM suggestion_votes v JOIN suggestions s ON s.id = v.suggestion_id WHERE s.guild_id = ${guildId} AND v.created_at >= ${since} AND v.created_at < ${now}) AS suggestion_votes,
      (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*)::int n FROM community_events WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now} GROUP BY status LIMIT 10) x) AS event_statuses,
      (SELECT count(*)::int FROM event_participants p JOIN community_events e ON e.id = p.event_id WHERE e.guild_id = ${guildId} AND p.joined_at >= ${since} AND p.joined_at < ${now}) AS event_rsvps,
      (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*)::int n FROM giveaways WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now} GROUP BY status LIMIT 10) x) AS giveaway_statuses,
      (SELECT coalesce(jsonb_object_agg(achievement_id, n), '{}'::jsonb) FROM (SELECT achievement_id, count(*)::int n FROM member_achievements WHERE guild_id = ${guildId} AND awarded_at >= ${since} AND awarded_at < ${now} GROUP BY achievement_id ORDER BY n DESC LIMIT 10) x) AS achievement_distribution,
      (SELECT count(*)::int FROM tempvoice_rooms WHERE guild_id = ${guildId} AND created_at >= ${since} AND created_at < ${now}) AS tempvoice_rooms_created,
      (SELECT count(*)::int FROM tempvoice_rooms WHERE guild_id = ${guildId} AND status IN ('CREATING','ACTIVE','DELETING')) AS tempvoice_rooms_active`);
    const hourlyDays = await this.db.execute(sql`SELECT (bucket_start AT TIME ZONE ${timezone})::date AS day,
      sum(messages)::float8 AS messages, sum(joins)::float8 AS joins, sum(leaves)::float8 AS leaves,
      sum(joins - leaves)::float8 AS net, sum(voice_seconds)::float8 AS voice_seconds
      FROM analytics_guild_hourly WHERE guild_id = ${guildId} AND bucket_start >= ${since} AND bucket_start < ${now}
      GROUP BY 1 ORDER BY 1 LIMIT 92`);
    const detail = projections.rows[0] ?? {};
    return { guildId, range, since, until: now, details: {
      moderation: { actions: detail.moderation_actions ?? {}, daily: detail.moderation_days ?? [] },
      tickets: { opened: detail.tickets_opened ?? 0, closed: detail.tickets_closed ?? 0, open: detail.tickets_open ?? 0,
         daily: detail.ticket_days ?? [], averageResolutionSeconds: detail.ticket_resolution_seconds ?? null },
      suggestions: { submitted: business.rows[0]?.suggestions ?? 0, statuses: detail.suggestion_statuses ?? {}, votes: detail.suggestion_votes ?? 0 },
      events: { created: business.rows[0]?.events ?? 0, statuses: detail.event_statuses ?? {}, rsvps: detail.event_rsvps ?? 0, attendance: business.rows[0]?.attendance ?? 0 },
      giveaways: { created: business.rows[0]?.giveaways ?? 0, statuses: detail.giveaway_statuses ?? {}, entries: business.rows[0]?.giveaway_entries ?? 0, winners: business.rows[0]?.giveaway_winners ?? 0 },
      achievements: { distribution: detail.achievement_distribution ?? {} },
      tempvoice: { created: detail.tempvoice_rooms_created ?? 0, active: detail.tempvoice_rooms_active ?? 0 },
    }, localDays: hourlyDays.rows, totals: trend.reduce((sum, row) => ({ messages: sum.messages + row.messages, joins: sum.joins + row.joins,
      leaves: sum.leaves + row.leaves, net: sum.net + row.joins - row.leaves,
      voiceSeconds: sum.voiceSeconds + row.voiceSeconds }), { messages: 0, joins: 0, leaves: 0, net: 0, voiceSeconds: 0 }),
      trend, channels, voiceChannels, commands, business: business.rows[0] ?? {} };
  }
}
