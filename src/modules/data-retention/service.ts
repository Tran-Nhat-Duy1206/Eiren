import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { AppError } from '../../core/errors/errors.js';
import { DEFAULT_WINDOWS, assertOwner, assertRecord, validateWindows } from './contracts.js';
import type { Actor, RetentionDomain, RetentionHoldView, RetentionPolicyView, RetentionPreviewView, RetentionStatus, RetentionWindows } from './contracts.js';
import { clock, eligibleCounts, holdCounts } from './repository.js';
import type { Executor, RetentionTx } from './repository.js';

type PolicyRow = { enabled: boolean; ticket_retention_days: number; report_retention_days: number; appeal_retention_days: number; version: number; confirmed_by: string | null; confirmed_at: Date | null };
type PreviewRow = { id: string; guild_id: string; requested_by: string; ticket_days: number; report_days: number; appeal_days: number; eligible_ticket_count: number; eligible_report_count: number; eligible_appeal_count: number; base_version: number; created_at: Date; expires_at: Date };
const conflict = (message: string) => new AppError('CONFLICT', message);
const invalid = (message: string) => new AppError('VALIDATION', message);
function previewKey(value: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid('Invalid retention preview ID.');
}
function owner(actor: Actor) { try { assertOwner(actor); } catch { throw invalid('Only the guild owner can manage retention.'); } }
function windows(value: RetentionWindows) { try { validateWindows(value); } catch { throw invalid('Invalid retention windows.'); } }
const view = (row?: PolicyRow): RetentionPolicyView => ({ enabled: row?.enabled ?? false, ticketDays: row?.ticket_retention_days ?? DEFAULT_WINDOWS.ticketDays, reportDays: row?.report_retention_days ?? DEFAULT_WINDOWS.reportDays, appealDays: row?.appeal_retention_days ?? DEFAULT_WINDOWS.appealDays, version: row?.version ?? 0, confirmedBy: row?.confirmed_by ?? null, confirmedAt: row?.confirmed_at ?? null });
const previewView = (r: PreviewRow): RetentionPreviewView => ({ id: r.id, guildId: r.guild_id, requestedBy: r.requested_by, ticketDays: r.ticket_days, reportDays: r.report_days, appealDays: r.appeal_days, eligibleCounts: { ticket: r.eligible_ticket_count, report: r.eligible_report_count, appeal: r.eligible_appeal_count }, baseVersion: r.base_version, createdAt: r.created_at, expiresAt: r.expires_at });
async function policy(db: Executor, guildId: string, lock = false): Promise<PolicyRow | undefined> {
  const result = await db.execute(sql`SELECT enabled,ticket_retention_days,report_retention_days,appeal_retention_days,version,confirmed_by,confirmed_at FROM retention_policies WHERE guild_id = ${guildId} ${lock ? sql`FOR UPDATE` : sql``}`);
  return result.rows[0] as PolicyRow | undefined;
}
async function lockPolicy(tx: RetentionTx, guildId: string) {
  await tx.execute(sql`INSERT INTO retention_policies (guild_id) VALUES (${guildId}) ON CONFLICT (guild_id) DO NOTHING`);
  return (await policy(tx, guildId, true))!;
}
export class DataRetentionService {
  constructor(private readonly db: Database) {}
  async status(guildId: string): Promise<RetentionStatus> {
    const p = view(await policy(this.db, guildId));
    const [counts, holds, receipts, activeHolds] = await Promise.all([
      eligibleCounts(this.db, guildId, p), holdCounts(this.db, guildId),
      this.db.execute(sql`SELECT guild_id,domain,record_id,policy_version,redacted_at FROM retention_receipts WHERE guild_id = ${guildId} ORDER BY redacted_at DESC LIMIT 20`),
      this.db.execute(sql`SELECT domain,record_id,held_by,held_at FROM (
        SELECT 'TICKET' AS domain,id AS record_id,retention_hold_by AS held_by,retention_hold_at AS held_at FROM tickets WHERE guild_id = ${guildId} AND retention_hold = true
        UNION ALL SELECT 'REPORT',id,retention_hold_by,retention_hold_at FROM reports WHERE guild_id = ${guildId} AND retention_hold = true
        UNION ALL SELECT 'APPEAL',id,retention_hold_by,retention_hold_at FROM appeals WHERE guild_id = ${guildId} AND retention_hold = true
      ) AS holds ORDER BY held_at DESC NULLS LAST,domain,record_id LIMIT 50`),
    ]);
    return { policy: p, eligibleCounts: counts, holdCounts: holds, activeHolds: activeHolds.rows.map(r => ({ domain: r.domain as RetentionDomain, recordId: Number(r.record_id), heldBy: r.held_by as string | null, heldAt: r.held_at as Date | null })), recentReceipts: receipts.rows.map(r => ({ guildId: String(r.guild_id), domain: r.domain as RetentionDomain, recordId: Number(r.record_id), policyVersion: Number(r.policy_version), redactedAt: r.redacted_at as Date })) };
  }
  async preview(actor: Actor, proposed: RetentionWindows): Promise<RetentionPreviewView> {
    owner(actor); windows(proposed);
    return this.db.transaction(async tx => {
      const p = await lockPolicy(tx, actor.guildId);
      const counts = await eligibleCounts(tx, actor.guildId, proposed);
      const id = randomUUID();
      const result = await tx.execute(sql`INSERT INTO retention_previews (id,guild_id,requested_by,ticket_days,report_days,appeal_days,eligible_ticket_count,eligible_report_count,eligible_appeal_count,base_version,expires_at) VALUES (${id},${actor.guildId},${actor.userId},${proposed.ticketDays},${proposed.reportDays},${proposed.appealDays},${counts.ticket},${counts.report},${counts.appeal},${p.version},${clock} + interval '15 minutes') RETURNING *`);
      return previewView(result.rows[0] as PreviewRow);
    });
  }
  async getPreview(actor: Actor, previewId: string): Promise<RetentionPreviewView | null> {
    owner(actor); previewKey(previewId);
    const result = await this.db.execute(sql`SELECT * FROM retention_previews WHERE id = ${previewId} AND guild_id = ${actor.guildId} AND requested_by = ${actor.userId} AND consumed_at IS NULL AND expires_at > ${clock}`);
    return result.rows[0] ? previewView(result.rows[0] as PreviewRow) : null;
  }
  async confirm(actor: Actor, previewId: string): Promise<RetentionPolicyView & { previousEnabled: boolean }> {
    owner(actor); previewKey(previewId);
    return this.db.transaction(async tx => {
      const p = await lockPolicy(tx, actor.guildId);
      const result = await tx.execute(sql`SELECT * FROM retention_previews WHERE id = ${previewId} AND guild_id = ${actor.guildId} AND requested_by = ${actor.userId} FOR UPDATE`);
      const r = result.rows[0] as PreviewRow & { consumed_at: Date | null } | undefined;
      if (!r || r.consumed_at) throw conflict('Retention preview is unavailable.');
      const valid = await tx.execute(sql`SELECT ${r.expires_at} > ${clock} AS valid`);
      if (!valid.rows[0]?.valid || r.base_version !== p.version) throw conflict('Retention preview has expired or policy changed.');
      const counts = await eligibleCounts(tx, actor.guildId, { ticketDays: r.ticket_days, reportDays: r.report_days, appealDays: r.appeal_days });
      if (counts.ticket !== r.eligible_ticket_count || counts.report !== r.eligible_report_count || counts.appeal !== r.eligible_appeal_count) throw conflict('Retention eligibility changed; create a new preview.');
      await tx.execute(sql`UPDATE retention_policies SET enabled = true,ticket_retention_days = ${r.ticket_days},report_retention_days = ${r.report_days},appeal_retention_days = ${r.appeal_days},version = version + 1,confirmed_by = ${actor.userId},confirmed_at = ${clock},updated_at = ${clock} WHERE guild_id = ${actor.guildId}`);
      await tx.execute(sql`UPDATE retention_previews SET consumed_at = ${clock} WHERE id = ${r.id}`);
      return { ...view(await policy(tx, actor.guildId)), previousEnabled: p.enabled };
    });
  }
  async disable(actor: Actor): Promise<RetentionPolicyView> {
    owner(actor);
    return this.db.transaction(async tx => {
      await lockPolicy(tx, actor.guildId);
      await tx.execute(sql`UPDATE retention_policies SET enabled = false,version = version + 1,updated_at = ${clock} WHERE guild_id = ${actor.guildId}`);
      return view(await policy(tx, actor.guildId));
    });
  }
  private async hold(actor: Actor, domain: RetentionDomain, recordId: number, enabled: boolean): Promise<RetentionHoldView> {
    owner(actor);
    try { assertRecord(domain, recordId); } catch { throw invalid('Invalid retention record.'); }
    const table = domain === 'TICKET' ? sql`tickets` : domain === 'REPORT' ? sql`reports` : sql`appeals`;
    const marker = domain === 'TICKET' ? sql`transcript_redacted_at` : sql`narrative_redacted_at`;
    return this.db.transaction(async tx => {
      await lockPolicy(tx, actor.guildId);
      const result = await tx.execute(sql`SELECT retention_hold,retention_hold_by,retention_hold_at,${marker} AS redacted_at FROM ${table} WHERE guild_id = ${actor.guildId} AND id = ${recordId} FOR UPDATE`);
      const row = result.rows[0];
      if (!row) throw invalid('Retention record not found in this guild.');
      if (enabled && row.redacted_at) throw conflict('Already redacted; a hold cannot restore private content.');
      if (row.retention_hold !== enabled) {
        await tx.execute(sql`UPDATE ${table} SET retention_hold = ${enabled}, retention_hold_by = ${enabled ? actor.userId : null}, retention_hold_at = ${enabled ? clock : sql`NULL`} WHERE guild_id = ${actor.guildId} AND id = ${recordId}`);
      }
      const changed = row.retention_hold !== enabled;
      return { domain, recordId, retentionHold: enabled, retentionHoldBy: changed ? (enabled ? actor.userId : null) : row.retention_hold_by as string | null, retentionHoldAt: changed ? (enabled ? (await tx.execute(sql`SELECT retention_hold_at FROM ${table} WHERE guild_id = ${actor.guildId} AND id = ${recordId}`)).rows[0]?.retention_hold_at as Date : null) : row.retention_hold_at as Date | null };
    });
  }
  setHold(actor: Actor, domain: RetentionDomain, recordId: number) { return this.hold(actor, domain, recordId, true); }
  clearHold(actor: Actor, domain: RetentionDomain, recordId: number) { return this.hold(actor, domain, recordId, false); }
}
