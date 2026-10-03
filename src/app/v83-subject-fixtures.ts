import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../core/database/connection.js';
export const SUBJECT='990000000000000101', OTHER='990000000000000102', OWNER='990000000000000103';
export const PLACEHOLDER='synthetic-placeholder-not-private-data';
export async function insertFixture(db:Pick<Database,'execute'>,table:string,values:Record<string,unknown>){
  if(!/^[a-z_]+$/.test(table)||Object.keys(values).some(k=>!/^[a-z_]+$/.test(k)))throw new Error('Invalid fixture identifier');
  const names=Object.keys(values), params=names.map(name=>values[name]);
  const result=await db.execute(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(names.map(n=>sql.identifier(n)),sql`,`)}) VALUES (${sql.join(params.map(v=>sql`${v}`),sql`,`)}) RETURNING *`);
  return result.rows[0]!;
}
export async function eventFixture(db:Pick<Database,'execute'>,guildId:string,status='COMPLETED',options:{pending?:boolean;retry?:boolean;creator?:string;participants?:boolean;attendance?:boolean;staffOnly?:boolean}={}){
  const event=await insertFixture(db,'community_events',{guild_id:guildId,creator_id:options.creator??OTHER,title:'Synthetic event',description:PLACEHOLDER,start_at:new Date('2020-01-01'),end_at:new Date('2020-01-02'),channel_id:'990000000000000104',status,presentation_pending:options.pending??false,presentation_retry_at:options.retry?new Date('2020-01-03'):null});
  const id=String(event.id);
  if(options.participants!==false){await insertFixture(db,'event_participants',{event_id:id,user_id:SUBJECT});await insertFixture(db,'event_participants',{event_id:id,user_id:OTHER});}
  if(options.attendance!==false)await insertFixture(db,'event_attendance',{event_id:id,user_id:SUBJECT,marked_by:SUBJECT});
  await insertFixture(db,'event_attendance',{event_id:id,user_id:OTHER,marked_by:SUBJECT});
  return id;
}
/** Deliberately synthetic references across the complete current registry. No real content or credential values. */
export async function completeInventoryFixtures(db:Database,guildId:string,currentRequestId:string){
  const put=(table:string,v:Record<string,unknown>)=>insertFixture(db,table,v);
  await put('guild_modules',{guild_id:guildId,module_key:'levels',enabled:true,updated_by:SUBJECT});
  const moderation=await put('moderation_cases',{guild_id:guildId,target_id:SUBJECT,moderator_id:SUBJECT,action:'WARN',reason:PLACEHOLDER});
  await put('verification_settings',{guild_id:guildId,updated_by:SUBJECT});
  await put('member_verifications',{guild_id:guildId,user_id:SUBJECT,verified_by:SUBJECT,rejected_by:SUBJECT,reason:PLACEHOLDER});
  await put('antiraid_settings',{guild_id:guildId,emergency_actor_id:SUBJECT,updated_by:SUBJECT,emergency_reason:PLACEHOLDER});
  await put('join_history',{guild_id:guildId,user_id:SUBJECT,joined_at:new Date('2020-01-01')});
  await put('moderator_notes',{guild_id:guildId,target_id:SUBJECT,moderator_id:SUBJECT,content:PLACEHOLDER});
  await put('role_menus',{guild_id:guildId,name:'Synthetic',created_by:SUBJECT});
  await put('retention_policies',{guild_id:guildId,enabled:false,confirmed_by:SUBJECT,confirmed_at:new Date('2020-01-01')});
  await put('retention_previews',{id:randomUUID(),guild_id:guildId,requested_by:SUBJECT,ticket_days:90,report_days:365,appeal_days:365,base_version:0,eligible_ticket_count:0,eligible_report_count:0,eligible_appeal_count:0,expires_at:new Date('2035-01-01')});
  const ticket=await put('tickets',{guild_id:guildId,creator_id:SUBJECT,assigned_staff_id:SUBJECT,closed_by:SUBJECT,type:'SUPPORT',status:'CLOSED',closed_at:new Date('2020-01-01'),transcript:PLACEHOLDER,retention_hold:true,retention_hold_by:SUBJECT,retention_hold_at:new Date('2020-01-01')});
  await put('ticket_participants',{ticket_id:ticket.id,user_id:SUBJECT,added_by:SUBJECT});
  const redactedTicket=await put('tickets',{guild_id:guildId,creator_id:SUBJECT,type:'SUPPORT',status:'CLOSED',closed_at:new Date('2020-01-01'),transcript:null,transcript_redacted_at:new Date('2020-01-02'),transcript_retention_policy_version:0});
  await put('retention_receipts',{guild_id:guildId,domain:'TICKET',record_id:redactedTicket.id,policy_version:0,policy_authorizer_id:SUBJECT});
  await put('reports',{guild_id:guildId,reporter_id:SUBJECT,reported_user_id:SUBJECT,assigned_staff_id:SUBJECT,closed_by:SUBJECT,category:'OTHER',description:PLACEHOLDER,evidence_url:PLACEHOLDER,resolution_note:PLACEHOLDER,retention_hold:true,retention_hold_by:SUBJECT,retention_hold_at:new Date('2020-01-01')});
  await put('appeals',{guild_id:guildId,appellant_id:SUBJECT,reviewer_id:SUBJECT,case_id:moderation.id,reason:PLACEHOLDER,review_note:PLACEHOLDER,retention_hold:true,retention_hold_by:SUBJECT,retention_hold_at:new Date('2020-01-01')});
  const suggestion=await put('suggestions',{guild_id:guildId,author_id:SUBJECT,reviewed_by:SUBJECT,content:PLACEHOLDER,staff_response:PLACEHOLDER});
  await put('suggestion_votes',{suggestion_id:suggestion.id,user_id:SUBJECT,vote:1});
  await put('member_levels',{guild_id:guildId,user_id:SUBJECT,xp:500,message_count:7,last_fingerprint:'synthetic-fingerprint'});
  await put('member_reputation',{guild_id:guildId,user_id:SUBJECT,score:9});
  await put('reputation_grants',{guild_id:guildId,giver_id:OTHER,receiver_id:SUBJECT,interaction_id:'synthetic-replay'});
  await put('reputation_grants',{guild_id:guildId,giver_id:SUBJECT,receiver_id:OTHER,interaction_id:'synthetic-outgoing'});
  await put('starboard_messages',{guild_id:guildId,source_channel_id:'990000000000000104',source_message_id:'990000000000000105',source_author_id:SUBJECT});
  const terminalEvent=await eventFixture(db,guildId,'COMPLETED',{creator:SUBJECT});
  const cancelledEvent=await eventFixture(db,guildId,'CANCELLED',{participants:false});
  const attendanceOnly=await eventFixture(db,guildId,'COMPLETED',{participants:false});
  const unsafeEvents=[];
  for(const state of ['SCHEDULED','ACTIVE'])unsafeEvents.push(await eventFixture(db,guildId,state));
  unsafeEvents.push(await eventFixture(db,guildId,'COMPLETED',{pending:true}));
  unsafeEvents.push(await eventFixture(db,guildId,'CANCELLED',{retry:true}));
  const giveaway=await put('giveaways',{guild_id:guildId,creator_id:SUBJECT,channel_id:'990000000000000104',prize:'Synthetic',start_at:new Date('2020-01-01'),end_at:new Date('2020-01-02'),winner_count:1,status:'ENDED'});
  await put('giveaway_entries',{giveaway_id:giveaway.id,user_id:SUBJECT});
  const draw=await put('giveaway_draws',{giveaway_id:giveaway.id,kind:'ORIGINAL'});
  await put('giveaway_winners',{draw_id:draw.id,giveaway_id:giveaway.id,user_id:SUBJECT,ordinal:1});
  await put('tempvoice_rooms',{guild_id:guildId,owner_id:SUBJECT,status:'CLOSED'});
  await put('member_achievements',{guild_id:guildId,user_id:SUBJECT,achievement_id:'first-message'});
  await put('analytics_member_state',{guild_id:guildId,user_id:SUBJECT,present:true,last_changed_at:new Date('2020-01-01')});
  await put('analytics_active_voice_sessions',{guild_id:guildId,user_id:SUBJECT,joined_at:new Date('2020-01-01'),updated_at:new Date('2020-01-02')});
  const sessionHash=`synthetic-${randomUUID()}`;
  await put('dashboard_sessions',{token_hash:sessionHash,user_id:SUBJECT,oauth_guild_ids:JSON.stringify([guildId]),expires_at:new Date('2030-01-01'),absolute_expires_at:new Date('2030-01-02')});
  await put('dashboard_audit_log',{guild_id:guildId,actor_user_id:SUBJECT,action:'moderation-warn',target_type:'moderation-warn',target_id:SUBJECT,success:true,request_id:'synthetic-historical'});
  await put('dashboard_audit_log',{guild_id:guildId,actor_user_id:SUBJECT,action:'privacy-preview',target_type:'privacy-preview',target_id:currentRequestId,success:true,request_id:'synthetic-own'});
  await put('dashboard_audit_log',{guild_id:guildId,actor_user_id:SUBJECT,action:'privacy-preview',target_type:'unrelated',target_id:currentRequestId,success:true,request_id:'synthetic-miscorrelated'});
  await put('ai_usage_daily',{guild_id:guildId,utc_day:'2020-01-01'});
  await put('ai_requests',{id:randomUUID(),guild_id:guildId,user_id:SUBJECT,request_key:'synthetic',usage_day:'2020-01-01',epoch:0,model_id:'synthetic',reserved_input_tokens:1,reserved_output_tokens:1,reserved_cost_micros:1,lease_until:new Date('2030-01-01')});
  const automation=await put('automations',{guild_id:guildId,name:'Synthetic',trigger_key:'SCHEDULED',trigger_version:1,authorized_by:SUBJECT,approved_capability:'SEND_MESSAGE'});
  const execution=await put('automation_executions',{id:randomUUID(),guild_id:guildId,automation_id:automation.id,trigger_key:'synthetic',status:'UNCERTAIN',module_epoch:0,config_version:1});
  await put('automation_execution_actions',{execution_id:execution.id,position:0,action_key:'STATIC_MESSAGE',action_version:1});
  await put('automation_action_runs',{execution_id:execution.id,position:0,status:'UNCERTAIN',reconciled_by:SUBJECT,reconciled_at:new Date('2020-01-01'),reconciliation_result:'CONFIRMED_SENT'});
  const historical=randomUUID(),historicalPreview=randomUUID();
  await put('subject_requests',{id:historical,guild_id:guildId,subject_user_id:SUBJECT,status:'COMPLETED',version:3,previewed_by:SUBJECT,previewed_at:new Date('2020-01-01'),confirmed_by:SUBJECT,confirmed_at:new Date('2020-01-01'),confirmed_preview_id:historicalPreview,executed_at:new Date('2020-01-02'),terminal_at:new Date('2020-01-02')});
  await put('subject_request_previews',{id:historicalPreview,request_id:historical,guild_id:guildId,subject_user_id:SUBJECT,reviewed_by:SUBJECT,request_version:1,inventory_hash:'a'.repeat(64),eligible_total:0,retained_total:0,created_at:new Date('2020-01-01'),expires_at:new Date('2020-01-02'),consumed_at:new Date('2020-01-01')});
  await put('subject_execution_receipts',{request_id:historical,guild_id:guildId,subject_user_id:SUBJECT,confirmed_by:SUBJECT,executed_by:SUBJECT,inventory_hash:'a'.repeat(64),outcome:'COMPLETED',request_version:3,deleted_member_levels:0,deleted_member_reputation:0,deleted_achievements:0,deleted_event_participants:0,deleted_event_attendance:0,retained_total:0,executed_at:new Date('2020-01-02')});
  await put('subject_requests',{id:randomUUID(),guild_id:guildId,subject_user_id:SUBJECT,status:'DENIED',denied_by:SUBJECT,denied_at:new Date('2020-01-01'),denial_code:'POLICY_RETAINED',terminal_at:new Date('2020-01-01')});
  await put('governance_audit_gaps',{id:randomUUID(),guild_id:guildId,actor_user_id:SUBJECT,action:'retention-disable',target_type:'retention-disable',request_id:'synthetic-historical'});
  await put('governance_audit_gaps',{id:randomUUID(),guild_id:guildId,actor_user_id:SUBJECT,action:'privacy-preview',target_type:'privacy-preview',target_id:currentRequestId,request_id:'synthetic-own'});
  return {terminalEvent,cancelledEvent,attendanceOnly,unsafeEvents,sessionHash};
}
export async function fingerprint(db:Database,query:SQL){const rows=await db.execute(query);return JSON.stringify(rows.rows);}
