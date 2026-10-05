import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecoveryManifest, parseRecoveryManifest, type RecoveryManifestPayload, type SubjectExecutionReceipt } from './manifest.js';
import { GOVERNANCE_TABLES, MIGRATION_INVENTORY } from './migrations.js';
const fake = vi.hoisted(() => ({ connect: vi.fn(), end: vi.fn(), query: vi.fn(), construct: vi.fn(), on: vi.fn() }));
vi.mock('pg', () => ({ default: { Client: class { constructor(options: unknown) { fake.construct(options); } connect = fake.connect; end = fake.end; query = fake.query; on = fake.on; } } }));
import { exportRecoveryManifest, validateRecoveryTarget, verifyRecovery } from './verify.js';
const guildId = '990000000000000001';
const subjectUserId = '990000000000000002';
const actor = '990000000000000003';
const time = '2026-08-01T12:00:00.000Z';
const target = 'postgres://operator:secret@127.0.0.1:5432/eiren_recovery_unit';
const options = { confirmation: 'isolated-restored-target' };
function payload(): RecoveryManifestPayload { return { version: 1, generatedAt: time, migrationCount: 21, latestMigrationTag: '0020_subject_request_governance', schemaMarker: 'repo/eiren-v8.6', retentionReceipts: [], activeHolds: [], retentionPolicies: [], subjectExecutionReceipts: [] }; }
function subject(changes: Partial<SubjectExecutionReceipt> = {}): SubjectExecutionReceipt { return { requestId: '00000000-0000-0000-0000-000000000001', guildId, subjectUserId, executedAt: time, outcome: 'PARTIAL', requestVersion: 3, deletedMemberLevels: 1, deletedMemberReputation: 1, deletedAchievements: 2, deletedEventParticipants: 2, deletedEventAttendance: 2, retainedTotal: 3, ...changes }; }
function response(text: string): { rows: Record<string, unknown>[] } {
  if (text.includes('current_database()')) return { rows: [{ name: 'eiren_recovery_unit', address: '127.0.0.1' }] };
  if (text.includes('server_version_num')) return { rows: [{ server_version_num: '170009' }] };
  if (text.includes("to_regclass('drizzle")) return { rows: [{ present: true }] };
  if (text.includes('FROM drizzle.__drizzle_migrations')) return { rows: MIGRATION_INVENTORY.map((m, i) => ({ id: i + 1, hash: m[2], created_at: m[1] })) };
  if (text.includes('AS required(name)')) return { rows: GOVERNANCE_TABLES.map(name => ({ name, present: true })) };
  if (text.includes('count(*)') && !text.includes('GROUP BY')) return { rows: [{ total: '0', before: '0' }] };
  return { rows: [] };
}
beforeEach(() => { vi.clearAllMocks(); fake.connect.mockResolvedValue(undefined); fake.end.mockResolvedValue(undefined); fake.query.mockImplementation(async text => response(text)); });
function queries(): string[] { return fake.query.mock.calls.map(call => call[0] as string); }
async function verify(p = payload()) { return verifyRecovery(target, createRecoveryManifest(p), options); }
describe('safe source snapshot and target gates', () => {
  it('uses read-only repeatable read and bounded timeouts, qualified source metadata only', async () => {
    const result = await exportRecoveryManifest('postgres://explicit:secret@source/db', time);
    expect(result.retentionReceipts).toEqual([]);
    const sql = queries().join('\n');
    expect(sql).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(sql).toContain("SET LOCAL search_path = pg_catalog, public");
    for (const setting of ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout']) expect(sql).toContain(setting);
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT|DROP|CREATE|ALTER|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/\b(transcript|description|evidence_url|resolution_note|reason|review_note|inventory_hash|confirmed_by AS.*executed_by)\b/);
    expect(fake.end).toHaveBeenCalledOnce();
  });
  it('rejects duplicate JSON object keys including escaped aliases', () => {
    const text = JSON.stringify(createRecoveryManifest(payload()));
    expect(() => parseRecoveryManifest(text.replace('"version":1', '"version":1,"version":1'))).toThrow('MANIFEST_INVALID');
    expect(() => parseRecoveryManifest(text.replace('"version":1', '"version":1,"\\\\u0076ersion":1'))).toThrow('MANIFEST_INVALID');
  });
  it('source export preserves PostgreSQL microseconds for exact hold and erasure cutoffs', async () => {
    const precise = '2026-08-01T12:00:00.123456Z';
    fake.query.mockImplementation(async text => {
      if (text.includes('FROM public.retention_receipts LIMIT')) return { rows: [{ guildId, domain: 'TICKET', recordId: '7', policyVersion: 1, policyAuthorizerId: actor, redactedAt: precise }] };
      if (text.includes('AS active_holds LIMIT')) return { rows: [{ guildId, domain: 'REPORT', recordId: '8', heldBy: actor, heldAt: precise }] };
      if (text.includes('FROM public.subject_execution_receipts LIMIT')) return { rows: [subject({ executedAt: precise })] };
      return response(text);
    });
    const manifest = await exportRecoveryManifest('explicit-source', time);
    expect(manifest.retentionReceipts[0]!.redactedAt).toBe(precise); expect(manifest.activeHolds[0]!.heldAt).toBe(precise); expect(manifest.subjectExecutionReceipts[0]!.executedAt).toBe(precise);
    expect(queries().join('\n')).toContain('SS.US');
  });
  it('validates object digest before connecting and counts invalid exactly once', async () => {
    const manifest = createRecoveryManifest(payload()); manifest.digest = '0'.repeat(64);
    const report = await verifyRecovery(target, manifest, options);
    expect(report.status).toBe('BLOCKED'); expect(report.counts.MANIFEST_INVALID).toBe(1); expect(fake.connect).not.toHaveBeenCalled();
  });
  it.each([
    ['postgres://u:p@remote/eiren_recovery_unit', options],
    ['postgres://u:p@127.0.0.1/eiren', options],
    ['postgres://u:p@127.0.0.1/eiren_recovery_x?sslmode=disable', options],
    ['postgres://u:p@127.0.0.1/eiren_recovery_x#fragment', options],
    ['postgres://u:p@127.0.0.1/eiren_recovery_x', { confirmation: 'yes' }],
    [target, { ...options, sourceDatabaseUrl: 'postgres://another:password@localhost:5432/eiren_recovery_unit' }],
    [target, { ...options, sourceDatabaseUrl: 'postgres://another:password@127.0.0.1:9876/eiren_recovery_unit' }],
    [target, { ...options, sourceDatabaseUrl: 'postgres://another:password@remote:5432/eiren_recovery_unit' }],
    ['postgres://u:p@127.0.0.1/eiren_recovery_' + 'x'.repeat(60), options],
  ])('rejects unsafe target before connection %s', async (url, config) => {
    const report = await verifyRecovery(url, createRecoveryManifest(payload()), config);
    expect(report.counts.UNAVAILABLE).toBe(1); expect(fake.connect).not.toHaveBeenCalled();
  });
  it('canonicalizes loopback aliases and allows distinct database', () => { expect(validateRecoveryTarget(target, { ...options, sourceDatabaseUrl: 'postgres://u:p@localhost/eiren_source' })).toBe('eiren_recovery_unit'); });
  it('connection failures close client and never expose secrets', async () => {
    fake.connect.mockRejectedValue(new Error('secret postgres://password transcript SENTINEL'));
    const report = await verify(); expect(report.counts.UNAVAILABLE).toBe(1); expect(JSON.stringify(report)).not.toMatch(/secret|password|SENTINEL/); expect(fake.end).toHaveBeenCalledOnce();
    expect(queries()).not.toContain('ROLLBACK');
  });
  it('handles idle pg error events before connect and fails closed without raw error leaks', async () => {
    fake.query.mockImplementation(async text => {
      if (text === 'ROLLBACK') {
        const listener = fake.on.mock.calls.find(call => call[0] === 'error')![1] as (error: Error) => void;
        listener(new Error('PRIVATE PG backend stack postgres://password'));
      }
      return response(text);
    });
    const report = await verify(); expect(report.status).toBe('BLOCKED'); expect(report.counts.UNAVAILABLE).toBe(1); expect(fake.end).toHaveBeenCalledOnce(); expect(JSON.stringify(report)).not.toMatch(/PRIVATE|backend|password/);
    expect(fake.on.mock.invocationCallOrder[0]).toBeLessThan(fake.connect.mock.invocationCallOrder[0]!);
  });
  it('rolls back/releases even after query failure', async () => {
    fake.query.mockImplementation(async text => { if (text.includes('current_database')) throw new Error('sql SECRET'); return response(text); });
    const report = await verify(); expect(report.counts.UNAVAILABLE).toBe(1); expect(queries().at(-1)).toBe('ROLLBACK'); expect(fake.end).toHaveBeenCalledOnce();
  });
  it('fails closed if rollback itself fails', async () => {
    fake.query.mockImplementation(async text => { if (text === 'ROLLBACK') throw new Error('disconnect'); return response(text); });
    expect((await verify()).status).toBe('BLOCKED'); expect(fake.end).toHaveBeenCalledOnce();
  });
  it('accepts loopback-published container internal address with exact database identity', async () => {
    fake.query.mockImplementation(async text => text.includes('current_database') ? { rows: [{ name: 'eiren_recovery_unit', address: '172.18.0.2' }] } : response(text));
    expect((await verify()).status).toBe('PASS'); expect(queries()).toContain('SELECT current_database() AS name, host(inet_server_addr()) AS address');
  });
  it('checks real database and address rather than trusting URL only', async () => {
    fake.query.mockImplementation(async text => text.includes('current_database') ? { rows: [{ name: 'eiren_source', address: '10.1.2.3' }] } : response(text));
    expect((await verify()).counts.UNAVAILABLE).toBe(1); expect(queries().some(text => text.includes('retention_receipts'))).toBe(false);
  });
  it('blocks early migration hash mismatch before all governance reads', async () => {
    fake.query.mockImplementation(async text => { const result = response(text); if (text.includes('FROM drizzle.')) result.rows[0]!.hash = '0'.repeat(64); return result; });
    const p = payload(); p.subjectExecutionReceipts = [subject()];
    const report = await verify(p); expect(report.counts.MIGRATION_MISMATCH).toBe(1); expect(report.migrationResult).toBe('FAIL');
    expect(queries().some(text => text.includes('FROM public.'))).toBe(false);
  });
  it('source migration mismatch is fixed and skips export', async () => {
    fake.query.mockImplementation(async text => text.includes('server_version_num') ? { rows: [{ server_version_num: '160003' }] } : response(text));
    await expect(exportRecoveryManifest('postgres://explicit/db', time)).rejects.toThrow('MIGRATION_MISMATCH'); expect(queries().some(text => text.includes('FROM public.'))).toBe(false);
  });
  it('empty validated manifest passes with only fixed metadata', async () => { const report = await verify(); expect(report.status).toBe('PASS'); expect(report.migrationResult).toBe('PASS'); expect(report.manifestDigest).toMatch(/^[a-f0-9]{64}$/); expect(report.checked).toBe(0); });
});
describe('retention, hold, and policy observations', () => {
  it.each(['TICKET', 'REPORT', 'APPEAL'] as const)('checks payload only via nullness for %s and permits missing target', async domain => {
    const p = payload(); p.retentionReceipts = [{ guildId, domain, recordId: '9223372036854775807', policyVersion: 2, policyAuthorizerId: actor, redactedAt: time }];
    let report = await verify(p); expect(report.status).toBe('PASS'); expect(report.counts.READY).toBe(1);
    const projection = queries().find(text => text.includes(' AS clear'))!; expect(projection).toContain('guild_id = $1 AND id = $2::bigint'); expect(projection).toContain('IS NULL'); expect(projection).not.toContain('SELECT transcript,');
    fake.query.mockImplementation(async text => text.includes(' AS clear') ? { rows: [{ clear: false, marked: true, version_ok: true }] } : response(text));
    report = await verify(p); expect(report.counts.REDACTION_REPLAY_REQUIRED).toBe(1);
  });
  it.each([{ clear: true, marked: false, version_ok: true }, { clear: true, marked: true, version_ok: false }, { clear: null, marked: true, version_ok: true }])('redaction markers fail closed %j', async row => {
    const p = payload(); p.retentionReceipts = [{ guildId, domain: 'TICKET', recordId: '7', policyVersion: 2, policyAuthorizerId: actor, redactedAt: time }];
    fake.query.mockImplementation(async text => text.includes(' AS clear') ? { rows: [row] } : response(text)); expect((await verify(p)).counts.REDACTION_REPLAY_REQUIRED).toBe(1);
  });
  it.each([{ held: false, actor_ok: true, time_ok: true }, { held: true, actor_ok: false, time_ok: true }, { held: true, actor_ok: true, time_ok: false }])('hold requires exact actor/time %j', async row => {
    const p = payload(); p.activeHolds = [{ guildId, domain: 'REPORT', recordId: '8', heldBy: actor, heldAt: '2026-08-01T12:00:00.123456Z' }];
    fake.query.mockImplementation(async text => text.includes(' AS held') ? { rows: [row] } : response(text)); expect((await verify(p)).counts.HOLD_REAPPLY_REQUIRED).toBe(1);
    const call = fake.query.mock.calls.find(call => String(call[0]).includes(' AS held'))!; expect(call[1]).toEqual([guildId, '8', actor, '2026-08-01T12:00:00.123456Z']);
  });
  it('duplicate target identities cannot produce false READY', async () => {
    const p = payload(); p.retentionReceipts = [{ guildId, domain: 'TICKET', recordId: '7', policyVersion: 2, policyAuthorizerId: actor, redactedAt: time }];
    fake.query.mockImplementation(async text => text.includes(' AS clear') ? { rows: [{ clear: true, marked: true, version_ok: true }, { clear: false, marked: false, version_ok: false }] } : response(text));
    expect((await verify(p)).counts.UNAVAILABLE).toBe(1);
  });
  it('missing held parent is acceptable; matching hold READY', async () => {
    const p = payload(); p.activeHolds = [{ guildId, domain: 'APPEAL', recordId: '8', heldBy: actor, heldAt: time }]; expect((await verify(p)).status).toBe('PASS');
    fake.query.mockImplementation(async text => text.includes(' AS held') ? { rows: [{ held: true, actor_ok: true, time_ok: true }] } : response(text)); expect((await verify(p)).status).toBe('PASS');
  });
  it('policy must exist and match all current state', async () => {
    const p = payload(); const policy = { guildId, enabled: false, ticketDays: 90, reportDays: 365, appealDays: 365, version: 4, confirmedBy: actor, confirmedAt: time }; p.retentionPolicies = [policy];
    expect((await verify(p)).counts.POLICY_STATE_MISMATCH).toBe(1);
    fake.query.mockImplementation(async text => text.includes('FROM public.retention_policies WHERE') ? { rows: [{ ...policy, confirmedAt: new Date(time) }] } : response(text)); expect((await verify(p)).status).toBe('PASS');
    for (const change of [{ enabled: true }, { version: 3 }, { ticketDays: 91 }, { reportDays: 366 }, { appealDays: 366 }, { confirmedBy: subjectUserId }, { confirmedAt: new Date('2026-08-02T12:00:00.000Z') }]) {
      fake.query.mockImplementation(async text => text.includes('FROM public.retention_policies WHERE') ? { rows: [{ ...policy, confirmedAt: new Date(time), ...change }] } : response(text)); expect((await verify(p)).counts.POLICY_STATE_MISMATCH).toBe(1);
    }
  });
});
describe('conservative subject point-in-time evidence, not identities', () => {
  it.each(['member_levels', 'member_reputation', 'member_achievements'])('preexecution %s candidates with deletion receipt require replay', async table => {
    const p = payload(); p.subjectExecutionReceipts = [subject()]; fake.query.mockImplementation(async text => text.includes(`FROM public.${table} `) ? { rows: [{ total: '1', before: '1' }] } : response(text));
    const report = await verify(p); expect(report.counts.SUBJECT_ERASURE_REPLAY_REQUIRED).toBe(1); expect(report.checked).toBe(1);
  });
  it.each(['member_levels', 'member_reputation', 'member_achievements'])('postexecution %s is ambiguous, not false healthy', async table => {
    const p = payload(); p.subjectExecutionReceipts = [subject()]; fake.query.mockImplementation(async text => text.includes(`FROM public.${table} `) ? { rows: [{ total: '1', before: '0' }] } : response(text)); expect((await verify(p)).counts.AMBIGUOUS_REVIEW_REQUIRED).toBe(1);
  });
  it('reports both aggregate replay and event ambiguity for one obligation', async () => {
    const p = payload(); p.subjectExecutionReceipts = [subject()];
    fake.query.mockImplementation(async text => text.includes('FROM public.member_levels ') ? { rows: [{ total: '1', before: '1' }] } : text.includes('FROM public.event_participants ') ? { rows: [{ status: 'COMPLETED', pending: false, settled: true, total: '1', before: '1' }] } : response(text));
    const report = await verify(p); expect(report.checked).toBe(1); expect(report.counts.SUBJECT_ERASURE_REPLAY_REQUIRED).toBe(1); expect(report.counts.AMBIGUOUS_REVIEW_REQUIRED).toBe(1);
  });
  it('zero deletion count with survivor cannot prove replay or health', async () => {
    const p = payload(); p.subjectExecutionReceipts = [subject({ deletedMemberLevels: 0 })]; fake.query.mockImplementation(async text => text.includes('FROM public.member_levels ') ? { rows: [{ total: '1', before: '1' }] } : response(text)); expect((await verify(p)).counts.AMBIGUOUS_REVIEW_REQUIRED).toBe(1);
  });
  it.each(['event_participants', 'event_attendance'])('terminal settled preexecution %s remains ambiguous without row identities', async table => {
    const p = payload(); p.subjectExecutionReceipts = [subject()]; fake.query.mockImplementation(async text => text.includes(`FROM public.${table} `) ? { rows: [{ status: 'COMPLETED', pending: false, settled: true, total: '1', before: '1' }] } : response(text)); expect((await verify(p)).counts.AMBIGUOUS_REVIEW_REQUIRED).toBe(1);
    const sql = queries().join('\n'); expect(sql).toContain('INNER JOIN public.community_events e ON e.id = t.event_id'); expect(sql).toContain('e.guild_id = $1 AND t.user_id = $2'); expect(sql).not.toContain('marked_by'); expect(sql).not.toContain('reputation_grants'); expect(sql).toContain('e.updated_at <= $3::timestamptz');
  });
  it.each([
    { status: 'ACTIVE', pending: true, settled: false, expected: 'READY' },
    { status: 'SCHEDULED', pending: false, settled: true, expected: 'READY' },
    { status: 'CANCELLED', pending: true, settled: true, expected: 'AMBIGUOUS_REVIEW_REQUIRED' },
    { status: 'COMPLETED', pending: false, settled: false, expected: 'AMBIGUOUS_REVIEW_REQUIRED' },
    { status: 'UNKNOWN', pending: false, settled: true, expected: 'AMBIGUOUS_REVIEW_REQUIRED' },
  ])('classifies event state %j without deleting', async row => {
    const p = payload(); p.subjectExecutionReceipts = [subject()]; fake.query.mockImplementation(async text => text.includes('FROM public.event_participants ') ? { rows: [{ ...row, total: '1', before: '1' }] } : response(text)); const report = await verify(p); expect(report.counts[row.expected as keyof typeof report.counts]).toBe(1);
  });
  it.each([{ before: '0', deletedEventParticipants: 2 }, { before: '1', deletedEventParticipants: 0 }])('terminal newly eligible/count0 is ambiguous %j', async config => {
    const p = payload(); p.subjectExecutionReceipts = [subject({ deletedEventParticipants: config.deletedEventParticipants })]; fake.query.mockImplementation(async text => text.includes('FROM public.event_participants ') ? { rows: [{ status: 'COMPLETED', pending: false, settled: true, total: '1', before: config.before }] } : response(text)); expect((await verify(p)).counts.AMBIGUOUS_REVIEW_REQUIRED).toBe(1);
  });
  it.each([{ total: '-1', before: '0' }, { total: '1', before: '-1' }, { total: '1', before: '2' }, { total: '9007199254740992', before: '0' }])('bad observed counts never become healthy %j', async row => {
    const p = payload(); p.subjectExecutionReceipts = [subject()]; fake.query.mockImplementation(async text => text.includes('FROM public.member_levels ') ? { rows: [row] } : response(text)); expect((await verify(p)).counts.UNAVAILABLE).toBe(1);
  });
  it('missing eligible rows are ready and report omits all raw identities', async () => { const p = payload(); p.subjectExecutionReceipts = [subject()]; const report = await verify(p); expect(report.status).toBe('PASS'); expect(report.counts.READY).toBe(1); expect(JSON.stringify(report)).not.toContain(guildId); expect(JSON.stringify(report)).not.toContain(subjectUserId); });
});
