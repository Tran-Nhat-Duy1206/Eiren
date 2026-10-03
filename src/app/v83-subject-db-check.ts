import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../core/database/connection.js';
import { PermissionService } from '../core/permissions/permission-service.js';
import { SubjectRequestService } from '../modules/subject-requests/service.js';
import { collectInventory, SUBJECT_REFERENCE_REGISTRY } from '../modules/subject-requests/inventory.js';
import { runSubjectRequestMaintenance } from '../modules/subject-requests/maintenance.js';
import { ReputationRepository } from '../modules/reputation/repository.js';
import { LevelsRepository } from '../modules/levels/repository.js';
import { AchievementRepository } from '../modules/achievements/repository.js';
import { AchievementsService } from '../modules/achievements/service.js';
import { ProfileService } from '../modules/profiles/service.js';
import type { SelfInteraction } from '../modules/subject-requests/contracts.js';
import { completeInventoryFixtures, eventFixture, insertFixture, fingerprint, SUBJECT, OTHER, OWNER, PLACEHOLDER } from './v83-subject-fixtures.js';

const url=process.env.DATABASE_URL;
if(!url)throw new Error('Explicit synthetic DATABASE_URL required; local .env never loaded.');
const target=new URL(url),name=decodeURIComponent(target.pathname.slice(1));
if(!['postgres:','postgresql:'].includes(target.protocol)||!['localhost','127.0.0.1','::1','[::1]'].includes(target.hostname)||!(/^eiren_v8_[a-z0-9_]+$/.test(name)||(process.env.GITHUB_ACTIONS==='true'&&name==='eiren')))throw new Error('Refusing nonisolated subject validation database.');
const {db,pool}=createDatabase(url),guilds:string[]=[];
const checks:string[]=[];let stage='empty guard';
function check(label:string,value:unknown):asserts value{if(!value){stage=`assertion: ${label}`;throw new Error('Synthetic validation assertion failed');}checks.push(label);}
function code(error:unknown):string{for(let e:any=error;e;e=e.cause)if(typeof e.code==='string')return e.code;return 'ASSERTION';}
function constraint(error:unknown):string|undefined{for(let e:any=error;e;e=e.cause)if(typeof e.constraint==='string')return e.constraint;return undefined;}
async function rejects(label:string,action:()=>Promise<unknown>,pg=false){let error:unknown;try{await action();}catch(e){error=e;}check(label,!!error&&(!pg||['23514','23503','23505','23502'].includes(code(error))));}
async function count(table:string,where=sql`true`){const result=await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${where}`);return Number(result.rows[0]!.n);}
async function guild(){const id=`v83-check-${randomUUID()}`;await insertFixture(db,'guilds',{id});guilds.push(id);return id;}
const permissions=new PermissionService({getRoleLevels:async(_guildId,roles)=>roles.includes('990000000000000999')?['ADMIN']:[]},new Set([OTHER]));
const service=new SubjectRequestService(db,permissions);
const actor=(guildId:string,userId=OWNER)=>({guildId,userId,guildOwnerId:OWNER,roleIds:['990000000000000999']});
const self=(guildId:string,userId=SUBJECT,fetch?:()=>Promise<void>):SelfInteraction=>({inGuild:()=>true,guildId,user:{id:userId},guild:{id:guildId,members:{fetch:async options=>{check('self fetch forced authenticated user',options.force===true&&options.user===userId);if(fetch)await fetch();return{id:userId,guild:{id:guildId}};}}}});
async function workflow(guildId:string){const r=await service.createSelfRequest(self(guildId));const p=await service.preview(actor(guildId),r.id);await service.confirm(actor(guildId),r.id,p.id);return{r,p};}
async function inventory(guildId:string,id:string,version:number){return collectInventory(db,{guildId,requestId:id,subjectUserId:SUBJECT,requestVersion:version});}
try{
  const tables=await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  for(const t of tables.rows)if(await count(String(t.table_name)))throw new Error('Refusing existing public data');
  check('all public product tables empty',true);
  const expected=['subject_requests','subject_request_previews','subject_request_preview_counts','subject_execution_receipts','governance_audit_gaps'];
  check('all five subject governance tables present',expected.every(t=>tables.rows.some(r=>r.table_name===t)));
  stage='creation and authority';
  const g=await guild(),foreign=await guild();
  await insertFixture(db,'member_levels',{guild_id:foreign,user_id:SUBJECT,xp:888});
  await insertFixture(db,'member_reputation',{guild_id:foreign,user_id:SUBJECT,score:888});
  await insertFixture(db,'member_achievements',{guild_id:foreign,user_id:SUBJECT,achievement_id:'synthetic-foreign'});
  const foreignEvent=await eventFixture(db,foreign);
  await rejects('fresh member failure creates no request',()=>service.createSelfRequest(self(g,SUBJECT,async()=>{throw new Error('synthetic missing member');})));
  check('membership failure left zero rows',await count('subject_requests')===0);
  const fetched:any[]=[];const interaction=self(g);interaction.guild!.members.fetch=async options=>{fetched.push(options);return{id:SUBJECT,guild:{id:g}};};
  const creationKey=`v83-fixture-${randomUUID()}`;
  await db.execute(sql.raw(`CREATE FUNCTION v83_subject_fixture_create_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${creationKey}',0)); RETURN NEW; END $$`));
  let creationRelease!:()=>void,creationReady!:()=>void;
  const creationStarted=new Promise<void>(resolve=>{creationReady=resolve;});
  let concurrent:Awaited<ReturnType<typeof service.createSelfRequest>>[]=[];
  try{
    await db.execute(sql.raw('CREATE TRIGGER v83_subject_fixture_create_wait BEFORE INSERT ON subject_requests FOR EACH ROW EXECUTE FUNCTION v83_subject_fixture_create_wait()'));
    const creationBarrier=db.transaction(async tx=>{await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${creationKey},0))`);creationReady();await new Promise<void>(resolve=>{creationRelease=resolve;});});
    await creationStarted;
    const creating=Promise.all([service.createSelfRequest(interaction),service.createSelfRequest(interaction)]).then(requests=>({requests,error:null}),error=>({requests:[],error}));
    let bothWaiting=false;
    try{for(let attempt=0;attempt<1000;attempt++){const waiters=await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO subject_requests%'`);if(Number(waiters.rows[0]!.n)===2){bothWaiting=true;break;}}}finally{creationRelease();}
    await creationBarrier;const created=await creating;if(created.error)throw created.error;concurrent=created.requests;
    check('two real self INSERT workers blocked at authoritative trigger barrier',bothWaiting);
  }finally{await db.execute(sql.raw('DROP TRIGGER IF EXISTS v83_subject_fixture_create_wait ON subject_requests'));await db.execute(sql.raw('DROP FUNCTION IF EXISTS v83_subject_fixture_create_wait()'));}
  const firstRequest=concurrent[0],secondRequest=concurrent[1];
  check('both self command worker results present',!!firstRequest&&!!secondRequest);
  check('concurrent self requests return one active ID',firstRequest.id===secondRequest.id&&await count('subject_requests')===1);
  check('both creations force fresh member fetch',fetched.length===2&&fetched.every(o=>o.force===true&&o.user===SUBJECT));
  const extraSubjectInput={...self(g),subjectUserId:OTHER} as SelfInteraction;
  check('arbitrary extra subject input cannot change authenticated subject',(await service.createSelfRequest(extraSubjectInput)).subjectUserId===SUBJECT&&await count('subject_requests')===1);
  const r=firstRequest;check('authenticated subject verification stored',r.subjectUserId===SUBJECT&&r.verificationMethod==='SELF_GUILD_MEMBER'&&Number.isFinite(Date.parse(r.subjectVerifiedAt)));
  await rejects('non-guild creation rejected',()=>service.createSelfRequest({...interaction,inGuild:()=>false}));
  await rejects('wrong guild fresh member rejected',()=>service.createSelfRequest({...self(g,OTHER),guild:{id:g,members:{fetch:async()=>({id:OTHER,guild:{id:foreign}})}}}));
  await rejects('arbitrary invalid subject input rejected',()=>service.createSelfRequest(self(g,'arbitrary')));
  check('own status limited to authenticated subject',(await service.ownStatus({guildId:g,userId:SUBJECT}))?.id===r.id&&await service.ownStatus({guildId:g,userId:OTHER})===null);
  interaction.guild!.members.fetch=async()=>{throw new Error('synthetic member gone');};
  check('review stored verified request after member departure',(await service.inspect(actor(g),r.id)).request.id===r.id);
  await rejects('Discord Administrator flag alone cannot preview',()=>service.preview({...actor(g,'990000000000000111'),roleIds:[],administrator:true} as never,r.id));
  check('ADMIN reviewer allowed preview',(await service.preview(actor(g,SUBJECT),r.id)).reviewedBy===SUBJECT);
  const p=await service.preview(actor(g),r.id);
  for(const user of [OTHER,SUBJECT])for(const op of ['confirm','execute','deny'] as const)await rejects(`nonowner ${user===OTHER?'BOT_OWNER':'ADMIN'} ${op} denied`,()=>op==='deny'?service.deny(actor(g,user),r.id,'OUT_OF_SCOPE'):service[op](actor(g,user),r.id,p.id));
  for(const op of ['inspect','preview','confirm','execute','deny'] as const)await rejects(`cross-guild ${op} fails closed`,()=>op==='inspect'||op==='preview'?service[op](actor(foreign),r.id):op==='deny'?service.deny(actor(foreign),r.id,'OUT_OF_SCOPE'):service[op](actor(foreign),r.id,p.id));
  check('foreign request list and receipts empty',(await service.list(actor(foreign))).length===0&&(await service.recentReceipts(actor(foreign))).length===0);
  await rejects('malformed request ID fails closed',()=>service.inspect(actor(g),'invalid'));
  check('preview exact DB 15 minute lifetime',Math.abs(Date.parse(p.expiresAt)-Date.parse(p.createdAt)-900000)<1000);
  check('preview hash SHA256 and version stored',/^[a-f0-9]{64}$/.test(p.hash)&&p.requestVersion===(await service.inspect(actor(g),r.id)).request.version);
  await service.confirm(actor(g),r.id,p.id);
  await rejects('duplicate confirmation refused',()=>service.confirm(actor(g),r.id,p.id));
  const refresh=await service.preview(actor(g),r.id);
  const refreshed=(await service.inspect(actor(g),r.id)).request;
  check('refresh CONFIRMED clears complete confirmation fence',refreshed.status==='PREVIEWED'&&refreshed.confirmedBy===null&&refreshed.confirmedAt===null&&refreshed.confirmedPreviewId===null&&refreshed.version>p.requestVersion);
  await rejects('refresh consumes prior preview',()=>service.confirm(actor(g),r.id,p.id));
  await db.execute(sql`UPDATE subject_request_previews SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=${refresh.id}`);
  await rejects('DB clock expired preview cannot confirm',()=>service.confirm(actor(g),r.id,refresh.id));
  const final=await service.preview(actor(g),r.id);await service.confirm(actor(g),r.id,final.id);
  const zero=await service.execute(actor(g),r.id,final.id);
  check('zero eligible request COMPLETED with zero retained primary data',zero.request.status==='COMPLETED'&&zero.receipt?.retainedTotal===0&&Object.values(zero.receipt.deleted).every(n=>n===0));
  check('own workflow evidence separately displayed',(await service.inspect(actor(g),r.id)).workflowEvidence.includes('excluded'));
  check('foreign receipts and inventory remain scoped',(await service.recentReceipts(actor(foreign))).length===0);
  const terminalRetry=await service.execute(actor(g),r.id,final.id);check('terminal execution retry same one receipt',terminalRetry.receipt?.inventoryHash===zero.receipt?.inventoryHash&&await count('subject_execution_receipts',sql`request_id=${r.id}`)===1);
  const newer=await service.createSelfRequest(self(g));check('new self request allowed after terminal',newer.id!==r.id);
  await rejects('structured denial rejects arbitrary narrative',()=>service.deny(actor(g),newer.id,'private reason' as never));
  const denied=await service.deny(actor(g),newer.id,'POLICY_RETAINED');check('structured owner denial terminal',denied.status==='DENIED'&&denied.denialCode==='POLICY_RETAINED'&&!!denied.terminalAt);
  await rejects('denial terminal cannot preview',()=>service.preview(actor(g),newer.id));
  const afterDenial=await service.createSelfRequest(self(g));check('new self request after denial',afterDenial.id!==newer.id);

  stage='schema constraints';
  await rejects('partial active subject uniqueness enforced by database',()=>insertFixture(db,'subject_requests',{id:randomUUID(),guild_id:g,subject_user_id:SUBJECT}),true);
  const invalidRequests=["subject_user_id='bad'","version=-1","status='UNKNOWN'","verification_method='STAFF'","previewed_by='bad'","previewed_at=clock_timestamp()","confirmed_by='990000000000000103'","denied_by='990000000000000103'","status='COMPLETED'","denial_code='NARRATIVE'"];
  for(const mutation of invalidRequests)await rejects(`request constraint ${mutation.split('=')[0]} ${invalidRequests.indexOf(mutation)}`,()=>db.execute(sql`UPDATE subject_requests SET ${sql.raw(mutation)} WHERE id=${afterDenial.id}`),true);
  const pp=await service.preview(actor(g),afterDenial.id);
  for(const mutation of ["reviewed_by='bad'","subject_user_id='990000000000000102'","guild_id='other'","request_version=-1","inventory_hash='bad'","eligible_total=-1","retained_total=-1","expires_at=created_at","consumed_at=created_at-interval '1 second'"])await rejects(`preview constraint ${mutation.split('=')[0]}`,()=>db.execute(sql`UPDATE subject_request_previews SET ${sql.raw(mutation)} WHERE id=${pp.id}`),true);
  await insertFixture(db,'subject_request_preview_counts',{preview_id:pp.id,disposition:'ERASE',category:'MEMBER_LEVEL_STATE',count:0});
  for(const mutation of ["disposition='BAD'","category='BAD'","count=-1","preview_id='00000000-0000-0000-0000-000000000000'"])await rejects(`count constraint ${mutation.split('=')[0]}`,()=>db.execute(sql`UPDATE subject_request_preview_counts SET ${sql.raw(mutation)} WHERE preview_id=${pp.id}`),true);
  await rejects('preview count composite duplicate refused',()=>insertFixture(db,'subject_request_preview_counts',{preview_id:pp.id,disposition:'ERASE',category:'MEMBER_LEVEL_STATE',count:0}),true);
  for(const mutation of ["confirmed_by='bad'","executed_by='bad'","subject_user_id='990000000000000102'","guild_id='other'","inventory_hash='bad'","request_version=-1",...['deleted_member_levels','deleted_member_reputation','deleted_achievements','deleted_event_participants','deleted_event_attendance','retained_total'].map(f=>`${f}=-1`),"outcome='PARTIAL'"])await rejects(`receipt constraint ${mutation.split('=')[0]}`,()=>db.execute(sql`UPDATE subject_execution_receipts SET ${sql.raw(mutation)} WHERE request_id=${r.id}`),true);
  await rejects('receipt request primary duplicate refused',()=>db.execute(sql`INSERT INTO subject_execution_receipts SELECT * FROM subject_execution_receipts WHERE request_id=${r.id}`),true);
  const gapId=randomUUID();await service.recordAuditGap({guildId:g,actorUserId:OWNER,action:'privacy-preview',targetType:'privacy-preview',targetId:afterDenial.id,requestId:'synthetic-gap'});
  const gap=(await db.execute(sql`SELECT id FROM governance_audit_gaps WHERE guild_id=${g} LIMIT 1`)).rows[0]!;
  for(const mutation of ["actor_user_id='bad'","action='unknown'","target_type='wrong'","target_id='bad:id'","request_id='bad:id'"])await rejects(`audit gap constraint ${mutation.split('=')[0]}`,()=>db.execute(sql`UPDATE governance_audit_gaps SET ${sql.raw(mutation)} WHERE id=${String(gap.id)}`),true);
  void gapId;
  const governanceColumns=await db.execute(sql`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('subject_requests','subject_request_previews','subject_request_preview_counts','subject_execution_receipts','governance_audit_gaps')`);
  check('all governance schema metadata-only',governanceColumns.rows.every(c=>!/(transcript|description|reason|review_note|evidence|content|token|secret|message_body)/.test(String(c.column_name))));

  stage='changed inventory fences';
  const staleGuild=await guild(),stale=await service.createSelfRequest(self(staleGuild));
  const stalePreview=await service.preview(actor(staleGuild),stale.id);
  await insertFixture(db,'member_levels',{guild_id:staleGuild,user_id:SUBJECT,xp:1});
  await rejects('new eligible row before confirm fails no deletion',()=>service.confirm(actor(staleGuild),stale.id,stalePreview.id));
  check('failed confirm preserves newly eligible levels',await count('member_levels',sql`guild_id=${staleGuild}`)===1);
  const staleP2=await service.preview(actor(staleGuild),stale.id);await service.confirm(actor(staleGuild),stale.id,staleP2.id);
  await insertFixture(db,'member_achievements',{guild_id:staleGuild,user_id:SUBJECT,achievement_id:'synthetic'});
  await rejects('new eligible row before execute fails no deletion',()=>service.execute(actor(staleGuild),stale.id,staleP2.id));
  check('failed execute retains CONFIRMED and both records',(await service.inspect(actor(staleGuild),stale.id)).request.status==='CONFIRMED'&&await count('member_levels',sql`guild_id=${staleGuild}`)===1&&await count('member_achievements',sql`guild_id=${staleGuild}`)===1);
  const tamper=await service.preview(actor(staleGuild),stale.id);
  await db.execute(sql`UPDATE subject_request_previews SET inventory_hash=${'b'.repeat(64)} WHERE id=${tamper.id}`);
  await rejects('tampered hash refused independently of totals',()=>service.confirm(actor(staleGuild),stale.id,tamper.id));
  const tamperCount=await service.preview(actor(staleGuild),stale.id);
  await db.execute(sql`UPDATE subject_request_preview_counts SET count=count+1 WHERE preview_id=${tamperCount.id}`);
  await rejects('tampered category count refused',()=>service.confirm(actor(staleGuild),stale.id,tamperCount.id));
  const versionPreview=await service.preview(actor(staleGuild),stale.id);
  await db.execute(sql`UPDATE subject_request_previews SET request_version=request_version+1 WHERE id=${versionPreview.id}`);
  await rejects('preview version mismatch independently refuses confirmation',()=>service.confirm(actor(staleGuild),stale.id,versionPreview.id));
  const executionExpiry=await service.preview(actor(staleGuild),stale.id);await service.confirm(actor(staleGuild),stale.id,executionExpiry.id);
  await db.execute(sql`UPDATE subject_request_previews SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=${executionExpiry.id}`);
  await rejects('DB-clock expiry rechecked independently at execute',()=>service.execute(actor(staleGuild),stale.id,executionExpiry.id));
  check('expired execute preserves CONFIRMED and all eligible rows',(await service.inspect(actor(staleGuild),stale.id)).request.status==='CONFIRMED'&&await count('member_levels',sql`guild_id=${staleGuild}`)===1&&await count('member_achievements',sql`guild_id=${staleGuild}`)===1);

  stage='complete reference inventory and exact deletion';
  const fullGuild=await guild(),full=await service.createSelfRequest(self(fullGuild));
  const fixture=await completeInventoryFixtures(db,fullGuild,full.id);
  const fullPreview=await service.preview(actor(fullGuild),full.id);
  const inv=await inventory(fullGuild,full.id,fullPreview.requestVersion);
  for(const reference of SUBJECT_REFERENCE_REGISTRY){const entries=inv.entries.filter(e=>e.family===reference.family);check(`inventory family ${reference.family} represented`,entries.length>0);for(const field of reference.userFields)check(`inventory field ${reference.family}.${field} covered`,entries.some(e=>e.roles.includes(field)));}
  check('inventory hash and aggregate counts exactly preview',inv.hash===fullPreview.hash&&inv.eligibleTotal===fullPreview.eligibleTotal&&inv.retainedTotal===fullPreview.retainedTotal&&inv.counts.reduce((n,c)=>n+c.count,0)===inv.entries.length);
  check('inventory digest excludes content/fingerprints/session hashes',!JSON.stringify(inv).includes(PLACEHOLDER)&&!JSON.stringify(inv).includes('synthetic-fingerprint')&&!JSON.stringify(inv).includes(fixture.sessionHash));
  check('only exactly correlated workflow audits excluded',inv.entries.filter(e=>e.family==='dashboard_audit_log').length===2&&inv.entries.filter(e=>e.family==='governance_audit_gaps').length===1);
  check('current workflow request excluded historical requests retained',inv.entries.filter(e=>e.family==='subject_requests').length===2&&inv.entries.some(e=>e.family==='subject_execution_receipts'));
  const retainFamilies=[...new Set(inv.entries.filter(e=>e.disposition==='RETAIN').map(e=>e.family))];
  const retainedBefore=new Map<string,string>();
  const retainedQuery=(family:string)=>sql`SELECT row_to_json(t) AS row FROM ${sql.identifier(family)} t WHERE ${family==='event_participants'?sql`NOT(event_id=${fixture.terminalEvent}::bigint AND user_id=${SUBJECT})`:family==='event_attendance'?sql`NOT(user_id=${SUBJECT} AND event_id IN (${fixture.terminalEvent}::bigint,${fixture.cancelledEvent}::bigint,${fixture.attendanceOnly}::bigint))`:sql`true`} ORDER BY row_to_json(t)::text`;
  for(const family of retainFamilies)retainedBefore.set(family,await fingerprint(db,retainedQuery(family)));
  // Parent events may only receive participant-count presentation invalidation; compare their immutable payload explicitly below.
  retainedBefore.delete('community_events');retainedBefore.delete('subject_requests');retainedBefore.delete('subject_request_previews');retainedBefore.delete('subject_execution_receipts');
  const otherLevels=await insertFixture(db,'member_levels',{guild_id:fullGuild,user_id:OTHER,xp:999});
  await insertFixture(db,'member_reputation',{guild_id:fullGuild,user_id:OTHER,score:999});
  const otherAchievements=await insertFixture(db,'member_achievements',{guild_id:fullGuild,user_id:OTHER,achievement_id:'synthetic-other'});
  const eventRowsBefore=await fingerprint(db,sql`SELECT id,title,description,creator_id,status,start_at,end_at FROM community_events WHERE guild_id=${fullGuild} ORDER BY id`);
  await service.confirm(actor(fullGuild),full.id,fullPreview.id);
  const erased=await service.execute(actor(fullGuild),full.id,fullPreview.id);
  check('all five approved domains exact counts',JSON.stringify(erased.receipt?.deleted)===JSON.stringify({memberLevels:1,memberReputation:1,achievements:1,eventParticipants:1,eventAttendance:3}));
  check('retained references produce PARTIAL',erased.request.status==='PARTIAL'&&erased.receipt?.retainedTotal===inv.retainedTotal);
  check('receipt deletion sum equals approved eligible count',!!erased.receipt&&Object.values(erased.receipt.deleted).reduce((a,b)=>a+b,0)===inv.eligibleTotal);
  check('receipt no content or record identity digest entries',!JSON.stringify(erased.receipt).includes(PLACEHOLDER)&&!JSON.stringify(erased.receipt).includes('synthetic-fingerprint')&&Object.keys(erased.receipt??{}).sort().join(',')==='confirmedBy,deleted,executedAt,executedBy,guildId,inventoryHash,outcome,requestId,requestVersion,retainedTotal,subjectUserId');
  for(const family of retainedBefore.keys())check(`retained family ${family} byte fingerprint unchanged`,retainedBefore.get(family)===await fingerprint(db,retainedQuery(family)));
  check('other member social rows preserved',await count('member_levels',sql`guild_id=${fullGuild} AND user_id=${OTHER}`)===1&&await count('member_achievements',sql`guild_id=${fullGuild} AND user_id=${OTHER}`)===1&&await count('member_reputation',sql`guild_id=${fullGuild} AND user_id=${OTHER} AND score=999`)===1&&otherLevels.user_id===otherAchievements.user_id);
  check('same subject all five approved domains in other guild untouched',await count('member_levels',sql`guild_id=${foreign} AND user_id=${SUBJECT} AND xp=888`)===1&&await count('member_reputation',sql`guild_id=${foreign} AND user_id=${SUBJECT} AND score=888`)===1&&await count('member_achievements',sql`guild_id=${foreign} AND user_id=${SUBJECT}`)===1&&await count('event_participants',sql`event_id=${foreignEvent} AND user_id=${SUBJECT}`)===1&&await count('event_attendance',sql`event_id=${foreignEvent} AND user_id=${SUBJECT}`)===1);
  check('event parents payload and lifecycle unchanged',eventRowsBefore===await fingerprint(db,sql`SELECT id,title,description,creator_id,status,start_at,end_at FROM community_events WHERE guild_id=${fullGuild} ORDER BY id`));
  for(const eventId of fixture.unsafeEvents)check(`unsafe event ${fixture.unsafeEvents.indexOf(eventId)} participation and attendance retained`,await count('event_participants',sql`event_id=${eventId} AND user_id=${SUBJECT}`)===1&&await count('event_attendance',sql`event_id=${eventId} AND user_id=${SUBJECT}`)===1);
  check('attendance marked by subject for another user retained',await count('event_attendance',sql`event_id=${fixture.terminalEvent} AND user_id=${OTHER} AND marked_by=${SUBJECT}`)===1);
  const pendingRows=await db.execute(sql`SELECT id,presentation_pending FROM community_events WHERE id IN (${fixture.terminalEvent}::bigint,${fixture.attendanceOnly}::bigint,${fixture.cancelledEvent}::bigint)`);
  check('pending invalidation only event with deleted participant',pendingRows.rows.every(e=>e.presentation_pending===(String(e.id)===fixture.terminalEvent)));
  const rep=new ReputationRepository(db),levels=new LevelsRepository(db),achievements=new AchievementRepository(db);
  check('erased aggregate score defaults to zero',await rep.score(fullGuild,SUBJECT)===0);
  check('retained grant replay returns zero without aggregate recreation',await rep.grant(fullGuild,OTHER,SUBJECT,'synthetic-replay')===0&&await count('member_reputation',sql`guild_id=${fullGuild} AND user_id=${SUBJECT}`)===0);
  await rejects('retained grant cooldown blocks new interaction',()=>rep.grant(fullGuild,OTHER,SUBJECT,'synthetic-new-too-soon'));
  const profile=new ProfileService({isEnabled:async()=>true},async(guildId,userId)=>{const row=await levels.member(guildId,userId);return row?{xp:row.xp,level:0,progress:0,nextLevelXp:null,rank:null,messageCount:row.messageCount}:null;},(guildId,userId)=>rep.score(guildId,userId));
  check('profile read is zero/absent facade after erasure',(await profile.get(fullGuild,SUBJECT)).levels===null&&(await profile.get(fullGuild,SUBJECT)).reputation===0);
  const freshGiver='990000000000000110';check('future legitimate reputation starts one',await rep.grant(fullGuild,freshGiver,SUBJECT,'synthetic-future')===1);
  const settings=await levels.settings(fullGuild);check('future legitimate levels starts fresh',(await levels.award({guildId:fullGuild,userId:SUBJECT,messageId:'synthetic-future',at:Date.now(),fingerprint:null},settings))?.xp===settings.xpPerMessage);
  const achievementService=new AchievementsService(achievements,{isEnabled:async()=>true});
  check('future legitimate achievement hook may earn valid ID again',(await achievementService.onLevel(fullGuild,SUBJECT,0,1)).includes('first-message')&&(await achievementService.listMember(fullGuild,SUBJECT)).some(a=>a.id==='first-message'));
  await db.execute(sql`DELETE FROM dashboard_sessions WHERE token_hash=${fixture.sessionHash}`);

  stage='deterministic event parent barrier';
  const raceGuild=await guild(),raceEvent=await eventFixture(db,raceGuild);const race=await workflow(raceGuild);
  let release!:()=>void,ready!:()=>void;const started=new Promise<void>(r=>{ready=r;});
  const barrier=db.transaction(async tx=>{await tx.execute(sql`SELECT id FROM community_events WHERE id=${raceEvent} FOR UPDATE`);ready();await new Promise<void>(r=>{release=r;});await tx.execute(sql`UPDATE community_events SET status='ACTIVE',updated_at=clock_timestamp() WHERE id=${raceEvent}`);});
  await started;const executing=service.execute(actor(raceGuild),race.r.id,race.p.id).then(()=>({ok:true,code:''}),e=>({ok:false,code:code(e)}));
  let observed=false;
  try{for(let attempt=0;attempt<1000;attempt++){const waiting=await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF e%'`);if(Number(waiting.rows[0]!.n)>0){observed=true;break;}}}finally{release();}
  await barrier;const raced=await executing;
  check('authoritative event parent lock observed without sleeping',observed);
  check('SERIALIZABLE concurrent parent transition aborts execute',!raced.ok&&['40001','CONFLICT'].includes(raced.code));
  check('parent-race abort keeps participants attendance request receipt',await count('event_participants',sql`event_id=${raceEvent} AND user_id=${SUBJECT}`)===1&&await count('event_attendance',sql`event_id=${raceEvent} AND user_id=${SUBJECT}`)===1&&(await service.inspect(actor(raceGuild),race.r.id)).request.status==='CONFIRMED'&&await count('subject_execution_receipts',sql`request_id=${race.r.id}`)===0);

  stage='actual receipt trigger rollback';
  const failGuild=await guild();await insertFixture(db,'member_levels',{guild_id:failGuild,user_id:SUBJECT,xp:10});await insertFixture(db,'member_reputation',{guild_id:failGuild,user_id:SUBJECT,score:10});await insertFixture(db,'member_achievements',{guild_id:failGuild,user_id:SUBJECT,achievement_id:'synthetic'});const failEvent=await eventFixture(db,failGuild);const failing=await workflow(failGuild);
  await db.execute(sql.raw("CREATE FUNCTION v83_subject_fixture_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure' USING ERRCODE='P0001'; END $$"));
  try{await db.execute(sql.raw('CREATE TRIGGER v83_subject_fixture_receipt_fail BEFORE INSERT ON subject_execution_receipts FOR EACH ROW EXECUTE FUNCTION v83_subject_fixture_receipt_fail()'));await rejects('actual PostgreSQL receipt insert failure rejects execute',()=>service.execute(actor(failGuild),failing.r.id,failing.p.id));}
  finally{await db.execute(sql.raw('DROP TRIGGER IF EXISTS v83_subject_fixture_receipt_fail ON subject_execution_receipts'));await db.execute(sql.raw('DROP FUNCTION IF EXISTS v83_subject_fixture_receipt_fail()'));}
  for(const table of ['member_levels','member_reputation','member_achievements'])check(`receipt failure rolls back ${table}`,await count(table,sql`guild_id=${failGuild} AND user_id=${SUBJECT}`)===1);
  check('receipt failure rolls back participant/attendance/presentation',await count('event_participants',sql`event_id=${failEvent} AND user_id=${SUBJECT}`)===1&&await count('event_attendance',sql`event_id=${failEvent} AND user_id=${SUBJECT}`)===1&&(await db.execute(sql`SELECT presentation_pending FROM community_events WHERE id=${failEvent}`)).rows[0]!.presentation_pending===false);
  check('receipt failure keeps CONFIRMED and preview unconsumed',(await service.inspect(actor(failGuild),failing.r.id)).request.status==='CONFIRMED'&&(await service.inspect(actor(failGuild),failing.r.id)).preview?.consumedAt===null&&await count('subject_execution_receipts',sql`request_id=${failing.r.id}`)===0);
  const workers=await Promise.allSettled([service.execute(actor(failGuild),failing.r.id,failing.p.id),service.execute(actor(failGuild),failing.r.id,failing.p.id)]);
  check('two execute workers at least one commits',workers.some(w=>w.status==='fulfilled'));
  const retry=await service.execute(actor(failGuild),failing.r.id,failing.p.id);
  check('two workers and retry exactly one receipt',await count('subject_execution_receipts',sql`request_id=${failing.r.id}`)===1&&!!retry.receipt&&Object.values(retry.receipt.deleted).reduce((a,b)=>a+b,0)===5);

  stage='bounded metadata lifecycle';
  const maintenanceGuild=await guild();
  await db.execute(sql`INSERT INTO subject_requests(id,guild_id,subject_user_id,status,denied_by,denied_at,denial_code,terminal_at,requested_at,subject_verified_at) SELECT gen_random_uuid(),${maintenanceGuild},${SUBJECT},'DENIED',${OWNER},statement_timestamp()-interval '800 days','POLICY_RETAINED',statement_timestamp()-interval '800 days',statement_timestamp()-interval '801 days',statement_timestamp()-interval '801 days' FROM generate_series(1,601)`);
  await db.execute(sql`WITH parents AS (INSERT INTO subject_requests(id,guild_id,subject_user_id,status,version,requested_at,subject_verified_at,previewed_by,previewed_at,confirmed_by,confirmed_at,confirmed_preview_id,executed_at,terminal_at) SELECT gen_random_uuid(),${maintenanceGuild},${OTHER},'COMPLETED',3,statement_timestamp()-interval '3501 days',statement_timestamp()-interval '3501 days',${OWNER},statement_timestamp()-interval '3501 days',${OWNER},statement_timestamp()-interval '3501 days',gen_random_uuid(),statement_timestamp()-interval '3500 days',statement_timestamp()-interval '3500 days' FROM generate_series(1,601) RETURNING id) INSERT INTO subject_execution_receipts(request_id,guild_id,subject_user_id,confirmed_by,executed_by,inventory_hash,executed_at,outcome,request_version,deleted_member_levels,deleted_member_reputation,deleted_achievements,deleted_event_participants,deleted_event_attendance,retained_total) SELECT id,${maintenanceGuild},${OTHER},${OWNER},${OWNER},${'a'.repeat(64)},statement_timestamp()-interval '3500 days','COMPLETED',3,0,0,0,0,0,0 FROM parents`);
  const activeAged:string[]=[];
  for(const [i,status] of ['PREVIEWED','CONFIRMED','EXECUTING'].entries()){const id=randomUUID(),subject=`99000000000000012${i}`,confirmed=status!=='PREVIEWED';await insertFixture(db,'subject_requests',{id,guild_id:maintenanceGuild,subject_user_id:subject,status,version:confirmed?2:1,requested_at:new Date('2020-01-01'),subject_verified_at:new Date('2020-01-01'),previewed_by:OWNER,previewed_at:new Date('2020-01-01'),confirmed_by:confirmed?OWNER:null,confirmed_at:confirmed?new Date('2020-01-01'):null,confirmed_preview_id:confirmed?randomUUID():null});activeAged.push(id);}
  const previewParent=await service.createSelfRequest(self(maintenanceGuild));
  await db.execute(sql`INSERT INTO subject_request_previews(id,request_id,guild_id,subject_user_id,reviewed_by,request_version,inventory_hash,eligible_total,retained_total,created_at,expires_at) SELECT gen_random_uuid(),${previewParent.id},${maintenanceGuild},${SUBJECT},${OWNER},0,${'a'.repeat(64)},0,0,statement_timestamp()-interval '3 days',statement_timestamp()-interval '2 days' FROM generate_series(1,601)`);
  await db.execute(sql`INSERT INTO governance_audit_gaps(id,guild_id,actor_user_id,action,target_type,request_id,detected_at) SELECT gen_random_uuid(),${maintenanceGuild},${OWNER},'privacy-deny','privacy-deny','synthetic-old-gap',statement_timestamp()-interval '800 days' FROM generate_series(1,601)`);
  // Distinct terminal rows with old, young and newly-written receipts; active aged rows never expire.
  const terminalPut=async(age:number,receiptAge:number)=>{const id=randomUUID();await db.execute(sql`INSERT INTO subject_requests(id,guild_id,subject_user_id,status,version,requested_at,subject_verified_at,previewed_by,previewed_at,confirmed_by,confirmed_at,confirmed_preview_id,executed_at,terminal_at) VALUES(${id},${maintenanceGuild},${OTHER},'COMPLETED',3,statement_timestamp()-interval '900 days',statement_timestamp()-interval '900 days',${OWNER},statement_timestamp()-interval '900 days',${OWNER},statement_timestamp()-interval '900 days',${randomUUID()},statement_timestamp()-(${age}*interval '1 day'),statement_timestamp()-(${age}*interval '1 day'))`);await db.execute(sql`INSERT INTO subject_execution_receipts(request_id,guild_id,subject_user_id,confirmed_by,executed_by,inventory_hash,executed_at,outcome,request_version,deleted_member_levels,deleted_member_reputation,deleted_achievements,deleted_event_participants,deleted_event_attendance,retained_total) VALUES(${id},${maintenanceGuild},${OTHER},${OWNER},${OWNER},${'a'.repeat(64)},statement_timestamp()-(${receiptAge}*interval '1 day'),'COMPLETED',3,0,0,0,0,0,0)`);return id;};
  const oldReceipt=await terminalPut(800,800),youngReceipt=await terminalPut(729,729),newReceipt=await terminalPut(800,0);
  await db.execute(sql`UPDATE subject_requests SET requested_at=statement_timestamp()-interval '900 days',subject_verified_at=statement_timestamp()-interval '900 days' WHERE id=${previewParent.id}`);
  const validPreview=await insertFixture(db,'subject_request_previews',{id:randomUUID(),request_id:previewParent.id,guild_id:maintenanceGuild,subject_user_id:SUBJECT,reviewed_by:OWNER,request_version:0,inventory_hash:'a'.repeat(64),eligible_total:0,retained_total:0,expires_at:new Date('2035-01-01')});
  stage='recent consumed preview fixture';
  const recentConsumed={id:randomUUID()};
  await db.execute(sql`INSERT INTO subject_request_previews(id,request_id,guild_id,subject_user_id,reviewed_by,request_version,inventory_hash,eligible_total,retained_total,created_at,expires_at,consumed_at) VALUES(${recentConsumed.id},${previewParent.id},${maintenanceGuild},${SUBJECT},${OWNER},0,${'a'.repeat(64)},0,0,statement_timestamp()-interval '1 hour',statement_timestamp()-interval '45 minutes',clock_timestamp())`);
  const markersBefore=await fingerprint(db,sql`SELECT id,transcript_redacted_at,transcript_retention_policy_version FROM tickets WHERE transcript_redacted_at IS NOT NULL ORDER BY id`);
  const first=await runSubjectRequestMaintenance(db);
  check('metadata first prune preview/gap capped500',first.previewsPruned===500&&first.auditGapsPruned===500);
  check('terminal request plus receipt budget saturates500 safely',first.requestsPruned+first.receiptsPruned===500&&first.requestsPruned===250&&first.receiptsPruned===250);
  for(let tick=0;tick<8;tick++){const result=await runSubjectRequestMaintenance(db);check(`bounded finite metadata pass ${tick}`,result.previewsPruned<=500&&result.auditGapsPruned<=500&&result.requestsPruned+result.receiptsPruned<=500);}
  check('601 old terminal parents and old receipt drained',await count('subject_requests',sql`guild_id=${maintenanceGuild} AND status='DENIED'`)===0&&await count('subject_execution_receipts',sql`request_id=${oldReceipt}`)===0);
  check('young/new receipts and parents survive',await count('subject_execution_receipts',sql`request_id IN (${youngReceipt}::uuid,${newReceipt}::uuid)`)===2&&await count('subject_requests',sql`id IN (${youngReceipt}::uuid,${newReceipt}::uuid)`)===2);
  check('aged PENDING request never pruned',await count('subject_requests',sql`id=${previewParent.id}`)===1);
  for(const [i,id] of activeAged.entries())check(`aged ${['PREVIEWED','CONFIRMED','EXECUTING'][i]} request never pruned`,await count('subject_requests',sql`id=${id}`)===1);
  check('all601 old execution receipts drained',await count('subject_execution_receipts',sql`guild_id=${maintenanceGuild} AND executed_at < statement_timestamp()-interval '730 days'`)===0);
  check('all601 old preview and audit gaps drained',await count('subject_request_previews',sql`guild_id=${maintenanceGuild} AND expires_at < statement_timestamp()-interval '24 hours'`)===0&&await count('governance_audit_gaps',sql`guild_id=${maintenanceGuild} AND detected_at < statement_timestamp()-interval '730 days'`)===0);
  check('valid/recent-consumed previews survive',await count('subject_request_previews',sql`id IN (${String(validPreview.id)}::uuid,${String(recentConsumed.id)}::uuid)`)===2);
  check('target V8.2 markers survive governance pruning',markersBefore===await fingerprint(db,sql`SELECT id,transcript_redacted_at,transcript_retention_policy_version FROM tickets WHERE transcript_redacted_at IS NOT NULL ORDER BY id`));
  check('metadata never executes aged active request',(await service.inspect(actor(maintenanceGuild),previewParent.id)).request.status==='PENDING');
  check('minimum comprehensive check count',checks.length>=104);
}catch(error){console.error(JSON.stringify({suite:'v83-subject-db',stage,passed:checks.length,code:code(error),constraint:constraint(error)}));process.exitCode=1;}
finally{
  try{for(const id of guilds){await db.execute(sql`DELETE FROM dashboard_sessions WHERE user_id=${SUBJECT} AND token_hash LIKE 'synthetic-%' AND oauth_guild_ids @> ${JSON.stringify([id])}::jsonb`);await db.execute(sql`DELETE FROM guilds WHERE id=${id}`);}const rows=await db.execute(sql`SELECT (SELECT count(*) FROM guilds)::int AS guilds,(SELECT count(*) FROM subject_requests)::int AS requests,(SELECT count(*) FROM subject_request_previews)::int AS previews,(SELECT count(*) FROM subject_request_preview_counts)::int AS counts,(SELECT count(*) FROM subject_execution_receipts)::int AS receipts,(SELECT count(*) FROM governance_audit_gaps)::int AS gaps`);check('owned fixtures removed and governance empty',Object.values(rows.rows[0]!).every(v=>Number(v)===0));if(!process.exitCode)console.log(JSON.stringify({suite:'v83-subject-db',checks:checks.length,names:checks}));}
  catch(error){console.error(JSON.stringify({suite:'v83-subject-db-cleanup',code:code(error)}));process.exitCode=1;}finally{await pool.end();}
}
