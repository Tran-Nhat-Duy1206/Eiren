import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OperationsDiagnostics, diagnosticQueries, type OperationalDatabase } from '../core/operations/diagnostics.js';
import { probeDatabase, ReadinessService } from '../core/operations/readiness.js';
import { OperationalDatabase as ProductionOperationalDatabase } from '../core/operations/operational-database.js';
import { createDashboardServer, type DashboardWebDeps } from '../dashboard/web.js';

// Explicit synthetic URL only: never load local .env or start a PostgreSQL server here.
const url=process.env.DATABASE_URL;
if(!url)throw new Error('Explicit synthetic DATABASE_URL required');
const target=new URL(url),name=decodeURIComponent(target.pathname.slice(1));
if(!['postgres:','postgresql:'].includes(target.protocol)||!['localhost','127.0.0.1','::1','[::1]'].includes(target.hostname)||!(/^eiren_v8_[a-z0-9_]+$/.test(name)||(process.env.GITHUB_ACTIONS==='true'&&name==='eiren')))throw new Error('Refusing nonisolated operations validation database');
const pool=new pg.Pool({connectionString:url,max:2,query_timeout:2200});
const owned=[`v84-check-${randomUUID()}`,`v84-check-${randomUUID()}`];
let checks=0;
function check(value:unknown){if(!value)throw new Error('Synthetic operations assertion failed');checks++;}
const reader:OperationalDatabase=new ProductionOperationalDatabase(url);
const tables=['automation_executions','automation_action_runs','governance_audit_gaps','community_events','event_reminders','giveaways','giveaway_draws','tempvoice_rooms','tickets','retention_policies','reports','appeals','subject_requests'];
async function snapshot(){const result=[];for(const table of tables){const rows=await pool.query(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS hash FROM ${table} t`);result.push(rows.rows[0].hash);}return JSON.stringify(result);}
try{
  for(const g of owned){
    await pool.query('INSERT INTO guilds(id) VALUES($1)',[g]);
    await pool.query("INSERT INTO automations(guild_id,name,trigger_key,trigger_version,authorized_by,approved_capability) VALUES($1,'synthetic','SCHEDULED',1,'990000000000000001','SEND_MESSAGE')",[g]);
    await pool.query("INSERT INTO automation_executions(id,guild_id,automation_id,trigger_key,module_epoch,config_version,status,created_at,lease_until) SELECT gen_random_uuid(),$1,id,s,0,1,s,statement_timestamp()-interval '2 days',statement_timestamp()-interval '1 second' FROM automations CROSS JOIN unnest(ARRAY['PENDING','RUNNING','UNCERTAIN']) s WHERE guild_id=$1",[g]);
    await pool.query("INSERT INTO automation_execution_actions(execution_id,position,action_key,action_version) SELECT id,0,'STAFF_LOG',1 FROM automation_executions WHERE guild_id=$1 AND status='UNCERTAIN'",[g]);
    await pool.query("INSERT INTO automation_action_runs(execution_id,position,status) SELECT id,0,'UNCERTAIN' FROM automation_executions WHERE guild_id=$1 AND status='UNCERTAIN'",[g]);
    await pool.query("INSERT INTO governance_audit_gaps(id,guild_id,actor_user_id,action,target_type,request_id) VALUES(gen_random_uuid(),$1,'990000000000000001','privacy-preview','privacy-preview','synthetic')",[g]);
    await pool.query("INSERT INTO community_events(guild_id,creator_id,title,description,start_at,end_at,channel_id,status) SELECT $1,'synthetic','synthetic','PRIVATE_SENTINEL',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour','synthetic',s FROM unnest(ARRAY['SCHEDULED','ACTIVE']) s",[g]);
    await pool.query("INSERT INTO event_reminders(event_id,offset_seconds,status,claimed_at) SELECT id,600,'PROCESSING',statement_timestamp()-interval '6 minutes' FROM community_events WHERE guild_id=$1",[g]);
    await pool.query("INSERT INTO giveaways(guild_id,creator_id,channel_id,prize,start_at,end_at,winner_count,status,updated_at) SELECT $1,'synthetic','synthetic','PRIVATE_SENTINEL',statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour',1,s,statement_timestamp()-interval '10 minutes' FROM unnest(ARRAY['ACTIVE','ENDED']) s",[g]);
    await pool.query("INSERT INTO giveaway_draws(giveaway_id,kind,created_at) SELECT id,'ORIGINAL',statement_timestamp()-interval '10 minutes' FROM giveaways WHERE guild_id=$1 AND status='ENDED'",[g]);
    await pool.query("INSERT INTO tempvoice_rooms(guild_id,owner_id,channel_id,status,created_at,updated_at) SELECT $1,s,CASE WHEN s='DELETING' THEN 'synthetic' ELSE NULL END,s,statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '2 minutes' FROM unnest(ARRAY['CREATING','DELETING']) s",[g]);
    await pool.query("INSERT INTO tickets(guild_id,creator_id,type,created_at,transcript,retention_hold,retention_hold_by,retention_hold_at) VALUES($1,'synthetic','SUPPORT',statement_timestamp()-interval '11 minutes','PRIVATE_SENTINEL',true,'synthetic',statement_timestamp())",[g]);
    await pool.query("INSERT INTO retention_policies(guild_id,enabled,confirmed_by,confirmed_at) VALUES($1,true,'synthetic',statement_timestamp())",[g]);
    await pool.query("INSERT INTO subject_requests(id,guild_id,subject_user_id) VALUES(gen_random_uuid(),$1,'990000000000000001')",[g]);
  }
  const before=await snapshot(),diagnostics=new OperationsDiagnostics(reader);
  const a=await diagnostics.inspect(owned[0]!),b=await diagnostics.inspect(owned[1]!);
  check(a.every(r=>r.status!=='UNAVAILABLE'));
  check(a.every((r,i)=>r.count===b[i]!.count));
  check(!JSON.stringify(a).includes('PRIVATE_SENTINEL')&&!JSON.stringify(a).includes(owned[0]!));
  for(const key of ['automation_pending','automation_running','event_reminder_processing','giveaway_presentation_unresolved','giveaway_result_unresolved','giveaway_draw_notify_unresolved','tempvoice_creating','tempvoice_deleting','ticket_channel_unresolved'])check(a.find(r=>r.key===key)?.status==='STALE');
  check(a.find(r=>r.key==='automation_uncertain')?.status==='ACTIONABLE');
  check((await diagnostics.inspect(`v84-absent-${randomUUID()}`)).every(r=>r.count===0||r.status==='NOT_TRACKED'));
  check(before===await snapshot());
  // Controlled database timestamps, no sleeps: leases are fresh, then stale.
  await pool.query("UPDATE giveaways SET updated_at=statement_timestamp() WHERE guild_id=$1",[owned[0]]);
  await pool.query("UPDATE giveaway_draws SET notification_claimed_at=statement_timestamp() WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id=$1)",[owned[0]]);
  const fresh=await diagnostics.inspect(owned[0]!);
  check(fresh.find(r=>r.key==='giveaway_presentation_unresolved')?.status==='PENDING');
  check(fresh.find(r=>r.key==='giveaway_result_unresolved')?.status==='PENDING');
  check(fresh.find(r=>r.key==='giveaway_draw_notify_unresolved')?.status==='AMBIGUOUS');
  // Exact boundary using the PostgreSQL transaction clock consistently for fixture and read.
  // Production remains statement_timestamp(); this test substitutes only the clock expression.
  const boundaryClient=await pool.connect();try{
    await boundaryClient.query('BEGIN');await boundaryClient.query("SET LOCAL statement_timeout='1500ms'");
    for(const age of [0,89,90,91]){
      await boundaryClient.query("UPDATE community_events SET start_at=transaction_timestamp()-($2*interval '1 second'),end_at=transaction_timestamp()-($2*interval '1 second')+interval '1 microsecond' WHERE guild_id=$1 AND status='SCHEDULED'",[owned[0],age]);
      await boundaryClient.query("UPDATE community_events SET start_at=transaction_timestamp()-interval '1 day',end_at=transaction_timestamp()-($2*interval '1 second') WHERE guild_id=$1 AND status='ACTIVE'",[owned[0],age]);
      await boundaryClient.query("UPDATE giveaways SET start_at=transaction_timestamp()-interval '1 day',end_at=transaction_timestamp()-($2*interval '1 second') WHERE guild_id=$1 AND status='ACTIVE'",[owned[0],age]);
      for(const key of ['event_scheduled_overdue','event_active_overdue','giveaway_active_overdue']){
        const q=diagnosticQueries.find(q=>q.key===key)!;
        const result=await boundaryClient.query(q.text.replaceAll('statement_timestamp()','transaction_timestamp()'),[owned[0]]);
        check(Number(result.rows[0].count)===1&&Number(result.rows[0].stale_count)===(age>=90?1:0)&&Number(result.rows[0].age_seconds)===age);
      }
    }
  }finally{await boundaryClient.query('ROLLBACK');boundaryClient.release();}
  // Force indexed alternatives for tiny fixtures; no ANALYZE/migration or production changes.
  const client=await pool.connect();try{
    await client.query('BEGIN READ ONLY');await client.query('SET LOCAL enable_seqscan=off');
    for(const query of diagnosticQueries){const plan=await client.query('EXPLAIN (FORMAT TEXT) '+query.text,[owned[0]]);check(plan.rows.some(r=>String(r['QUERY PLAN']).includes('Index')));}
    await client.query('ROLLBACK');
  }finally{client.release();}
  // Existing migration rows are changed only inside rolled-back synthetic transactions.
  check((await probeDatabase(reader)).migrations==='ready');
  for(const mutation of ["DELETE FROM drizzle.__drizzle_migrations WHERE id=(SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC,id DESC LIMIT 1)","UPDATE drizzle.__drizzle_migrations SET hash='tampered' WHERE id=(SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC,id DESC LIMIT 1)","UPDATE drizzle.__drizzle_migrations SET created_at=created_at+1 WHERE id=(SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC,id DESC LIMIT 1)"]){
    const tx=await pool.connect();try{await tx.query('BEGIN');await tx.query(mutation);await tx.query("SET LOCAL statement_timeout='1500ms'");
      const transactionalReader={query:async<T extends pg.QueryResultRow>(text:string,values?:readonly unknown[])=>{const r=await tx.query<T>(text,values?[...values]:undefined);return{rows:r.rows};}};
      check((await probeDatabase(transactionalReader)).migrations==='mismatch');
      const journalFingerprint=async()=>JSON.stringify((await tx.query("SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY id),'')) AS hash FROM drizzle.__drizzle_migrations t")).rows);
      const tamperedBefore=await journalFingerprint();
      const readiness=new ReadinessService(()=>probeDatabase(transactionalReader),()=>true,()=> 'RUNNING',()=>({v5:'HEALTHY',moderation:'HEALTHY'}));
      // Public health routes require no Discord client/auth/service methods; stubs fail if unexpectedly used.
      const unused=()=>{throw new Error('Unexpected synthetic dependency access');};
      const app=await createDashboardServer({client:{} as DashboardWebDeps['client'],services:{} as DashboardWebDeps['services'],auth:{} as DashboardWebDeps['auth'],access:{} as DashboardWebDeps['access'],read:{} as DashboardWebDeps['read'],audit:{record:async()=>unused()},readiness,baseUrl:'http://127.0.0.1:3081'});
      try{
        const ready=await app.inject('/readyz'),health=await app.inject('/healthz');
        check(ready.statusCode===503&&ready.json().checks.database==='ready'&&ready.json().checks.migrations==='mismatch');
        check(health.statusCode===200&&health.json().status==='ok');
        check(tamperedBefore===await journalFingerprint());
      }finally{await app.close();}
    }finally{await tx.query('ROLLBACK');tx.release();}
  }
  check((await probeDatabase(reader)).migrations==='ready');
  let readOnlyCode='';try{await reader.query('UPDATE guilds SET updated_at=updated_at WHERE false');}catch(error){readOnlyCode=(error as {code?:string}).code??'';}
  check(readOnlyCode==='25006');
  const timeoutStart=performance.now();let timeoutCode='';try{await reader.query('SELECT pg_sleep(5)');}catch(error){timeoutCode=(error as {code?:string}).code??'';}
  check(timeoutCode==='57014'&&performance.now()-timeoutStart<2500);
  check((await reader.query('SELECT 1 AS n')).rows[0]?.n===1);
  console.log(JSON.stringify({suite:'v84-operations-db',checks}));
}catch{console.error(JSON.stringify({suite:'v84-operations-db',checks,error:'synthetic validation failed'}));process.exitCode=1;}
finally{try{for(const g of owned)await pool.query('DELETE FROM guilds WHERE id=$1',[g]);}catch{console.error(JSON.stringify({suite:'v84-operations-db-cleanup',error:'synthetic cleanup failed'}));process.exitCode=1;}finally{await reader.close();await pool.end();}}
