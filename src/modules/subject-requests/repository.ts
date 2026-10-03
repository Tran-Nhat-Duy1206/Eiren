import { sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { AppError } from '../../core/errors/errors.js';
import type { Actor, DenialCode, RequestStatus, SubjectRequestView, PreviewView, InventoryCount, ReceiptView, Category, Disposition } from './contracts.js';
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Pick<Database, 'execute'> | Pick<Tx, 'execute'>;
export const clock = sql`clock_timestamp()`;
export const key = (id: string) => { if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AppError('VALIDATION','Invalid privacy request identifier.'); };
export const owner = (actor: Actor) => { if (!actor.guildId || !actor.userId || actor.userId !== actor.guildOwnerId) throw new AppError('PERMISSION','Only the actual guild owner may confirm, execute or deny a privacy request.'); };
export const conflict = () => new AppError('CONFLICT','Privacy request state or inventory changed, or the preview expired. Check request status before retrying.');
const date = (v: unknown): string => new Date(v as string | Date).toISOString();
const nullableDate = (v: unknown): string | null => v == null ? null : date(v);
export function requestView(r: Record<string, unknown>): SubjectRequestView {
  return { id:String(r.id),guildId:String(r.guild_id),subjectUserId:String(r.subject_user_id),status:r.status as RequestStatus,version:Number(r.version),requestedAt:date(r.requested_at),subjectVerifiedAt:date(r.subject_verified_at),verificationMethod:'SELF_GUILD_MEMBER',previewedBy:r.previewed_by as string|null,previewedAt:nullableDate(r.previewed_at),confirmedBy:r.confirmed_by as string|null,confirmedAt:nullableDate(r.confirmed_at),confirmedPreviewId:r.confirmed_preview_id as string|null,executedAt:nullableDate(r.executed_at),deniedBy:r.denied_by as string|null,deniedAt:nullableDate(r.denied_at),denialCode:r.denial_code as DenialCode|null,terminalAt:nullableDate(r.terminal_at) };
}
export async function request(db: Executor, guildId: string, id: string, lock=false): Promise<SubjectRequestView> {
  key(id);
  const rows=await db.execute(sql`SELECT id,guild_id,subject_user_id,status,version,requested_at,subject_verified_at,verification_method,previewed_by,previewed_at,confirmed_by,confirmed_at,confirmed_preview_id,executed_at,denied_by,denied_at,denial_code,terminal_at FROM subject_requests WHERE guild_id=${guildId} AND id=${id} ${lock?sql`FOR UPDATE`:sql``}`);
  if(!rows.rows[0]) throw new AppError('NOT_FOUND','Privacy request not found in this guild.');
  return requestView(rows.rows[0]);
}
export async function preview(db: Executor, guildId:string, requestId:string, id:string, lock=false):Promise<PreviewView> {
  key(id);
  const result=await db.execute(sql`SELECT id,request_id,guild_id,subject_user_id,reviewed_by,request_version,inventory_hash,eligible_total,retained_total,created_at,expires_at,consumed_at FROM subject_request_previews WHERE guild_id=${guildId} AND request_id=${requestId} AND id=${id} ${lock?sql`FOR UPDATE`:sql``}`);
  const r=result.rows[0]; if(!r) throw conflict();
  const counts=await db.execute(sql`SELECT category,disposition,count FROM subject_request_preview_counts WHERE preview_id=${id} ORDER BY disposition,category`);
  return {id:String(r.id),requestId:String(r.request_id),guildId:String(r.guild_id),subjectUserId:String(r.subject_user_id),reviewedBy:String(r.reviewed_by),requestVersion:Number(r.request_version),hash:String(r.inventory_hash),eligibleTotal:Number(r.eligible_total),retainedTotal:Number(r.retained_total),createdAt:date(r.created_at),expiresAt:date(r.expires_at),consumedAt:nullableDate(r.consumed_at),counts:counts.rows.map(c=>({category:c.category as Category,disposition:c.disposition as Disposition,count:Number(c.count)}))};
}
export function receiptView(r:Record<string,unknown>):ReceiptView {
  return {requestId:String(r.request_id),guildId:String(r.guild_id),subjectUserId:String(r.subject_user_id),confirmedBy:String(r.confirmed_by),executedBy:String(r.executed_by),inventoryHash:String(r.inventory_hash),executedAt:date(r.executed_at),outcome:r.outcome as 'COMPLETED'|'PARTIAL',requestVersion:Number(r.request_version),deleted:{memberLevels:Number(r.deleted_member_levels),memberReputation:Number(r.deleted_member_reputation),achievements:Number(r.deleted_achievements),eventParticipants:Number(r.deleted_event_participants),eventAttendance:Number(r.deleted_event_attendance)},retainedTotal:Number(r.retained_total)};
}
export async function receipt(db:Executor,guildId:string,requestId:string):Promise<ReceiptView|null> {
  const result=await db.execute(sql`SELECT request_id,guild_id,subject_user_id,confirmed_by,executed_by,inventory_hash,executed_at,outcome,request_version,deleted_member_levels,deleted_member_reputation,deleted_achievements,deleted_event_participants,deleted_event_attendance,retained_total FROM subject_execution_receipts WHERE guild_id=${guildId} AND request_id=${requestId}`);
  return result.rows[0]?receiptView(result.rows[0]):null;
}
export async function bound(tx:Tx):Promise<void>{ await tx.execute(sql`SET LOCAL lock_timeout='2s'`); await tx.execute(sql`SET LOCAL statement_timeout='15s'`); }
export function countsEqual(a:InventoryCount[],b:InventoryCount[]):boolean {
  const canonical=(c:InventoryCount[])=>JSON.stringify([...c].sort((x,y)=>`${x.disposition}:${x.category}`.localeCompare(`${y.disposition}:${y.category}`)));
  return canonical(a)===canonical(b);
}
