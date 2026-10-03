import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import type { PermissionService } from '../../core/permissions/permission-service.js';
import { AppError } from '../../core/errors/errors.js';
import { collectInventory } from './inventory.js';
import { DENIAL_CODES, GOVERNANCE_ACTIONS, WORKFLOW_EVIDENCE_WARNING } from './contracts.js';
import type { Actor, SelfInteraction, DenialCode, PreviewView, InventorySummary, InventoryContext, AuditGapInput, AuditGapView, DeletedCounts } from './contracts.js';
import { request, requestView, preview, receipt, receiptView, bound, clock, key, owner, conflict, countsEqual } from './repository.js';
import type { Executor, Tx } from './repository.js';
const summary = (i: InventorySummary): InventorySummary => ({counts:i.counts,eligibleTotal:i.eligibleTotal,retainedTotal:i.retainedTotal,hash:i.hash});
const context = (r:{id:string;guildId:string;subjectUserId:string},version:number):InventoryContext => ({requestId:r.id,guildId:r.guildId,subjectUserId:r.subjectUserId,requestVersion:version});
const terminal = (s:string) => ['COMPLETED','PARTIAL','DENIED'].includes(s);
const date = (v:unknown) => new Date(v as string|Date).toISOString();
export class SubjectRequestService {
  constructor(private readonly db:Database,private readonly permissions:Pick<PermissionService,'require'>) {}
  private review(actor:Actor){return this.permissions.require(actor,'ADMIN');}
  private async transaction<T>(action:(tx:Tx)=>Promise<T>,serializable=false):Promise<T>{
    try {return await this.db.transaction(action,serializable?{isolationLevel:'serializable'}:undefined);} catch(error){
      if(error instanceof AppError) throw error;
      let cause:unknown=error;
      for(let depth=0;depth<4&&typeof cause==='object'&&cause!==null;depth++){
        const code='code' in cause?String(cause.code):'';
        if(['40001','40P01','55P03','57014'].includes(code)) throw conflict();
        cause='cause' in cause?cause.cause:null;
      }
      throw new AppError('DATABASE','Privacy data operation failed safely; check request status before retrying.');
    }
  }
  async createSelfRequest(interaction:SelfInteraction) {
    if(!interaction.inGuild() || !interaction.guildId || !interaction.guild || interaction.guild.id!==interaction.guildId || !/^[0-9]{17,20}$/.test(interaction.user.id)) throw new AppError('VALIDATION','Privacy requests require your authenticated guild interaction.');
    let member;
    try {member=await interaction.guild.members.fetch({user:interaction.user.id,force:true});} catch {throw new AppError('PERMISSION','Current guild membership could not be verified.');}
    if(member.id!==interaction.user.id || member.guild.id!==interaction.guildId) throw new AppError('PERMISSION','Current guild membership could not be verified.');
    const guildId=interaction.guildId,subject=interaction.user.id;
    return this.transaction(async tx=>{
      await bound(tx);
      await tx.execute(sql`INSERT INTO subject_requests (id,guild_id,subject_user_id,subject_verified_at) VALUES (${randomUUID()},${guildId},${subject},${clock}) ON CONFLICT (guild_id,subject_user_id) WHERE status IN ('PENDING','PREVIEWED','CONFIRMED','EXECUTING') DO NOTHING`);
      const rows=await tx.execute(sql`SELECT id FROM subject_requests WHERE guild_id=${guildId} AND subject_user_id=${subject} AND status IN ('PENDING','PREVIEWED','CONFIRMED','EXECUTING') ORDER BY requested_at DESC,id LIMIT 1`);
      if(!rows.rows[0]) throw conflict();
      return request(tx,guildId,String(rows.rows[0].id));
    });
  }
  async ownStatus(caller:{guildId:string;userId:string}) {
    const rows=await this.db.execute(sql`SELECT id FROM subject_requests WHERE guild_id=${caller.guildId} AND subject_user_id=${caller.userId} ORDER BY (status IN ('PENDING','PREVIEWED','CONFIRMED','EXECUTING')) DESC,requested_at DESC,id DESC LIMIT 1`);
    return rows.rows[0]?request(this.db,caller.guildId,String(rows.rows[0].id)):null;
  }
  async list(actor:Actor){await this.review(actor); const rows=await this.db.execute(sql`SELECT id FROM subject_requests WHERE guild_id=${actor.guildId} ORDER BY requested_at DESC,id DESC LIMIT 50`); return Promise.all(rows.rows.map(r=>request(this.db,actor.guildId,String(r.id))));}
  async recentReceipts(actor:Actor){await this.review(actor); const rows=await this.db.execute(sql`SELECT request_id,guild_id,subject_user_id,confirmed_by,executed_by,inventory_hash,executed_at,outcome,request_version,deleted_member_levels,deleted_member_reputation,deleted_achievements,deleted_event_participants,deleted_event_attendance,retained_total FROM subject_execution_receipts WHERE guild_id=${actor.guildId} ORDER BY executed_at DESC,request_id LIMIT 50`);return rows.rows.map(receiptView);}
  async inspect(actor:Actor,id:string){
    await this.review(actor);
    const r=await request(this.db,actor.guildId,id);
    const rows=await this.db.execute(sql`SELECT id FROM subject_request_previews WHERE guild_id=${actor.guildId} AND request_id=${id} ORDER BY created_at DESC,id DESC LIMIT 1`);
    const p=rows.rows[0]?await preview(this.db,actor.guildId,id,String(rows.rows[0].id)):null;
    const i=await collectInventory(this.db,context(r,p?.requestVersion??r.version));
    const gaps=await this.db.execute(sql`SELECT id,actor_user_id,action,target_type,target_id,committed_at,detected_at FROM governance_audit_gaps WHERE guild_id=${actor.guildId} AND target_id=${id} AND action IN ('privacy-preview','privacy-confirm','privacy-execute','privacy-deny') AND target_type=action ORDER BY detected_at DESC,id LIMIT 50`);
    return {request:r,inventory:summary(i),preview:p,receipt:await receipt(this.db,actor.guildId,id),workflowEvidence:WORKFLOW_EVIDENCE_WARNING,auditGaps:gaps.rows.map(g=>({id:String(g.id),actorUserId:String(g.actor_user_id),action:g.action,targetType:String(g.target_type),targetId:g.target_id as string|null,committedAt:date(g.committed_at),detectedAt:date(g.detected_at)} as AuditGapView))};
  }
  async preview(actor:Actor,id:string):Promise<PreviewView>{
    await this.review(actor);
    return this.transaction(async tx=>{
      await bound(tx); const r=await request(tx,actor.guildId,id,true); if(terminal(r.status)||r.status==='EXECUTING') throw conflict();
      const version=r.version+1;
      const inventory=await collectInventory(tx,context(r,version));
      await tx.execute(sql`UPDATE subject_request_previews SET consumed_at=${clock} WHERE guild_id=${actor.guildId} AND request_id=${id} AND consumed_at IS NULL`);
      await tx.execute(sql`UPDATE subject_requests SET status='PREVIEWED',version=${version},previewed_by=${actor.userId},previewed_at=${clock},confirmed_by=NULL,confirmed_at=NULL,confirmed_preview_id=NULL WHERE guild_id=${actor.guildId} AND id=${id}`);
      const previewId=randomUUID();
      await tx.execute(sql`INSERT INTO subject_request_previews (id,request_id,guild_id,subject_user_id,reviewed_by,request_version,inventory_hash,eligible_total,retained_total,expires_at) VALUES (${previewId},${id},${actor.guildId},${r.subjectUserId},${actor.userId},${version},${inventory.hash},${inventory.eligibleTotal},${inventory.retainedTotal},${clock}+interval '15 minutes')`);
      for(const count of inventory.counts) await tx.execute(sql`INSERT INTO subject_request_preview_counts (preview_id,disposition,category,count) VALUES (${previewId},${count.disposition},${count.category},${count.count})`);
      return preview(tx,actor.guildId,id,previewId);
    },true);
  }
  private async valid(tx:Executor,r:{id:string;guildId:string;subjectUserId:string},p:PreviewView){
    if(p.consumedAt||p.subjectUserId!==r.subjectUserId) throw conflict();
    const valid=await tx.execute(sql`SELECT ${p.expiresAt}::timestamptz > ${clock} AS valid`);if(!valid.rows[0]?.valid) throw conflict();
    const i=await collectInventory(tx,context(r,p.requestVersion));
    if(i.hash!==p.hash||i.eligibleTotal!==p.eligibleTotal||i.retainedTotal!==p.retainedTotal||!countsEqual(i.counts,p.counts)) throw conflict();
    return i;
  }
  async confirm(actor:Actor,id:string,previewId:string){
    owner(actor); key(previewId);
    return this.transaction(async tx=>{
      await bound(tx); const r=await request(tx,actor.guildId,id,true); if(r.status!=='PREVIEWED') throw conflict();
      const p=await preview(tx,actor.guildId,id,previewId,true); if(p.requestVersion!==r.version) throw conflict();
      await this.valid(tx,r,p);
      await tx.execute(sql`UPDATE subject_requests SET status='CONFIRMED',version=version+1,confirmed_by=${actor.userId},confirmed_at=${clock},confirmed_preview_id=${previewId} WHERE guild_id=${actor.guildId} AND id=${id}`);
      return request(tx,actor.guildId,id);
    },true);
  }
  async execute(actor:Actor,id:string,previewId:string){
    owner(actor); key(previewId);
    return this.transaction(async tx=>{
      await bound(tx); const r=await request(tx,actor.guildId,id,true);
      if(terminal(r.status)) return {request:r,receipt:await receipt(tx,actor.guildId,id)};
      if(r.status!=='CONFIRMED'||r.confirmedPreviewId!==previewId||!r.confirmedBy) throw conflict();
      const p=await preview(tx,actor.guildId,id,previewId,true); if(r.version!==p.requestVersion+1) throw conflict();
      // Shared with LevelsRepository.award; row locks plus SERIALIZABLE snapshot fence existing state.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`levels:${actor.guildId}:${r.subjectUserId}`},0))`);
      // Parent-first, ordered locking matches the existing event writers/reconciler.
      await tx.execute(sql`SELECT e.id FROM community_events e WHERE e.guild_id=${actor.guildId} AND (EXISTS (SELECT 1 FROM event_participants p WHERE p.event_id=e.id AND p.user_id=${r.subjectUserId}) OR EXISTS (SELECT 1 FROM event_attendance a WHERE a.event_id=e.id AND (a.user_id=${r.subjectUserId} OR a.marked_by=${r.subjectUserId}))) ORDER BY e.id FOR UPDATE OF e`);
      await tx.execute(sql`SELECT user_id FROM member_levels WHERE guild_id=${actor.guildId} AND user_id=${r.subjectUserId} FOR UPDATE`);
      await tx.execute(sql`SELECT user_id FROM member_reputation WHERE guild_id=${actor.guildId} AND user_id=${r.subjectUserId} FOR UPDATE`);
      await tx.execute(sql`SELECT achievement_id FROM member_achievements WHERE guild_id=${actor.guildId} AND user_id=${r.subjectUserId} ORDER BY achievement_id FOR UPDATE`);
      const i=await this.valid(tx,r,p);
      await tx.execute(sql`UPDATE subject_requests SET status='EXECUTING',version=version+1 WHERE guild_id=${actor.guildId} AND id=${id}`);
      const deleted:DeletedCounts={memberLevels:0,memberReputation:0,achievements:0,eventParticipants:0,eventAttendance:0};
      const eligible=i.entries.filter(e=>e.disposition==='ERASE');
      for(const e of eligible){
        let result;
        if(e.family==='member_levels') {result=await tx.execute(sql`DELETE FROM member_levels WHERE guild_id=${actor.guildId} AND user_id=${r.subjectUserId} RETURNING user_id`);deleted.memberLevels+=result.rowCount??0;}
        else if(e.family==='member_reputation') {result=await tx.execute(sql`DELETE FROM member_reputation WHERE guild_id=${actor.guildId} AND user_id=${r.subjectUserId} RETURNING user_id`);deleted.memberReputation+=result.rowCount??0;}
        else if(e.family==='member_achievements') {result=await tx.execute(sql`DELETE FROM member_achievements WHERE guild_id=${actor.guildId} AND user_id=${r.subjectUserId} AND achievement_id=${e.identity[2]!} RETURNING achievement_id`);deleted.achievements+=result.rowCount??0;}
        else if(e.family==='event_participants'||e.family==='event_attendance') {
          const eventId=e.identity[0]!;
          const safe=await tx.execute(sql`SELECT id FROM community_events WHERE guild_id=${actor.guildId} AND id=${eventId}::bigint AND status IN ('COMPLETED','CANCELLED') AND presentation_pending=false AND presentation_retry_at IS NULL`);if(!safe.rows[0]) throw conflict();
          if(e.family==='event_participants') {result=await tx.execute(sql`DELETE FROM event_participants WHERE event_id=${eventId}::bigint AND user_id=${r.subjectUserId} RETURNING user_id`);deleted.eventParticipants+=result.rowCount??0;}
          else {result=await tx.execute(sql`DELETE FROM event_attendance WHERE event_id=${eventId}::bigint AND user_id=${r.subjectUserId} RETURNING user_id`);deleted.eventAttendance+=result.rowCount??0;}
        } else throw conflict();
        if(result.rowCount!==1) throw conflict();
      }
      // Defer invalidation until both participant/attendance deletes finish; our own pending flag is not a stale-state change.
      const events=[...new Set(eligible.filter(e=>e.family==='event_participants').map(e=>e.identity[0]!))].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
      for(const eventId of events) await tx.execute(sql`UPDATE community_events SET presentation_pending=true,presentation_retry_at=NULL WHERE guild_id=${actor.guildId} AND id=${eventId}::bigint`);
      if(Object.values(deleted).reduce((a,b)=>a+b,0)!==i.eligibleTotal) throw conflict();
      const outcome=i.retainedTotal>0?'PARTIAL':'COMPLETED';
      await tx.execute(sql`INSERT INTO subject_execution_receipts (request_id,guild_id,subject_user_id,confirmed_by,executed_by,inventory_hash,executed_at,outcome,request_version,deleted_member_levels,deleted_member_reputation,deleted_achievements,deleted_event_participants,deleted_event_attendance,retained_total) VALUES (${id},${actor.guildId},${r.subjectUserId},${r.confirmedBy},${actor.userId},${i.hash},${clock},${outcome},${r.version+2},${deleted.memberLevels},${deleted.memberReputation},${deleted.achievements},${deleted.eventParticipants},${deleted.eventAttendance},${i.retainedTotal})`);
      await tx.execute(sql`UPDATE subject_requests SET status=${outcome},executed_at=${clock},terminal_at=${clock},version=version+1 WHERE guild_id=${actor.guildId} AND id=${id}`);
      await tx.execute(sql`UPDATE subject_request_previews SET consumed_at=${clock} WHERE guild_id=${actor.guildId} AND request_id=${id} AND id=${previewId}`);
      return {request:await request(tx,actor.guildId,id),receipt:await receipt(tx,actor.guildId,id)};
    },true);
  }
  async deny(actor:Actor,id:string,code:DenialCode){owner(actor);if(!DENIAL_CODES.includes(code))throw new AppError('VALIDATION','Choose a fixed privacy denial code.');return this.transaction(async tx=>{await bound(tx);const r=await request(tx,actor.guildId,id,true);if(!['PENDING','PREVIEWED','CONFIRMED'].includes(r.status))throw conflict();await tx.execute(sql`UPDATE subject_requests SET status='DENIED',version=version+1,denied_by=${actor.userId},denied_at=${clock},denial_code=${code},terminal_at=${clock} WHERE guild_id=${actor.guildId} AND id=${id}`);await tx.execute(sql`UPDATE subject_request_previews SET consumed_at=${clock} WHERE guild_id=${actor.guildId} AND request_id=${id} AND consumed_at IS NULL`);return request(tx,actor.guildId,id);});}
  async recordAuditGap(input:AuditGapInput):Promise<void>{
    if(!GOVERNANCE_ACTIONS.includes(input.action)||input.targetType!==input.action||!/^\d{17,20}$/.test(input.actorUserId)||!/^[-\w]{1,128}$/.test(input.requestId)||(input.targetId!==undefined&&!/^[-\w]{1,128}$/.test(input.targetId)))throw new AppError('VALIDATION','Invalid governance gap metadata.');
    await this.db.execute(sql`INSERT INTO governance_audit_gaps (id,guild_id,actor_user_id,action,target_type,target_id,request_id) VALUES (${randomUUID()},${input.guildId},${input.actorUserId},${input.action},${input.targetType},${input.targetId??null},${input.requestId})`);
  }
}
