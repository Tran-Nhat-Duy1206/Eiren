import type { QueryResultRow } from 'pg';

/** Supplied reader must use a dedicated pool, read-only transactions and 1500ms statement_timeout. */
export interface OperationalDatabase {
  query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
export type DiagnosticStatus = 'EMPTY' | 'HEALTHY' | 'PENDING' | 'STALE' | 'ACTIONABLE' | 'AMBIGUOUS' | 'UNAVAILABLE' | 'NOT_TRACKED';
export type Diagnostic = { key: DiagnosticKey; status: DiagnosticStatus; count: number | null; oldestAt: Date | null; ageSeconds: number | null };
const untracked = ['discord_orphans', 'backup_health', 'tls_health', 'historical_failures'] as const;
type Spec = { key: string; from: string; where: string; at: string; status: DiagnosticStatus; stale?: string };
// STALE describes age beyond durable claim/grace semantics, not failure or permission to retry.
// Due transitions get 90 seconds (three scheduler cadences) before being marked stale.
// All SQL fragments below are static source constants, never caller-provided identifiers/predicates.
const specs = [
  { key: 'automation_pending', from: 'automation_executions e', where: "e.guild_id=$1 AND e.status='PENDING'", at: 'e.created_at', status: 'PENDING', stale: "e.created_at <= statement_timestamp()-interval '86400 seconds' OR e.attempts>=5" },
  { key: 'automation_running', from: 'automation_executions e', where: "e.guild_id=$1 AND e.status='RUNNING'", at: 'e.created_at', status: 'PENDING', stale: 'e.lease_until < statement_timestamp()' },
  { key: 'automation_uncertain', from: 'automation_executions e', where: "e.guild_id=$1 AND e.status='UNCERTAIN'", at: 'coalesce(e.completed_at,e.created_at)', status: 'ACTIONABLE' },
  { key: 'automation_action_uncertain', from: 'automation_executions e JOIN automation_action_runs r ON r.execution_id=e.id', where: "e.guild_id=$1 AND r.status='UNCERTAIN'", at: 'r.updated_at', status: 'ACTIONABLE' },
  { key: 'audit_gaps', from: 'governance_audit_gaps', where: 'guild_id=$1', at: 'detected_at', status: 'ACTIONABLE' },
  { key: 'event_presentation_pending', from: 'community_events', where: 'guild_id=$1 AND presentation_pending', at: 'updated_at', status: 'PENDING' },
  { key: 'event_scheduled_overdue', from: 'community_events', where: "guild_id=$1 AND status='SCHEDULED' AND start_at<=statement_timestamp()", at: 'start_at', status: 'PENDING', stale: "start_at<=statement_timestamp()-interval '90 seconds'" },
  { key: 'event_active_overdue', from: 'community_events', where: "guild_id=$1 AND status='ACTIVE' AND end_at<=statement_timestamp()", at: 'end_at', status: 'PENDING', stale: "end_at<=statement_timestamp()-interval '90 seconds'" },
  { key: 'event_reminder_processing', from: 'community_events e JOIN event_reminders r ON r.event_id=e.id', where: "e.guild_id=$1 AND r.status='PROCESSING'", at: 'r.claimed_at', status: 'PENDING', stale: "r.claimed_at < statement_timestamp()-interval '300 seconds'" },
  { key: 'giveaway_active_overdue', from: 'giveaways', where: "guild_id=$1 AND status='ACTIVE' AND end_at<=statement_timestamp()", at: 'end_at', status: 'PENDING', stale: "end_at<=statement_timestamp()-interval '90 seconds'" },
  { key: 'giveaway_presentation_unresolved', from: 'giveaways', where: "guild_id=$1 AND status='ACTIVE' AND (message_id IS NULL OR message_id LIKE 'PENDING:%')", at: 'updated_at', status: 'PENDING', stale: "updated_at < statement_timestamp()-interval '300 seconds'" },
  { key: 'giveaway_result_unresolved', from: 'giveaways', where: "guild_id=$1 AND status='ENDED' AND (result_announcement_id IS NULL OR result_announcement_id LIKE 'PENDING:%')", at: 'updated_at', status: 'PENDING', stale: "updated_at < statement_timestamp()-interval '120 seconds'" },
  { key: 'giveaway_draw_notify_unresolved', from: 'giveaways g JOIN giveaway_draws d ON d.giveaway_id=g.id', where: 'g.guild_id=$1 AND d.result_announcement_id IS NULL', at: 'coalesce(d.notification_claimed_at,d.created_at)', status: 'AMBIGUOUS', stale: "coalesce(d.notification_claimed_at,d.created_at) < statement_timestamp()-interval '300 seconds'" },
  { key: 'tempvoice_creating', from: 'tempvoice_rooms', where: "guild_id=$1 AND status='CREATING'", at: 'created_at', status: 'PENDING', stale: "created_at<=statement_timestamp()-interval '60 seconds' AND updated_at<=statement_timestamp()-interval '60 seconds'" },
  { key: 'tempvoice_deleting', from: 'tempvoice_rooms', where: "guild_id=$1 AND status='DELETING'", at: 'updated_at', status: 'PENDING', stale: "updated_at<=statement_timestamp()-interval '60 seconds'" },
  { key: 'ticket_channel_unresolved', from: 'tickets', where: "guild_id=$1 AND status IN ('OPEN','CLAIMED') AND channel_id IS NULL", at: 'created_at', status: 'PENDING', stale: "created_at<=statement_timestamp()-interval '600 seconds'" },
  { key: 'retention_enabled', from: 'retention_policies', where: 'guild_id=$1 AND enabled', at: 'updated_at', status: 'HEALTHY' },
  { key: 'retention_holds', from: '(SELECT guild_id,retention_hold_at FROM tickets WHERE guild_id=$1 AND retention_hold UNION ALL SELECT guild_id,retention_hold_at FROM reports WHERE guild_id=$1 AND retention_hold UNION ALL SELECT guild_id,retention_hold_at FROM appeals WHERE guild_id=$1 AND retention_hold) holds', where: 'guild_id=$1', at: 'retention_hold_at', status: 'HEALTHY' },
  { key: 'privacy_pending', from: 'subject_requests', where: "guild_id=$1 AND status IN ('PENDING','PREVIEWED','CONFIRMED','EXECUTING')", at: 'requested_at', status: 'PENDING' },
] as const satisfies readonly Spec[];
export type DiagnosticKey = typeof specs[number]['key'] | typeof untracked[number];
export function unavailableDiagnostic(key: DiagnosticKey, status: 'UNAVAILABLE' | 'NOT_TRACKED' = 'UNAVAILABLE'): Diagnostic {
  return { key, status, count: null, oldestAt: null, ageSeconds: null };
}
export async function boundedOperationalRead<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Operational read deadline')), 2200); })]); }
  finally { if (timer) clearTimeout(timer); }
}
/** Fixed aggregate SQL exposed for the synthetic EXPLAIN validation driver. */
export const diagnosticQueries = specs.map((spec: Spec) => ({ key: spec.key as DiagnosticKey, text:
  `SELECT count(*)::text AS count, min(${spec.at}) AS oldest_at, CASE WHEN min(${spec.at}) IS NULL THEN NULL ELSE greatest(0,extract(epoch FROM (statement_timestamp()-min(${spec.at}))))::float8 END AS age_seconds, count(*) FILTER (WHERE ${spec.stale ?? 'false'})::text AS stale_count FROM ${spec.from} WHERE ${spec.where}` }));
