import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EXPECTED_LATEST_MIGRATION_TAG, EXPECTED_MIGRATION_COUNT } from '../operations/migration-descriptor.js';

export class RecoveryError extends Error {
  constructor(readonly code: 'MANIFEST_INVALID' | 'MIGRATION_MISMATCH' | 'UNAVAILABLE') { super(code); this.name = 'RecoveryError'; }
}
const id = z.string().regex(/^[0-9]{17,20}$/);
const utc = z.string().refine(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/(\.\d{3})\d{3}Z$/, '$1Z'));
const integer = z.number().int().min(0).max(2147483647);
const recordId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n);
const domain = z.enum(['TICKET', 'REPORT', 'APPEAL']);
const receipt = z.object({ guildId: id, domain, recordId, policyVersion: integer, policyAuthorizerId: id, redactedAt: utc }).strict();
const hold = z.object({ guildId: id, domain, recordId, heldBy: id, heldAt: utc }).strict();
const policy = z.object({ guildId: id, enabled: z.boolean(), ticketDays: z.number().int().min(30).max(365), reportDays: z.number().int().min(90).max(730), appealDays: z.number().int().min(90).max(730), version: integer, confirmedBy: id.nullable(), confirmedAt: utc.nullable() }).strict().refine(p => (p.confirmedBy === null) === (p.confirmedAt === null) && (!p.enabled || p.confirmedBy !== null));
const subject = z.object({ requestId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/), guildId: id, subjectUserId: id, executedAt: utc, outcome: z.enum(['COMPLETED', 'PARTIAL']), requestVersion: integer, deletedMemberLevels: integer.max(1), deletedMemberReputation: integer.max(1), deletedAchievements: integer, deletedEventParticipants: integer, deletedEventAttendance: integer, retainedTotal: integer }).strict().refine(r => r.outcome === 'COMPLETED' ? r.retainedTotal === 0 : r.retainedTotal > 0);
export const MAX_MANIFEST_ROWS = 100000;
const payloadSchema = z.object({ version: z.literal(1), generatedAt: utc, migrationCount: z.literal(EXPECTED_MIGRATION_COUNT), latestMigrationTag: z.literal(EXPECTED_LATEST_MIGRATION_TAG), schemaMarker: z.literal('repo/eiren-v8.6'), retentionReceipts: z.array(receipt).max(MAX_MANIFEST_ROWS), activeHolds: z.array(hold).max(MAX_MANIFEST_ROWS), retentionPolicies: z.array(policy).max(MAX_MANIFEST_ROWS), subjectExecutionReceipts: z.array(subject).max(MAX_MANIFEST_ROWS) }).strict();
const manifestSchema = payloadSchema.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) });
export type RecoveryManifestPayload = z.infer<typeof payloadSchema>;
export type RecoveryManifest = z.infer<typeof manifestSchema>;
export type RetentionReceipt = RecoveryManifest['retentionReceipts'][number];
export type ActiveHold = RecoveryManifest['activeHolds'][number];
export type RetentionPolicy = RecoveryManifest['retentionPolicies'][number];
export type SubjectExecutionReceipt = RecoveryManifest['subjectExecutionReceipts'][number];
function deepSorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSorted);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, deepSorted(item)]));
  return value;
}
export function canonicalJson(value: unknown): string { return JSON.stringify(deepSorted(value)); }
const targetKey = (r: { guildId: string; domain: string; recordId: string }) => `${r.guildId}/${r.domain}/${r.recordId}`;
function normalize(payload: RecoveryManifestPayload): RecoveryManifestPayload {
  const sort = <T>(rows: T[], key: (r: T) => string): T[] => {
    const seen = new Set<string>();
    for (const row of rows) { const identity = key(row); if (seen.has(identity)) throw new RecoveryError('MANIFEST_INVALID'); seen.add(identity); }
    return [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  };
  const retentionReceipts = sort(payload.retentionReceipts, targetKey);
  const activeHolds = sort(payload.activeHolds, targetKey);
  return { ...payload, retentionReceipts, activeHolds, retentionPolicies: sort(payload.retentionPolicies, r => r.guildId), subjectExecutionReceipts: sort(payload.subjectExecutionReceipts, r => r.requestId) };
}
export function createRecoveryManifest(value: RecoveryManifestPayload): RecoveryManifest {
  try {
    const payload = normalize(payloadSchema.parse(value));
    return { ...payload, digest: createHash('sha256').update(canonicalJson(payload)).digest('hex') };
  } catch { throw new RecoveryError('MANIFEST_INVALID'); }
}
// JSON.parse alone silently accepts duplicate object keys. Reject differential
// interpretations before trusting the canonical payload, including escaped key aliases.
function rejectDuplicateJsonKeys(text: string): void {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) || [];
  let cursor = 0;
  const value = (depth: number): void => {
    if (depth > 32) throw new RecoveryError('MANIFEST_INVALID');
    const token = tokens[cursor++];
    if (token === '{') {
      const keys = new Set<string>();
      if (tokens[cursor] === '}') { cursor++; return; }
      do {
        const key = JSON.parse(tokens[cursor++]!);
        if (keys.has(key)) throw new RecoveryError('MANIFEST_INVALID');
        keys.add(key); cursor++; value(depth + 1);
        if (tokens[cursor] === '}') { cursor++; return; }
        cursor++; // comma; JSON.parse has already validated the grammar.
      } while (cursor < tokens.length);
    } else if (token === '[') {
      if (tokens[cursor] === ']') { cursor++; return; }
      do {
        value(depth + 1);
        if (tokens[cursor] === ']') { cursor++; return; }
        cursor++;
      } while (cursor < tokens.length);
    }
  };
  value(0);
}
export function parseRecoveryManifest(text: string): RecoveryManifest {
  try {
    if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new RecoveryError('MANIFEST_INVALID');
    const raw: unknown = JSON.parse(text);
    rejectDuplicateJsonKeys(text);
    const parsed = manifestSchema.parse(raw);
    const { digest, ...payload } = parsed;
    const result = createRecoveryManifest(payload);
    if (result.digest !== digest) throw new RecoveryError('MANIFEST_INVALID');
    return result;
  } catch { throw new RecoveryError('MANIFEST_INVALID'); }
}
export function canonicalManifestText(manifest: RecoveryManifest): string {
  return canonicalJson(parseRecoveryManifest(JSON.stringify(manifest))) + '\n';
}
