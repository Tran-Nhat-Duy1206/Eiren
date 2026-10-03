import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../core/database/connection.js';
import { insertFixture, SUBJECT, OTHER, PLACEHOLDER } from './v83-subject-fixtures.js';
const primaryUrl=process.env.DATABASE_URL,upgradeUrl=process.env.V8_DISPOSABLE_DATABASE_URL;
if(!primaryUrl||!upgradeUrl)throw new Error('Explicit synthetic primary and disposable upgrade URLs required; no local.env loaded.');
const primary=new URL(primaryUrl),target=new URL(upgradeUrl);
if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]','::1'].includes(target.hostname)||target.host!==primary.host||target.pathname===primary.pathname||!/^eiren_v8_[a-z0-9_]+$/.test(decodeURIComponent(target.pathname.slice(1))))throw new Error('Refusing nonisolated upgrade database.');
const {db,pool}=createDatabase(upgradeUrl),schema=`v83_upgrade_${randomUUID().replaceAll('-','')}`,q=`"${schema}"`;
const checks:string[]=[];let stage='empty guard',created=false;
function check(name:string,value:unknown){if(!value){stage=`assertion: ${name}`;throw new Error('Synthetic upgrade assertion failed');}checks.push(name);}
function code(error:unknown):string{for(let e:any=error;e;e=e.cause)if(typeof e.code==='string')return e.code;return 'ASSERTION';}
try{
  const tables=await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`);
  for(const row of tables.rows){const count=await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(String(row.table_name))}`);if(Number(count.rows[0]!.n)!==0)throw new Error('Upgrade database public data must be empty');}
  check('disposable upgrade database empty',true);
  await db.execute(sql.raw(`CREATE SCHEMA ${q}`));created=true;
  await db.transaction(async tx=>{
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${q}, public`));
    const journal=JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json',import.meta.url),'utf8')) as {entries:{idx:number;tag:string;when:number}[]};
    check('journal21 ordered0000–0020',journal.entries.length===21&&journal.entries.every((e,i)=>e.idx===i&&e.tag.startsWith(`${String(i).padStart(4,'0')}_`)&&(i===0||e.when>journal.entries[i-1]!.when))&&journal.entries[18]!.tag==='0018_neat_tarantula'&&journal.entries[19]!.tag==='0019_fast_molecule_man'&&journal.entries[20]!.tag==='0020_subject_request_governance');
    const apply=async(entry:{idx:number;tag:string})=>{const text=readFileSync(new URL(`../../drizzle/${entry.tag}.sql`,import.meta.url),'utf8');const statements=text.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);check(`actual migration ${entry.tag} nonempty`,statements.length>0);for(const [index,s] of statements.entries()){stage=`${entry.tag} statement ${index+1}`;await tx.execute(sql.raw(s.replaceAll('"public".',`${q}.`)));}};
    for(const entry of journal.entries.slice(0,20))await apply(entry);
    stage='pre0020 synthetic product fixtures';
    const put=(table:string,values:Record<string,unknown>)=>insertFixture(tx,table,values);
    const guild='v83-upgrade-synthetic';await put('guilds',{id:guild});
    await put('member_levels',{guild_id:guild,user_id:SUBJECT,xp:500,message_count:8});
    await put('member_reputation',{guild_id:guild,user_id:SUBJECT,score:9});
    await put('member_achievements',{guild_id:guild,user_id:SUBJECT,achievement_id:'synthetic'});
    const event=await put('community_events',{guild_id:guild,creator_id:OTHER,title:'Synthetic upgrade',description:PLACEHOLDER,start_at:new Date('2020-01-01'),end_at:new Date('2020-01-02'),channel_id:OTHER,status:'COMPLETED',presentation_pending:false});
    await put('event_participants',{event_id:event.id,user_id:SUBJECT});await put('event_attendance',{event_id:event.id,user_id:SUBJECT,marked_by:OTHER});
    const moderation=await put('moderation_cases',{guild_id:guild,target_id:SUBJECT,moderator_id:OTHER,action:'WARN',reason:PLACEHOLDER});
    await put('moderator_notes',{guild_id:guild,target_id:SUBJECT,moderator_id:OTHER,content:PLACEHOLDER});
    await put('reports',{guild_id:guild,reporter_id:SUBJECT,category:'OTHER',description:PLACEHOLDER,evidence_url:PLACEHOLDER,resolution_note:PLACEHOLDER});
    await put('appeals',{guild_id:guild,appellant_id:SUBJECT,case_id:moderation.id,reason:PLACEHOLDER,review_note:PLACEHOLDER});
    await put('retention_policies',{guild_id:guild,enabled:false});
    await put('tickets',{guild_id:guild,creator_id:SUBJECT,type:'SUPPORT',transcript:PLACEHOLDER,retention_hold:true,retention_hold_by:OTHER,retention_hold_at:new Date('2020-01-01')});
    const redacted=await put('tickets',{guild_id:guild,creator_id:SUBJECT,type:'SUPPORT',status:'CLOSED',closed_at:new Date('2020-01-01'),transcript_redacted_at:new Date('2020-01-02'),transcript_retention_policy_version:0});
    await put('retention_receipts',{guild_id:guild,domain:'TICKET',record_id:redacted.id,policy_version:0,policy_authorizer_id:OTHER});
    const families=['guilds','member_levels','member_reputation','member_achievements','community_events','event_participants','event_attendance','moderation_cases','moderator_notes','reports','appeals','retention_policies','tickets','retention_receipts'];
    const snapshot=new Map<string,string>();for(const family of families){const rows=await tx.execute(sql`SELECT row_to_json(t) AS row FROM ${sql.identifier(family)} t ORDER BY row_to_json(t)::text`);snapshot.set(family,JSON.stringify(rows.rows));}
    const final=journal.entries[20]!;const ddl=readFileSync(new URL(`../../drizzle/${final.tag}.sql`,import.meta.url),'utf8');
    check('0020 additiveDDL only no migration-time mutations',ddl.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).every(s=>/^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE)\b/.test(s)));
    await apply(final);stage='post0020 preservation';
    for(const family of families){const rows=await tx.execute(sql`SELECT row_to_json(t) AS row FROM ${sql.identifier(family)} t ORDER BY row_to_json(t)::text`);check(`0020 preserves exact ${family} product bytes`,snapshot.get(family)===JSON.stringify(rows.rows));}
    for(const family of ['subject_requests','subject_request_previews','subject_request_preview_counts','subject_execution_receipts','governance_audit_gaps']){const rows=await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(family)}`);check(`0020 creates empty ${family} no implicit workflow`,Number(rows.rows[0]!.n)===0);}
    const policy=await tx.execute(sql`SELECT enabled FROM retention_policies WHERE guild_id=${guild}`);check('0020 leaves retention OFF no auto-optin',policy.rows[0]!.enabled===false);
  });
}catch(error){console.error(JSON.stringify({suite:'v83-subject-upgrade',stage,passed:checks.length,code:code(error)}));process.exitCode=1;}
finally{try{if(created)await db.execute(sql.raw(`DROP SCHEMA ${q} CASCADE`));const remains=await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name=${schema}`);check('owned upgrade schema removed',Number(remains.rows[0]!.n)===0);if(!process.exitCode)console.log(JSON.stringify({suite:'v83-subject-upgrade',checks:checks.length,names:checks}));}finally{await pool.end();}}
