import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalManifestText, createRecoveryManifest, parseRecoveryManifest, RecoveryError, type RecoveryManifestPayload } from './manifest.js';

const guildId = '12345678901234567';
const actor = '12345678901234567890';
const utc = '2026-06-01T12:34:56.123456Z';
function fixture(): RecoveryManifestPayload {
  return {
    version: 1, generatedAt: '2026-06-01T12:34:56.123Z', migrationCount: 21,
    latestMigrationTag: '0020_subject_request_governance', schemaMarker: 'repo/eiren-v8.6',
    retentionReceipts: [{ guildId, domain: 'TICKET', recordId: '9223372036854775807', policyVersion: 0, policyAuthorizerId: actor, redactedAt: utc }],
    activeHolds: [{ guildId, domain: 'REPORT', recordId: '1', heldBy: actor, heldAt: utc }],
    retentionPolicies: [{ guildId, enabled: true, ticketDays: 30, reportDays: 90, appealDays: 730, version: 0, confirmedBy: actor, confirmedAt: utc }],
    subjectExecutionReceipts: [{ requestId: '01234567-89ab-cdef-0123-456789abcdef', guildId, subjectUserId: actor, executedAt: utc, outcome: 'COMPLETED', requestVersion: 0, deletedMemberLevels: 1, deletedMemberReputation: 0, deletedAchievements: 2147483647, deletedEventParticipants: 1, deletedEventAttendance: 0, retainedTotal: 0 }],
  };
}
function invalid(value: unknown) {
  try { createRecoveryManifest(value as RecoveryManifestPayload); throw new Error('Expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(RecoveryError); expect((error as Error).message).toBe('MANIFEST_INVALID'); }
}

describe('recovery manifest', () => {
  it('round-trips typed fixtures and canonical text with one LF', () => {
    const manifest = createRecoveryManifest(fixture());
    const text = canonicalManifestText(manifest);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(parseRecoveryManifest(text)).toEqual(manifest);
    expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('deep-sorts keys without changing array order', () => {
    expect(canonicalJson({ z: [{ b: 2, a: { d: 4, c: 3 } }, 1], a: 0 }))
      .toBe('{"a":0,"z":[{"a":{"c":3,"d":4},"b":2},1]}');
  });
  it('canonicalizes all row collections and input key order equally', () => {
    const value = fixture();
    value.retentionReceipts.push({ ...value.retentionReceipts[0]!, recordId: '2' });
    value.activeHolds.push({ ...value.activeHolds[0]!, recordId: '2' });
    value.retentionPolicies.push({ ...value.retentionPolicies[0]!, guildId: actor });
    value.subjectExecutionReceipts.push({ ...value.subjectExecutionReceipts[0]!, requestId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
    const first = createRecoveryManifest(value);
    for (const rows of [value.retentionReceipts, value.activeHolds, value.retentionPolicies, value.subjectExecutionReceipts]) rows.reverse();
    const reversedKeys = Object.fromEntries(Object.entries(value).reverse()) as RecoveryManifestPayload;
    expect(canonicalManifestText(createRecoveryManifest(reversedKeys))).toBe(canonicalManifestText(first));
    const shuffledManifest = { ...reversedKeys, digest: first.digest };
    expect(parseRecoveryManifest(JSON.stringify(shuffledManifest))).toEqual(first);
  });
  it('rejects payload and digest tampering with fixed errors', () => {
    const manifest = createRecoveryManifest(fixture());
    for (const text of [JSON.stringify({ ...manifest, generatedAt: '2026-06-02T12:34:56.123Z' }), JSON.stringify({ ...manifest, digest: '0'.repeat(64) }), '{private-secret', JSON.stringify({ ...manifest, privateSecret: 'DO_NOT_LEAK' })]) {
      expect(() => parseRecoveryManifest(text)).toThrowError('MANIFEST_INVALID');
    }
  });
  it.each(['retentionReceipts', 'activeHolds', 'retentionPolicies', 'subjectExecutionReceipts'] as const)('rejects duplicate %s identities and private nested fields', (key) => {
    const duplicate = fixture();
    (duplicate[key] as unknown[]).push({ ...duplicate[key][0]! });
    invalid(duplicate);
    const nested = fixture();
    Object.assign(nested[key][0]!, { transcript: 'DO_NOT_LEAK' });
    invalid(nested);
  });
  it('rejects unknown root fields', () => invalid({ ...fixture(), narrative: 'DO_NOT_LEAK' }));
  it.each(['0', '-1', '01', '1.0', '9223372036854775808', '99999999999999999999'])('rejects nonpositive/noncanonical/out-of-bigint record ID %s', (recordId) => {
    const value = fixture(); value.retentionReceipts[0]!.recordId = recordId; invalid(value);
  });
  it.each([-1, 0.5, 2147483648, NaN, Infinity])('rejects invalid count/version %s', (count) => {
    const value = fixture(); value.subjectExecutionReceipts[0]!.deletedAchievements = count; invalid(value);
    const policy = fixture(); policy.retentionPolicies[0]!.version = count; invalid(policy);
  });
  it('checks single member counts and outcome/retained combinations', () => {
    const value = fixture(); value.subjectExecutionReceipts[0]!.deletedMemberLevels = 2; invalid(value);
    const completed = fixture(); completed.subjectExecutionReceipts[0]!.retainedTotal = 1; invalid(completed);
    const partial = fixture(); partial.subjectExecutionReceipts[0]!.outcome = 'PARTIAL'; invalid(partial);
    partial.subjectExecutionReceipts[0]!.retainedTotal = 1; expect(() => createRecoveryManifest(partial)).not.toThrow();
  });
  it.each(['1234567890123456', '123456789012345678901', '1234567890123456x'])('rejects invalid actor IDs %s', (id) => {
    const value = fixture(); value.retentionReceipts[0]!.policyAuthorizerId = id; invalid(value);
  });
  it('rejects invalid domain, status, UUID and descriptor', () => {
    const domain = fixture(); Object.assign(domain.activeHolds[0]!, { domain: 'PRIVATE' }); invalid(domain);
    const status = fixture(); Object.assign(status.subjectExecutionReceipts[0]!, { outcome: 'EXECUTING' }); invalid(status);
    const uuid = fixture(); uuid.subjectExecutionReceipts[0]!.requestId = 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'; invalid(uuid);
    invalid({ ...fixture(), migrationCount: 20 }); invalid({ ...fixture(), schemaMarker: 'other' });
  });
  it.each(['2026-02-30T12:34:56.123Z', '2026-06-01T25:34:56.123Z', '2026-06-01T12:34:56Z', '2026-06-01T12:34:56.1234Z', '2026-06-01T12:34:56.1234567Z', '2026-06-01T12:34:56.123456+00:00', '2026-06-01T12:34:56.12345xZ'])('rejects invalid UTC timestamp %s', (timestamp) => {
    const value = fixture(); value.generatedAt = timestamp; invalid(value);
  });
  it.each(['ticketDays', 'reportDays', 'appealDays'] as const)('validates %s windows', (key) => {
    for (const days of [key === 'ticketDays' ? 29 : 89, key === 'ticketDays' ? 366 : 731, 90.5]) {
      const value = fixture(); value.retentionPolicies[0]![key] = days; invalid(value);
    }
  });
  it('validates policy confirmation pairs, allowing disabled unconfirmed policies', () => {
    const value = fixture(); value.retentionPolicies[0]!.confirmedBy = null; invalid(value);
    value.retentionPolicies[0]!.confirmedAt = null; invalid(value);
    value.retentionPolicies[0]!.enabled = false; expect(() => createRecoveryManifest(value)).not.toThrow();
  });
  it('accepts overlapping receipt and hold targets for later governance reconciliation', () => {
    const value = fixture(); value.activeHolds[0]!.domain = 'TICKET'; value.activeHolds[0]!.recordId = value.retentionReceipts[0]!.recordId;
    expect(() => createRecoveryManifest(value)).not.toThrow();
  });
});
