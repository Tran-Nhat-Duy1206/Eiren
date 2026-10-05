import pg from 'pg';
import { EXPECTED_LATEST_MIGRATION_TAG, EXPECTED_MIGRATION_COUNT } from '../operations/migration-descriptor.js';
import { createRecoveryManifest, parseRecoveryManifest, RecoveryError, type RecoveryManifest, type RetentionPolicy, type SubjectExecutionReceipt } from './manifest.js';
import { verifyMigrationInventory } from './migrations.js';
export { writePrivateJsonFile } from './io.js';

export const RECOVERY_CODES = ['READY', 'REDACTION_REPLAY_REQUIRED', 'HOLD_REAPPLY_REQUIRED', 'POLICY_STATE_MISMATCH', 'SUBJECT_ERASURE_REPLAY_REQUIRED', 'AMBIGUOUS_REVIEW_REQUIRED', 'MIGRATION_MISMATCH', 'MANIFEST_INVALID', 'UNAVAILABLE'] as const;
export type RecoveryCode = typeof RECOVERY_CODES[number];
export type RecoveryReport = { status: 'PASS' | 'BLOCKED'; stage: 'validation' | 'connection' | 'schema' | 'observations' | 'complete'; generatedAt: string | null; manifestDigest: string | null; verifiedAt: string; migrationResult: 'PASS' | 'FAIL' | 'NOT_CHECKED'; migrationCount: 21; latestMigrationTag: string; obligations: number; checked: number; counts: Record<RecoveryCode, number> };
export type VerifyOptions = { confirmation?: string; sourceDatabaseUrl?: string };
const emptyCounts = (): Record<RecoveryCode, number> => Object.fromEntries(RECOVERY_CODES.map(code => [code, 0])) as Record<RecoveryCode, number>;
export function blockedRecoveryReport(code: 'MANIFEST_INVALID' | 'UNAVAILABLE' | 'MIGRATION_MISMATCH', stage: RecoveryReport['stage'] = 'validation'): RecoveryReport {
  const counts = emptyCounts(); counts[code] = 1;
  return { status: 'BLOCKED', stage, generatedAt: null, manifestDigest: null, verifiedAt: new Date().toISOString(), migrationResult: 'NOT_CHECKED', migrationCount: 21, latestMigrationTag: EXPECTED_LATEST_MIGRATION_TAG, obligations: 0, checked: 0, counts };
}
function plainAddress(value: string): { url: URL; name: string } {
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || !url.username || !url.password || !name || url.pathname.slice(1).includes('/') || name.includes('/') || Buffer.byteLength(name, 'utf8') > 63) throw new Error();
    return { url, name };
  } catch { throw new RecoveryError('UNAVAILABLE'); }
}
export function validateRecoveryTarget(databaseUrl: string, options: VerifyOptions): string {
  const target = plainAddress(databaseUrl);
  if (options.confirmation !== 'isolated-restored-target' || !['localhost', '127.0.0.1', '[::1]'].includes(target.url.hostname) || !/^eiren_recovery_[a-z0-9_]+$/.test(target.name)) throw new RecoveryError('UNAVAILABLE');
  if (options.sourceDatabaseUrl !== undefined) {
    const source = plainAddress(options.sourceDatabaseUrl);
    // Ports/hosts may forward to one server; credentials do not prove isolation.
    // Reject equal known database names conservatively, without contacting the source.
    if (source.name === target.name) throw new RecoveryError('UNAVAILABLE');
  }
  return target.name;
}
async function snapshot<T>(databaseUrl: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  let began = false, connectionLost = false;
  // pg can emit idle connection errors outside an awaited query. Never let raw
  // backend errors become an unhandled EventEmitter stack or a false PASS.
  client.on('error', () => { connectionLost = true; });
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
    await client.query("SET LOCAL search_path = pg_catalog, public");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    return await work(client);
  } finally {
    try { if (began) await client.query('ROLLBACK'); }
    finally {
      await client.end().catch(() => { connectionLost = true; });
      if (connectionLost) throw new RecoveryError('UNAVAILABLE');
    }
  }
}
const iso = (value: unknown): string => {
  if (typeof value === 'string') return value; // SQL UTC formatting preserves PostgreSQL microseconds.
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new RecoveryError('UNAVAILABLE');
  return value.toISOString();
};
const utcColumn = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const nullableIso = (value: unknown): string | null => value === null ? null : iso(value);
const POLICY_COLUMNS = `guild_id AS "guildId", enabled, ticket_retention_days AS "ticketDays", report_retention_days AS "reportDays", appeal_retention_days AS "appealDays", version, confirmed_by AS "confirmedBy", ${utcColumn('confirmed_at')} AS "confirmedAt"`;
function mapPolicy(row: Record<string, unknown>): RetentionPolicy { return { ...row, confirmedAt: nullableIso(row.confirmedAt) } as RetentionPolicy; }
export async function exportRecoveryManifest(databaseUrl: string, generatedAt = new Date().toISOString()): Promise<RecoveryManifest> {
  try {
    if (!databaseUrl) throw new RecoveryError('UNAVAILABLE');
    // Source access is authorized only by this explicit argument; no environment or dotenv bootstrap.
    return await snapshot(databaseUrl, async client => {
      if (!await verifyMigrationInventory(client)) throw new RecoveryError('MIGRATION_MISMATCH');
      const receipts = await client.query(`SELECT guild_id AS "guildId", domain, record_id::text AS "recordId", policy_version AS "policyVersion", policy_authorizer_id AS "policyAuthorizerId", ${utcColumn('redacted_at')} AS "redactedAt" FROM public.retention_receipts LIMIT 100001`);
      const holds = await client.query(`SELECT "guildId", domain, "recordId", "heldBy", "heldAt" FROM (SELECT guild_id AS "guildId", 'TICKET'::text AS domain, id::text AS "recordId", retention_hold_by AS "heldBy", ${utcColumn('retention_hold_at')} AS "heldAt" FROM public.tickets WHERE retention_hold = true
        UNION ALL SELECT guild_id, 'REPORT', id::text, retention_hold_by, ${utcColumn('retention_hold_at')} FROM public.reports WHERE retention_hold = true
        UNION ALL SELECT guild_id, 'APPEAL', id::text, retention_hold_by, ${utcColumn('retention_hold_at')} FROM public.appeals WHERE retention_hold = true) AS active_holds LIMIT 100001`);
      const policies = await client.query(`SELECT ${POLICY_COLUMNS} FROM public.retention_policies LIMIT 100001`);
      const subjects = await client.query(`SELECT request_id::text AS "requestId", guild_id AS "guildId", subject_user_id AS "subjectUserId", ${utcColumn('executed_at')} AS "executedAt", outcome, request_version AS "requestVersion", deleted_member_levels AS "deletedMemberLevels", deleted_member_reputation AS "deletedMemberReputation", deleted_achievements AS "deletedAchievements", deleted_event_participants AS "deletedEventParticipants", deleted_event_attendance AS "deletedEventAttendance", retained_total AS "retainedTotal" FROM public.subject_execution_receipts LIMIT 100001`);
      return createRecoveryManifest({ version: 1, generatedAt, migrationCount: EXPECTED_MIGRATION_COUNT, latestMigrationTag: EXPECTED_LATEST_MIGRATION_TAG, schemaMarker: 'repo/eiren-v8.6', retentionReceipts: receipts.rows.map(row => ({ ...row, redactedAt: iso(row.redactedAt) })) as RecoveryManifest['retentionReceipts'], activeHolds: holds.rows.map(row => ({ ...row, heldAt: iso(row.heldAt) })) as RecoveryManifest['activeHolds'], retentionPolicies: policies.rows.map(mapPolicy), subjectExecutionReceipts: subjects.rows.map(row => ({ ...row, executedAt: iso(row.executedAt) })) as RecoveryManifest['subjectExecutionReceipts'] });
    });
  } catch (error) { throw new RecoveryError(error instanceof RecoveryError ? error.code : 'UNAVAILABLE'); }
}
// Trusted whitelist. Manifest values are never identifiers or SQL expressions.
const TARGETS = {
  TICKET: { table: 'public.tickets', redaction: 'transcript IS NULL', at: 'transcript_redacted_at', version: 'transcript_retention_policy_version' },
  REPORT: { table: 'public.reports', redaction: 'description IS NULL AND evidence_url IS NULL AND resolution_note IS NULL', at: 'narrative_redacted_at', version: 'narrative_retention_policy_version' },
  APPEAL: { table: 'public.appeals', redaction: 'reason IS NULL AND review_note IS NULL', at: 'narrative_redacted_at', version: 'narrative_retention_policy_version' },
} as const;
function nonnegativeCount(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new RecoveryError('UNAVAILABLE');
  const count = Number(value); if (!Number.isSafeInteger(count)) throw new RecoveryError('UNAVAILABLE'); return count;
}
async function subjectCodes(client: pg.Client, receipt: SubjectExecutionReceipt): Promise<RecoveryCode[]> {
  let replay = false, ambiguous = false;
  const parameters = [receipt.guildId, receipt.subjectUserId, receipt.executedAt];
  const aggregates = [
    { table: 'public.member_levels', before: 'created_at <= $3::timestamptz AND updated_at <= $3::timestamptz', deleted: receipt.deletedMemberLevels },
    { table: 'public.member_reputation', before: 'updated_at <= $3::timestamptz', deleted: receipt.deletedMemberReputation },
    { table: 'public.member_achievements', before: 'awarded_at <= $3::timestamptz', deleted: receipt.deletedAchievements },
  ] as const;
  for (const family of aggregates) {
    const result = await client.query(`SELECT count(*)::text AS total, count(*) FILTER (WHERE ${family.before})::text AS before FROM ${family.table} WHERE guild_id = $1 AND user_id = $2`, parameters);
    const row = result.rows[0]; if (result.rows.length !== 1 || !row) throw new RecoveryError('UNAVAILABLE');
    const total = nonnegativeCount(row.total), before = nonnegativeCount(row.before);
    if (before > total) throw new RecoveryError('UNAVAILABLE');
    if (total) { if (family.deleted > 0 && before > 0) replay = true; if (family.deleted === 0 || total > before) ambiguous = true; }
  }
  const events = [
    { table: 'public.event_participants', at: 'joined_at', deleted: receipt.deletedEventParticipants },
    { table: 'public.event_attendance', at: 'marked_at', deleted: receipt.deletedEventAttendance },
  ] as const;
  for (const family of events) {
    const result = await client.query(`SELECT e.status, e.presentation_pending AS pending, e.presentation_retry_at IS NULL AS settled, count(*)::text AS total,
      count(*) FILTER (WHERE t.${family.at} <= $3::timestamptz AND e.updated_at <= $3::timestamptz)::text AS before
      FROM ${family.table} t INNER JOIN public.community_events e ON e.id = t.event_id
      WHERE e.guild_id = $1 AND t.user_id = $2 GROUP BY e.status, e.presentation_pending, (e.presentation_retry_at IS NULL)`, parameters);
    for (const row of result.rows) {
      const total = nonnegativeCount(row.total), before = nonnegativeCount(row.before);
      if (before > total || typeof row.pending !== 'boolean' || typeof row.settled !== 'boolean') throw new RecoveryError('UNAVAILABLE');
      if (!total) continue;
      if (row.status === 'ACTIVE' || row.status === 'SCHEDULED') continue; // Legitimate retention, not erasure eligibility.
      if (!['COMPLETED', 'CANCELLED'].includes(row.status) || row.pending || !row.settled) { ambiguous = true; continue; }
      // Counts do not identify which event rows were erased. Current terminal state and
      // timestamps cannot prove historical eligibility at execution; never infer replay.
      ambiguous = true;
    }
  }
  const codes: RecoveryCode[] = [];
  if (replay) codes.push('SUBJECT_ERASURE_REPLAY_REQUIRED');
  if (ambiguous) codes.push('AMBIGUOUS_REVIEW_REQUIRED');
  return codes.length ? codes : ['READY'];
}
export async function verifyRecovery(databaseUrl: string, input: RecoveryManifest, options: VerifyOptions = {}): Promise<RecoveryReport> {
  let report = { ...blockedRecoveryReport('MANIFEST_INVALID'), counts: emptyCounts() };
  try {
    const manifest = parseRecoveryManifest(JSON.stringify(input));
    const obligations = manifest.retentionReceipts.length + manifest.activeHolds.length + manifest.retentionPolicies.length + manifest.subjectExecutionReceipts.length;
    report = { ...report, generatedAt: manifest.generatedAt, manifestDigest: manifest.digest, obligations };
    const expectedDatabase = validateRecoveryTarget(databaseUrl, options);
    report.stage = 'connection';
    await snapshot(databaseUrl, async client => {
      const identity = await client.query('SELECT current_database() AS name, host(inet_server_addr()) AS address');
      const server = identity.rows[0];
      // Endpoint isolation is enforced by the URL guard. A loopback-published PG17
      // container has an internal non-loopback server address; that is not its endpoint.
      // Require a TCP server identity and the exact guarded database, not its internal IP.
      if (identity.rows.length !== 1 || !server || server.name !== expectedDatabase || typeof server.address !== 'string' || !server.address) throw new RecoveryError('UNAVAILABLE');
      report.stage = 'schema';
      if (!await verifyMigrationInventory(client)) { report.migrationResult = 'FAIL'; throw new RecoveryError('MIGRATION_MISMATCH'); }
      report.migrationResult = 'PASS';
      report.stage = 'observations';
      const add = (code: RecoveryCode) => { report.counts[code]++; report.checked++; };
      for (const receipt of manifest.retentionReceipts) {
        const target = TARGETS[receipt.domain];
        const result = await client.query(`SELECT (${target.redaction}) AS clear, ${target.at} IS NOT NULL AS marked, (${target.version} >= $3) AS version_ok FROM ${target.table} WHERE guild_id = $1 AND id = $2::bigint`, [receipt.guildId, receipt.recordId, receipt.policyVersion]);
        if (result.rows.length > 1) throw new RecoveryError('UNAVAILABLE');
        const row = result.rows[0];
        add(!row || (row.clear === true && row.marked === true && row.version_ok === true) ? 'READY' : 'REDACTION_REPLAY_REQUIRED');
      }
      for (const hold of manifest.activeHolds) {
        const result = await client.query(`SELECT retention_hold AS held, retention_hold_by = $3 AS actor_ok, retention_hold_at = $4::timestamptz AS time_ok FROM ${TARGETS[hold.domain].table} WHERE guild_id = $1 AND id = $2::bigint`, [hold.guildId, hold.recordId, hold.heldBy, hold.heldAt]);
        if (result.rows.length > 1) throw new RecoveryError('UNAVAILABLE');
        const row = result.rows[0];
        add(!row || (row.held === true && row.actor_ok === true && row.time_ok === true) ? 'READY' : 'HOLD_REAPPLY_REQUIRED');
      }
      for (const policy of manifest.retentionPolicies) {
        const result = await client.query(`SELECT ${POLICY_COLUMNS} FROM public.retention_policies WHERE guild_id = $1`, [policy.guildId]);
        if (result.rows.length > 1) throw new RecoveryError('UNAVAILABLE');
        const row = result.rows[0];
        const actual = row ? mapPolicy(row) : undefined;
        const normalizeTime = (value: unknown) => typeof value === 'string' ? value.replace(/(\.\d{3})Z$/, (_, fraction: string) => `${fraction}000Z`) : value;
        add(actual && Object.keys(policy).every(key => key === 'confirmedAt' ? normalizeTime(actual.confirmedAt) === normalizeTime(policy.confirmedAt) : actual[key as keyof RetentionPolicy] === policy[key as keyof RetentionPolicy]) ? 'READY' : 'POLICY_STATE_MISMATCH');
      }
      for (const receipt of manifest.subjectExecutionReceipts) {
        for (const code of await subjectCodes(client, receipt)) report.counts[code]++;
        report.checked++; // One obligation can have both proven replay and unresolved ambiguity.
      }
    });
    report.stage = 'complete'; report.status = report.checked === report.obligations && report.counts.READY === report.obligations ? 'PASS' : 'BLOCKED';
    return report;
  } catch (error) {
    const code = error instanceof RecoveryError ? error.code : 'UNAVAILABLE';
    report.status = 'BLOCKED'; report.counts[code]++;
    return report;
  }
}
