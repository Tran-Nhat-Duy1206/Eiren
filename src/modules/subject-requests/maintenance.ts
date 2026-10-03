import { sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { bound } from './repository.js';
/** Metadata cleanup only. Never confirms or executes a privacy request. */
export async function runSubjectRequestMaintenance(db:Database){
  return db.transaction(async tx=>{
    await bound(tx);
    const previews=await tx.execute(sql`DELETE FROM subject_request_previews WHERE id IN (SELECT id FROM (
      (SELECT id FROM subject_request_previews WHERE expires_at < statement_timestamp()-interval '24 hours' ORDER BY expires_at LIMIT 500)
      UNION (SELECT id FROM subject_request_previews WHERE consumed_at < statement_timestamp()-interval '24 hours' ORDER BY consumed_at LIMIT 500)
    ) expired LIMIT 500) RETURNING id`);
    // At most 250 parent rows + 250 execution receipts, together <=500.
    // Cascades remove their own preview/count bookkeeping, never product-domain rows.
    const receipts=await tx.execute(sql`SELECT request_id FROM subject_execution_receipts WHERE request_id IN (
      SELECT r.id FROM subject_requests r WHERE r.status IN ('COMPLETED','PARTIAL','DENIED') AND r.terminal_at < statement_timestamp()-interval '730 days'
      AND NOT EXISTS (SELECT 1 FROM subject_execution_receipts s WHERE s.request_id=r.id AND s.executed_at >= statement_timestamp()-interval '730 days')
      AND NOT EXISTS (SELECT 1 FROM subject_request_previews p WHERE p.request_id=r.id)
      ORDER BY r.terminal_at,r.id LIMIT 250) FOR UPDATE`);
    const requests=await tx.execute(sql`DELETE FROM subject_requests WHERE id IN (SELECT r.id FROM subject_requests r
      WHERE r.status IN ('COMPLETED','PARTIAL','DENIED') AND r.terminal_at < statement_timestamp()-interval '730 days'
      AND NOT EXISTS (SELECT 1 FROM subject_execution_receipts s WHERE s.request_id=r.id AND s.executed_at >= statement_timestamp()-interval '730 days')
      AND NOT EXISTS (SELECT 1 FROM subject_request_previews p WHERE p.request_id=r.id)
      ORDER BY r.terminal_at,r.id LIMIT 250) RETURNING id`);
    const gaps=await tx.execute(sql`DELETE FROM governance_audit_gaps WHERE id IN (SELECT id FROM governance_audit_gaps WHERE detected_at < statement_timestamp()-interval '730 days' ORDER BY detected_at,id LIMIT 500) RETURNING id`);
    return {previewsPruned:previews.rowCount??0,requestsPruned:requests.rowCount??0,receiptsPruned:receipts.rowCount??0,auditGapsPruned:gaps.rowCount??0};
  },{isolationLevel:'serializable'});
}