interface Aggregate extends QueryResultRow { count: string; oldest_at: Date | null; age_seconds: number | null; stale_count: string }
export class OperationsDiagnostics {
  constructor(private readonly reader: Pick<OperationalDatabase, 'query'>) {}
  async inspect(guildId: string): Promise<Diagnostic[]> {
    const results = await Promise.all(specs.map(async (spec, index): Promise<Diagnostic> => {
      try {
        const { rows } = await boundedOperationalRead(() => this.reader.query<Aggregate>(diagnosticQueries[index]!.text, [guildId]));
        const row = rows[0];
        if (!row) throw new Error('Missing aggregate');
        const count = Number(row.count), stale = Number(row.stale_count);
        if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(stale) || stale < 0 || stale > count ||
          (row.oldest_at !== null && (!(row.oldest_at instanceof Date) || !Number.isFinite(row.oldest_at.getTime()))) ||
          (row.age_seconds !== null && (!Number.isFinite(row.age_seconds) || row.age_seconds < 0)) ||
          (count === 0 && (row.oldest_at !== null || row.age_seconds !== null))) throw new Error('Invalid aggregate');
        return { key: spec.key, status: count === 0 ? 'EMPTY' : stale > 0 ? 'STALE' : spec.status, count, oldestAt: row.oldest_at, ageSeconds: row.age_seconds };
      } catch { return unavailableDiagnostic(spec.key); }
    }));
    return [...results, ...untracked.map(key => unavailableDiagnostic(key, 'NOT_TRACKED'))];
  }
}
