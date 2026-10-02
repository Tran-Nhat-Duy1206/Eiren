import { sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import type { RetentionDomain } from './contracts.js';
import { clock } from './repository.js';
import type { RetentionTx } from './repository.js';

const domains: RetentionDomain[] = ['TICKET', 'REPORT', 'APPEAL'];
// Five tenants x twenty candidates per domain preserve the global 100 bound.
// Advance only across this serviceable window, so a busy early tenant cannot
// consume a later tenant's turn. The next pass continues the keyset rotation.
const TENANTS_PER_PASS = 5;
const RECORDS_PER_TENANT = 20;
let lastGuildId = '';
const source = (domain: RetentionDomain) => domain === 'TICKET' ? sql`tickets` : domain === 'REPORT' ? sql`reports` : sql`appeals`;
const days = (domain: RetentionDomain) => domain === 'TICKET' ? sql`p.ticket_retention_days` : domain === 'REPORT' ? sql`p.report_retention_days` : sql`p.appeal_retention_days`;
const payload = (domain: RetentionDomain) => domain === 'TICKET' ? sql`transcript` : domain === 'REPORT' ? sql`description` : sql`reason`;
const marker = (domain: RetentionDomain) => domain === 'TICKET' ? sql`transcript_redacted_at` : sql`narrative_redacted_at`;
const version = (domain: RetentionDomain) => domain === 'TICKET' ? sql`transcript_retention_policy_version` : sql`narrative_retention_policy_version`;
export const supplementaryRedaction = (domain: RetentionDomain) => domain === 'REPORT' ? sql`,evidence_url = NULL,resolution_note = NULL` : domain === 'APPEAL' ? sql`,review_note = NULL` : sql``;
const deadline = (domain: RetentionDomain) => domain === 'APPEAL' ? sql`reviewed_at` : sql`closed_at`;
const state = (domain: RetentionDomain) => domain === 'APPEAL' ? sql`status IN ('ACCEPTED','REJECTED')` : sql`status = 'CLOSED'`;

async function boundQueries(tx: RetentionTx): Promise<void> {
  // A stuck owner/DDL transaction must fail this isolated scheduler stage rather
  // than keeping the scheduler's active promise pending forever.
  await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
  await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
}
async function boundedExecute(db: Database, query: ReturnType<typeof sql>) {
  return db.transaction(async tx => {
    await boundQueries(tx);
    return tx.execute(query);
  });
}

/** Bounded one-pass maintenance: only policy-authorized private text is removed. */
export async function runRetentionMaintenance(db: Database): Promise<{ ticket: number; report: number; appeal: number; receiptsPruned: number; previewsPruned: number }> {
  const totals = { ticket: 0, report: 0, appeal: 0, receiptsPruned: 0, previewsPruned: 0 };
  let policies = await boundedExecute(db, sql`SELECT guild_id,version,ticket_retention_days,report_retention_days,appeal_retention_days FROM retention_policies WHERE enabled AND guild_id > ${lastGuildId} ORDER BY guild_id LIMIT ${TENANTS_PER_PASS}`);
  if (!policies.rows.length && lastGuildId) {
    lastGuildId = '';
    policies = await boundedExecute(db, sql`SELECT guild_id,version,ticket_retention_days,report_retention_days,appeal_retention_days FROM retention_policies WHERE enabled ORDER BY guild_id LIMIT ${TENANTS_PER_PASS}`);
  }
  if (policies.rows.length) lastGuildId = String(policies.rows[policies.rows.length - 1]!.guild_id);
  for (const domain of domains) {
    const table = source(domain), column = payload(domain), redacted = marker(domain), timestamp = deadline(domain), policyDays = days(domain), closed = state(domain);
    let remaining = 100;
    for (const tenant of policies.rows) {
      if (!remaining) break;
      const tenantGuildId = String(tenant.guild_id);
      const retentionDays = Number(domain === 'TICKET' ? tenant.ticket_retention_days : domain === 'REPORT' ? tenant.report_retention_days : tenant.appeal_retention_days);
      const candidates = await boundedExecute(db, sql`SELECT guild_id,id,${Number(tenant.version)}::int AS version FROM ${table} WHERE guild_id = ${tenantGuildId} AND retention_hold = false AND ${column} IS NOT NULL AND ${redacted} IS NULL AND ${closed} AND ${timestamp} <= statement_timestamp() - (${retentionDays} * interval '1 day') ORDER BY ${timestamp},id LIMIT ${Math.min(remaining, RECORDS_PER_TENANT)}`);
      remaining -= candidates.rows.length;
      for (const candidate of candidates.rows) {
      const guildId = String(candidate.guild_id), recordId = Number(candidate.id), baseVersion = Number(candidate.version);
      const applied = await db.transaction(async tx => {
        await boundQueries(tx);
        // Serialize policy changes before locking the payload row (same order as owner actions).
        const lockedPolicy = await tx.execute(sql`SELECT enabled,version,confirmed_by,${policyDays} AS retention_days FROM retention_policies p WHERE guild_id = ${guildId} FOR UPDATE`);
        const p = lockedPolicy.rows[0];
        if (!p || !p.enabled || !p.confirmed_by || Number(p.version) !== baseVersion) return false;
        const target = await tx.execute(sql`SELECT id FROM ${table} WHERE guild_id = ${guildId} AND id = ${recordId} FOR UPDATE`);
        if (!target.rows.length) return false;
        const eligible = await tx.execute(sql`SELECT id FROM ${table} WHERE guild_id = ${guildId} AND id = ${recordId} AND retention_hold = false AND ${column} IS NOT NULL AND ${redacted} IS NULL AND ${closed} AND ${timestamp} <= ${clock} - (${Number(p.retention_days)} * interval '1 day')`);
        if (!eligible.rows.length) return false;
        const updated = await tx.execute(sql`UPDATE ${table} SET ${column} = NULL${supplementaryRedaction(domain)},${redacted} = ${clock},${version(domain)} = ${Number(p.version)} WHERE guild_id = ${guildId} AND id = ${recordId} AND ${redacted} IS NULL RETURNING ${redacted} AS redacted_at`);
        if (!updated.rows.length) return false;
        await tx.execute(sql`INSERT INTO retention_receipts (guild_id,domain,record_id,policy_version,policy_authorizer_id,redacted_at) VALUES (${guildId},${domain},${recordId},${Number(p.version)},${String(p.confirmed_by)},${updated.rows[0]!.redacted_at as Date})`);
        return true;
      });
      if (applied) totals[domain.toLowerCase() as 'ticket' | 'report' | 'appeal']++;
      }
    }
  }
  const receipts = await boundedExecute(db, sql`DELETE FROM retention_receipts WHERE ctid IN (SELECT ctid FROM retention_receipts WHERE redacted_at < statement_timestamp() - interval '730 days' ORDER BY redacted_at LIMIT 500) RETURNING 1`);
  const previews = await boundedExecute(db, sql`DELETE FROM retention_previews WHERE ctid IN (
    SELECT ctid FROM (
      (SELECT ctid FROM retention_previews WHERE expires_at < statement_timestamp() - interval '24 hours' ORDER BY expires_at LIMIT 500)
      UNION
      (SELECT ctid FROM retention_previews WHERE consumed_at < statement_timestamp() - interval '24 hours' ORDER BY consumed_at LIMIT 500)
    ) AS expired_or_consumed LIMIT 500
  ) RETURNING 1`);
  totals.receiptsPruned = receipts.rowCount ?? 0;
  totals.previewsPruned = previews.rowCount ?? 0;
  return totals;
}
