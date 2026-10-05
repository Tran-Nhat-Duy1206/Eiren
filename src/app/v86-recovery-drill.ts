// V8.6: disposable synthetic databases only. This is not an operator repair command.
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const migrationsFolder=fileURLToPath(new URL('../../drizzle/',import.meta.url));
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DataRetentionService } from '../modules/data-retention/service.js';
import { runRetentionMaintenance } from '../modules/data-retention/maintenance.js';
import { SubjectRequestService } from '../modules/subject-requests/service.js';
import { PermissionService } from '../core/permissions/permission-service.js';
import { canonicalManifestText, parseRecoveryManifest } from '../core/recovery/manifest.js';
import { exportRecoveryManifest, verifyRecovery } from '../core/recovery/verify.js';
import { writePrivateJsonFile, readPrivateManifestFile } from '../core/recovery/io.js';
import * as schema from '../core/database/schema.js';

const A='990000000000000001', SUBJECT='990000000000000002', OWNER='990000000000000003';
const B='991000000000000001', OTHER='991000000000000003';
const SENTINEL='V86_SYNTHETIC_PRIVATE_SENTINEL_NEVER_EXPORT_8ab51';
const actor={guildId:A,userId:OWNER,guildOwnerId:OWNER,roleIds:[]};
const checks:string[]=[];
let stage='configuration', interrupted=false, cleaning=false, connectionLost=false, running:ChildProcess|undefined;
// Consume asynchronous driver errors without logging raw driver diagnostics.
// The next awaited stage/check fails safely; cleanup remains permitted.
function onConnectionError(){connectionLost=true;if(!cleaning)running?.kill();}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{interrupted=true;if(!cleaning)running?.kill();});
function check(label:string,value:unknown):asserts value { if(!value){stage='assertion: '+label;throw new Error('Synthetic assertion failed');}if((interrupted||connectionLost)&&!cleaning)throw new Error('Interrupted or connection lost');checks.push(label); }
const cliEnv=Object.fromEntries(['PATH','SystemRoot','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','DOCKER_CONFIG'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]!]));
function adminAddress(){
  check('explicit synthetic confirmation',process.env.RECOVERY_DRILL_CONFIRM==='isolated-synthetic-only');
  const explicit=process.env.RECOVERY_DRILL_DATABASE_URL;
  const u=new URL(explicit??process.env.DATABASE_URL??'');
  const name=decodeURIComponent(u.pathname.slice(1));
  check('plain loopback PostgreSQL admin URL',['postgres:','postgresql:'].includes(u.protocol)&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&!!u.username&&!!u.password&&!u.search&&!u.hash&&/^[a-z][a-z0-9_]{0,62}$/.test(name));
  check('synthetic admin address',/^eiren_v8_[a-z0-9_]+$/.test(name)||(process.env.GITHUB_ACTIONS==='true'&&name==='eiren'));
  u.pathname='/postgres';return u;
}
async function connect(url:URL){
  const c=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000});
  c.on('error',onConnectionError);
  try{await c.connect();if(connectionLost&&!cleaning)throw new Error('Connection lost');return c;}
  catch{await c.end().catch(()=>undefined);throw new Error('Connection unavailable');}
}
async function toolRun(executable:string,args:string[],env:NodeJS.ProcessEnv,file?:string,cleanup=false){
  if((interrupted||connectionLost)&&!cleanup)throw new Error('Interrupted or connection lost');
  const handle=file?await open(file,'w',0o600):undefined;
  try{await new Promise<void>((ok,reject)=>{
    const child=spawn(executable,args,{env,stdio:['ignore',handle?.fd??'ignore','ignore'],shell:false,windowsHide:true});running=child;
    const timer=setTimeout(()=>{child.kill();},cleanup?60000:90000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Tool unavailable'));});
    child.once('close',code=>{clearTimeout(timer);if(code===0&&((!interrupted&&!connectionLost)||cleanup))ok();else reject(new Error('Tool failed'));});
  });}finally{running=undefined;await handle?.close();}
}
// These snapshots operate only on the freshly created, owned synthetic databases.
// PostgreSQL hashes controlled fixture payloads server-side; Node receives only count/hash.
async function snapshot(c:pg.Client){
  const tables=(await c.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename")).rows as {schemaname:string;tablename:string}[];
  const values=[];
  for(const t of tables){
    const q=(s:string)=>'"'+s.replaceAll('"','""')+'"';
    const r=await c.query(`SELECT count(*)::text AS n,md5(COALESCE(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) AS h FROM ${q(t.schemaname)}.${q(t.tablename)} t`);
    values.push([t.schemaname,t.tablename,r.rows[0].n,r.rows[0].h]);
  }
  const catalog=await c.query("SELECT md5(COALESCE(string_agg(c.oid::text||':'||c.relname::text||':'||c.relkind::text,'' ORDER BY c.oid),'')) AS h FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle')");
  return JSON.stringify([values,catalog.rows]);
}
async function guildBSnapshot(c:pg.Client){
  const values=[];
  for(const table of ['tickets','reports','appeals','member_levels','member_reputation','member_achievements','reputation_grants','community_events']){
    const r=await c.query(`SELECT count(*)::text AS n,md5(COALESCE(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) AS h FROM ${table} t WHERE guild_id=$1`,[B]);values.push([table,r.rows[0]]);
  }
  for(const table of ['event_participants','event_attendance']){
    const r=await c.query(`SELECT count(*)::text AS n,md5(COALESCE(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) AS h FROM ${table} t JOIN community_events e ON e.id=t.event_id WHERE e.guild_id=$1`,[B]);values.push([table,r.rows[0]]);
  }
  return JSON.stringify(values);
}
async function seed(c:pg.Client){
  await c.query('INSERT INTO guilds(id) VALUES($1),($2)',[A,B]);
  const ids:Record<string,string>={};
  for(const guild of [A,B]){
    for(const [key,table,columns,values] of [
      ['ticket','tickets','creator_id,type,status,closed_at,transcript',[SUBJECT,'SUPPORT','CLOSED','2020-01-01',SENTINEL]],
      ['report','reports','reporter_id,category,status,closed_at,description,evidence_url,resolution_note',[SUBJECT,'OTHER','CLOSED','2020-01-01',SENTINEL,SENTINEL,SENTINEL]],
      ['appeal','appeals','appellant_id,status,reviewed_at,reason,review_note',[SUBJECT,'REJECTED','2020-01-01',SENTINEL,SENTINEL]],
    ] as const){
      const r=await c.query(`INSERT INTO ${table}(guild_id,${columns}) VALUES(${[guild,...values].map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id::text`,[guild,...values]);
      ids[guild===A?key:`b_${key}`]=String(r.rows[0].id);
    }
    for(const table of ['member_levels','member_reputation'])await c.query(`INSERT INTO ${table}(guild_id,user_id) VALUES($1,$2)`,[guild,SUBJECT]);
    await c.query('INSERT INTO member_achievements(guild_id,user_id,achievement_id) VALUES($1,$2,$3)',[guild,SUBJECT,'first-message']);
    await c.query('INSERT INTO reputation_grants(guild_id,giver_id,receiver_id,interaction_id) VALUES($1,$2,$3,$4)',[guild,OTHER,SUBJECT,`synthetic-${guild}`]);
    for(const status of ['COMPLETED','ACTIVE','SCHEDULED']){
      const r=await c.query('INSERT INTO community_events(guild_id,creator_id,title,description,start_at,end_at,channel_id,status,presentation_pending) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false) RETURNING id::text',[guild,OTHER,'Synthetic fixture',SENTINEL,'2020-01-01','2020-01-02',OTHER,status]);
      const id=String(r.rows[0].id);ids[`${guild===A?'a':'b'}_${status}`]=id;
      await c.query('INSERT INTO event_participants(event_id,user_id) VALUES($1,$2)',[id,SUBJECT]);
      await c.query('INSERT INTO event_attendance(event_id,user_id,marked_by) VALUES($1,$2,$3),($1,$3,$2)',[id,SUBJECT,OTHER]);
    }
  }
  const held=await c.query('INSERT INTO tickets(guild_id,creator_id,type,status,transcript) VALUES($1,$2,$3,$4,$5) RETURNING id::text',[A,OTHER,'SUPPORT','OPEN',SENTINEL]);ids.hold=String(held.rows[0].id);
  return ids;
}

async function main(){
  const started=Date.now(),adminUrl=adminAddress();
  const container=process.env.RECOVERY_PG17_CONTAINER??process.env.RESTORE_PG17_CONTAINER;
  check('CI container allowlist',!container||(process.env.GITHUB_ACTIONS==='true'&&/^[a-f0-9]{12,64}$/.test(container)&&adminUrl.hostname==='127.0.0.1'&&(adminUrl.port||'5432')==='5432'));
  const suffix=randomUUID().replaceAll('-',''),names=[`eiren_recovery_${suffix}_source`,`eiren_recovery_${suffix}_target`];
  check('owned database name bounds',names.every(n=>/^eiren_recovery_[a-z0-9_]+$/.test(n)&&n.length<=63));
  const urls=names.map(name=>{const u=new URL(adminUrl);u.pathname='/'+name;return u;});
  const markers=names.map(()=>randomInt(1000000000,2000000000));
  const attempted:boolean[]=[false,false];
  let admin:pg.Client|undefined,source:pg.Client|undefined,target:pg.Client|undefined,pool:pg.Pool|undefined,directory:string|undefined,archive:string|undefined;
  const execPg=async(name:string,args:string[],file?:string,cleanup=false)=>{
    const executable=process.env.PG17_BIN?resolve(process.env.PG17_BIN,process.platform==='win32'?name+'.exe':name):(process.platform==='win32'?name+'.exe':name);
    await toolRun(container?'docker':executable,container?['exec','--user','postgres',container,name,...args]:args,container?cliEnv:{...cliEnv,PGPASSWORD:decodeURIComponent(adminUrl.password)},file,cleanup);
  };
  const connectionArgs=container?['-U',decodeURIComponent(adminUrl.username)]:['--host',adminUrl.hostname==='[::1]'?'::1':adminUrl.hostname,'--port',adminUrl.port||'5432','--username',decodeURIComponent(adminUrl.username)];
  try{
    admin=await connect(adminUrl);
    check('PostgreSQL server 17',Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)>=170000&&Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)<180000);
    directory=await mkdtemp(join(tmpdir(),'eiren-v86-recovery-'));await chmod(directory,0o700);
    if(container){
      stage='container identity';const file=join(directory,'identity');
      const expected=String((await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id);
      await toolRun('docker',['exec','--user','postgres',container,'psql','-U',decodeURIComponent(adminUrl.username),'-d','postgres','-A','-t','-c','SELECT system_identifier::text FROM pg_control_system()'],cliEnv,file);
      check('same CI PostgreSQL service',(await readFile(file,'utf8')).trim()===expected);
    }
    stage='native tools';const versionFile=join(directory,'version');
    for(const tool of ['pg_dump','pg_restore']){await execPg(tool,['--version'],versionFile);check(`${tool} 17`,/\(PostgreSQL\) 17(?:\.|\s|$)/.test(await readFile(versionFile,'utf8')));}
    for(let i=0;i<2;i++){
      stage='create owned database';check('database previously nonexistent',!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[names[i]])).rowCount);
      attempted[i]=true;await admin.query(`CREATE DATABASE "${names[i]}" TEMPLATE template0 ENCODING 'UTF8' CONNECTION LIMIT ${markers[i]}`);
    }
    stage='migration';pool=new pg.Pool({connectionString:urls[0]!.toString(),max:2,connectionTimeoutMillis:5000,statement_timeout:10000});
    pool.on('error',onConnectionError);
    const db=drizzle(pool,{schema});
    const journal=JSON.parse(await readFile(join(migrationsFolder,'meta','_journal.json'),'utf8')).entries as {idx:number;tag:string;when:number}[];
    check('approved exactly 21 migrations',journal.length===21&&journal[20]?.tag==='0020_subject_request_governance'&&journal.every((j,i)=>j.idx===i&&j.tag.startsWith(String(i).padStart(4,'0'))));
    await migrate(db,{migrationsFolder});source=await connect(urls[0]!);
    const applied=(await source.query('SELECT created_at::text AS at,hash FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    check('21 actual migrations',applied.length===21);
    for(let i=0;i<21;i++){
      const text=await readFile(join(migrationsFolder,journal[i]!.tag+'.sql'),'utf8');
      const lf=text.replaceAll('\r\n','\n');const variants=[text,lf,lf.replaceAll('\n','\r\n')].map(s=>createHash('sha256').update(s).digest('hex'));
      check('migration timestamp and explicit LF/CRLF hash',applied[i].at===String(journal[i]!.when)&&variants.includes(applied[i].hash));
    }
    stage='fixture';const ids=await seed(source);
    check('T0 no newer receipts',!(await source.query('SELECT 1 FROM retention_receipts UNION ALL SELECT 1 FROM subject_execution_receipts')).rowCount);
    archive=container?`/tmp/eiren-v86-${suffix}.dump`:join(directory,'old-t0.dump');
    stage='backup T0';
    if(container)await toolRun('docker',['exec','--user','postgres',container,'sh','-c','umask 077; exec "$@"','v86','pg_dump',...connectionArgs,'--format=custom','--no-owner','--no-acl','--no-blobs','--file',archive,names[0]!],cliEnv);
    else {const h=await open(archive,'wx',0o600);await h.close();await execPg('pg_dump',[...connectionArgs,'--format=custom','--no-owner','--no-acl','--no-blobs','--file',archive,names[0]!]);await chmod(archive,0o600);}
    stage='approved synthetic T1';const retention=new DataRetentionService(db);
    const policyPreview=await retention.preview(actor,{ticketDays:30,reportDays:90,appealDays:90});await retention.confirm(actor,policyPreview.id);
    await retention.setHold(actor,'TICKET',Number(ids.hold));
    const redacted=await runRetentionMaintenance(db);
    check('actual three domain redactions',redacted.ticket===1&&redacted.report===1&&redacted.appeal===1);
    const subjectService=new SubjectRequestService(db,new PermissionService({getRoleLevels:async()=>[]}));
    const request=await subjectService.createSelfRequest({inGuild:()=>true,guildId:A,user:{id:SUBJECT},guild:{id:A,members:{fetch:async options=>{check('forced synthetic own membership',options.force&&options.user===SUBJECT);return{id:SUBJECT,guild:{id:A}};}}}});
    const preview=await subjectService.preview(actor,request.id);await subjectService.confirm(actor,request.id,preview.id);
    const executed=await subjectService.execute(actor,request.id,preview.id);
    check('actual five erased families',executed.receipt&&Object.values(executed.receipt.deleted).every(n=>n===1));
    stage='export';const exported=await exportRecoveryManifest(urls[0]!.toString());
    const text=canonicalManifestText(exported);check('manifest excludes synthetic private sentinel',!text.includes(SENTINEL));
    const manifestPath=join(directory,'obligations.json');await writePrivateJsonFile(manifestPath,exported);
    const diskText=await readPrivateManifestFile(manifestPath);
    check('on-disk manifest excludes synthetic private sentinel',!diskText.includes(SENTINEL));
    const manifest=parseRecoveryManifest(diskText);
    check('independent file parse canonical digest roundtrip',canonicalManifestText(manifest)===text&&manifest.digest===exported.digest);
    check('manifest file has actual obligations',manifest.retentionReceipts.length===3&&manifest.activeHolds.length===1&&manifest.retentionPolicies.length===1&&manifest.subjectExecutionReceipts.length===1);
    check('manifest file approved migration metadata',manifest.migrationCount===21&&manifest.latestMigrationTag==='0020_subject_request_governance');
    if(process.platform!=='win32')check('manifest file private Unix mode',((await stat(manifestPath)).mode&0o777)===0o600);
    stage='restore T0';await execPg('pg_restore',[...connectionArgs,'--dbname',names[1]!,'--exit-on-error','--single-transaction','--no-owner','--no-acl',archive]);
    target=await connect(urls[1]!);
    // Every verification is bracketed by complete controlled-fixture row-count/hash snapshots.
    const verify=async(label:string)=>{const before=await snapshot(target!);const report=await verifyRecovery(urls[1]!.toString(),manifest,{confirmation:'isolated-restored-target',sourceDatabaseUrl:urls[0]!.toString()});check(label+' read-only whole synthetic database',before===await snapshot(target!));return report;};
    stage='blocked check';const blocked=await verify('old backup');
    console.log(JSON.stringify({version:'V8.6',syntheticOnly:true,stage:'old_backup_check',verificationStage:blocked.stage,status:blocked.status,counts:blocked.counts}));
    check('old backup blocked',blocked.status==='BLOCKED');
    check('three redaction replay obligations',blocked.counts.REDACTION_REPLAY_REQUIRED===3);
    check('hold reapply obligation',blocked.counts.HOLD_REAPPLY_REQUIRED===1);
    check('policy mismatch obligation',blocked.counts.POLICY_STATE_MISMATCH===1);
    check('five-family subject replay obligation',blocked.counts.SUBJECT_ERASURE_REPLAY_REQUIRED===1);
    check('target receipt genuinely absent',!(await target.query('SELECT 1 FROM subject_execution_receipts')).rowCount);
    const bBefore=await guildBSnapshot(target);
    stage='correct known synthetic fixture';
    // Deliberately fixture-local, not exported, not an arbitrary repair algorithm.
    const policy=manifest.retentionPolicies.find(p=>p.guildId===A)!;
    await target.query('INSERT INTO retention_policies(guild_id,enabled,ticket_retention_days,report_retention_days,appeal_retention_days,version,confirmed_by,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[A,policy.enabled,policy.ticketDays,policy.reportDays,policy.appealDays,policy.version,policy.confirmedBy,policy.confirmedAt]);
    const hold=manifest.activeHolds.find(h=>h.guildId===A&&h.domain==='TICKET'&&h.recordId===ids.hold)!;
    await target.query('UPDATE tickets SET retention_hold=true,retention_hold_by=$3,retention_hold_at=$4 WHERE guild_id=$1 AND id=$2',[A,ids.hold,hold.heldBy,hold.heldAt]);
    for(const [key,table,marker,version,payload] of [
      ['ticket','tickets','transcript_redacted_at','transcript_retention_policy_version','transcript=NULL'],
      ['report','reports','narrative_redacted_at','narrative_retention_policy_version','description=NULL,evidence_url=NULL,resolution_note=NULL'],
      ['appeal','appeals','narrative_redacted_at','narrative_retention_policy_version','reason=NULL,review_note=NULL'],
    ] as const){const metadata=(await source.query(`SELECT ${marker} AS at,${version} AS v FROM ${table} WHERE guild_id=$1 AND id=$2`,[A,ids[key]])).rows[0];await target.query(`UPDATE ${table} SET ${payload},${marker}=$3,${version}=$4 WHERE guild_id=$1 AND id=$2`,[A,ids[key],metadata.at,metadata.v]);}
    for(const table of ['member_levels','member_reputation'])await target.query(`DELETE FROM ${table} WHERE guild_id=$1 AND user_id=$2`,[A,SUBJECT]);
    await target.query('DELETE FROM member_achievements WHERE guild_id=$1 AND user_id=$2 AND achievement_id=$3',[A,SUBJECT,'first-message']);
    for(const table of ['event_participants','event_attendance'])await target.query(`DELETE FROM ${table} t USING community_events e WHERE e.id=t.event_id AND e.guild_id=$1 AND e.id=$3 AND t.user_id=$2`,[A,SUBJECT,ids.a_COMPLETED]);
    stage='corrected check';check('corrected fixture ready',(await verify('corrected')).status==='PASS');
    check('GuildB every synthetic fixture family unchanged',bBefore===await guildBSnapshot(target));
    for(const status of ['ACTIVE','SCHEDULED'])for(const table of ['event_participants','event_attendance'])check('active and scheduled retained',(await target.query(`SELECT 1 FROM ${table} WHERE event_id=$1 AND user_id=$2`,[ids['a_'+status],SUBJECT])).rowCount===1);
    check('marked_by-only accountability retained',(await target.query('SELECT 1 FROM event_attendance WHERE event_id=$1 AND user_id=$2 AND marked_by=$3',[ids.a_COMPLETED,OTHER,SUBJECT])).rowCount===1);
    check('reputation grant retained',(await target.query('SELECT 1 FROM reputation_grants WHERE guild_id=$1 AND receiver_id=$2',[A,SUBJECT])).rowCount===1);
    stage='ambiguous check';await target.query('UPDATE community_events SET presentation_pending=true WHERE guild_id=$1 AND id=$2',[A,ids.a_COMPLETED]);
    await target.query('INSERT INTO event_participants(event_id,user_id) VALUES($1,$2)',[ids.a_COMPLETED,SUBJECT]);
    check('terminal pending ambiguous',(await verify('ambiguous')).counts.AMBIGUOUS_REVIEW_REQUIRED===1);
    await target.query('DELETE FROM event_participants t USING community_events e WHERE e.id=t.event_id AND e.guild_id=$1 AND e.id=$3 AND t.user_id=$2',[A,SUBJECT,ids.a_COMPLETED]);
    check('pending with no resurrected eligible row ready',(await verify('final corrected')).status==='PASS');
    stage='invalid manifest';const invalid={...manifest,digest:'0'.repeat(64)};
    const before=await snapshot(target);const invalidReport=await verifyRecovery(urls[1]!.toString(),invalid,{confirmation:'isolated-restored-target',sourceDatabaseUrl:urls[0]!.toString()});
    check('tampered digest rejected',invalidReport.counts.MANIFEST_INVALID===1);check('invalid failure unchanged',before===await snapshot(target));
    stage='migration failure injections';
    const journalRow=(await target.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1')).rows[0];
    await target.query('DELETE FROM drizzle.__drizzle_migrations WHERE id=$1',[journalRow.id]);
    check('missing migration rejected',(await verify('missing migration')).counts.MIGRATION_MISMATCH===1);
    await target.query('INSERT INTO drizzle.__drizzle_migrations(id,hash,created_at) VALUES($1,$2,$3)',[journalRow.id,journalRow.hash,journalRow.created_at]);
    await target.query('UPDATE drizzle.__drizzle_migrations SET hash=$2 WHERE id=$1',[journalRow.id,'0'.repeat(64)]);
    check('mismatched migration rejected',(await verify('mismatched migration')).counts.MIGRATION_MISMATCH===1);
    await target.query('UPDATE drizzle.__drizzle_migrations SET hash=$2 WHERE id=$1',[journalRow.id,journalRow.hash]);
    check('journal restored ready',(await verify('journal restored')).status==='PASS');
    stage='target isolation injection';const isolationBefore=await snapshot(target);
    const refused=await verifyRecovery(urls[1]!.toString(),manifest,{confirmation:'isolated-restored-target',sourceDatabaseUrl:urls[1]!.toString()});
    check('same source target rejected',refused.counts.UNAVAILABLE===1);check('isolation failure unchanged',isolationBefore===await snapshot(target));
    stage='unavailable backend injection';const unavailableUrl=new URL(urls[1]!);unavailableUrl.port='1';
    const unavailableBefore=await snapshot(target);
    const unavailable=await verifyRecovery(unavailableUrl.toString(),manifest,{confirmation:'isolated-restored-target',sourceDatabaseUrl:urls[0]!.toString()});
    check('unavailable loopback backend blocked',unavailable.status==='BLOCKED'&&unavailable.counts.UNAVAILABLE===1);check('unavailable backend failure unchanged',unavailableBefore===await snapshot(target));
    stage='missing manifest field injection';const {subjectExecutionReceipts:omitted,...missingField}=manifest;void omitted;
    const missingBefore=await snapshot(target);
    const missing=await verifyRecovery(urls[1]!.toString(),missingField as typeof manifest,{confirmation:'isolated-restored-target',sourceDatabaseUrl:urls[0]!.toString()});
    check('missing mandatory manifest field rejected',missing.counts.MANIFEST_INVALID===1);check('missing manifest field failure unchanged',missingBefore===await snapshot(target));
  } finally {
    const previous=stage;stage='cleanup';cleaning=true;
    await target?.end().catch(()=>{process.exitCode=1;});await source?.end().catch(()=>{process.exitCode=1;});await pool?.end().catch(()=>{process.exitCode=1;});
    for(let i=1;i>=0;i--)if(attempted[i]){
      let keeper=admin,reconnected=false;
      try{
        let row;try{row=(await keeper!.query('SELECT datconnlimit,datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_database WHERE datname=$1',[names[i]])).rows[0];}
        catch{keeper=await connect(adminUrl);reconnected=true;row=(await keeper.query('SELECT datconnlimit,datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_database WHERE datname=$1',[names[i]])).rows[0];}
        if(row){check('cleanup only uniquely owned database',row.owned&&row.datconnlimit===markers[i]);await keeper!.query(`DROP DATABASE "${names[i]}" WITH (FORCE)`);}
      }catch{process.exitCode=1;}finally{if(reconnected)await keeper?.end().catch(()=>{process.exitCode=1;});}
    }
    await admin?.end().catch(()=>{process.exitCode=1;});
    if(archive){if(container)await toolRun('docker',['exec','--user','postgres',container,'rm','-f','--',archive],cliEnv,undefined,true).catch(()=>{process.exitCode=1;});else await rm(archive,{force:true}).catch(()=>{process.exitCode=1;});}
    if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>{process.exitCode=1;});
    if(!process.exitCode)stage=previous;
  }
  check('no asynchronous connection loss',!connectionLost);
  if(interrupted||connectionLost||process.exitCode)throw new Error('Interrupted, connection lost or cleanup failed');
  console.log(JSON.stringify({version:'V8.6',syntheticOnly:true,migrationCount:21,latestMigrationTag:'0020_subject_request_governance',assertions:checks.length,outcomes:['BLOCKED','READY','AMBIGUOUS','READY','MANIFEST_INVALID'],durationMs:Date.now()-started,ownedDatabasesRemoved:2}));
}
main().catch(()=>{console.error(`V8.6 recovery drill failed at ${stage}; private details suppressed`);process.exitCode=1;});
