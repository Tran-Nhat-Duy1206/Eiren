import { describe,it,expect,vi } from 'vitest';
import { SubjectRequestService } from './service.js';
import { CATEGORIES,DENIAL_CODES,STATUSES,SCOPE_WARNING,WORKFLOW_EVIDENCE_WARNING } from './contracts.js';
import { countsEqual,key,owner } from './repository.js';
const guildId='990000000000000001',userId='990000000000000002';
const actor={guildId,userId,guildOwnerId:'990000000000000003',roleIds:[]};
const ownerActor={...actor,userId:actor.guildOwnerId};
const requestId='123e4567-e89b-42d3-a456-426614174000',previewId='123e4567-e89b-42d3-a456-426614174001';
function stateDatabase(status:typeof STATUSES[number],withReceipt=false){
  const at='2026-01-01T00:00:00.000Z',confirmed=['CONFIRMED','EXECUTING','COMPLETED','PARTIAL'].includes(status),completed=['COMPLETED','PARTIAL'].includes(status);
  const row={id:requestId,guild_id:guildId,subject_user_id:userId,status,version:status==='PENDING'?0:4,requested_at:at,subject_verified_at:at,verification_method:'SELF_GUILD_MEMBER',
    previewed_by:status==='PENDING'?null:ownerActor.userId,previewed_at:status==='PENDING'?null:at,confirmed_by:confirmed?ownerActor.userId:null,confirmed_at:confirmed?at:null,confirmed_preview_id:confirmed?previewId:null,
    executed_at:completed?at:null,denied_by:status==='DENIED'?ownerActor.userId:null,denied_at:status==='DENIED'?at:null,denial_code:status==='DENIED'?'POLICY_RETAINED':null,terminal_at:completed||status==='DENIED'?at:null};
  const execute=vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[row]});
  if(withReceipt) execute.mockResolvedValueOnce({rows:[{request_id:requestId,guild_id:guildId,subject_user_id:userId,confirmed_by:ownerActor.userId,executed_by:ownerActor.userId,inventory_hash:'a'.repeat(64),executed_at:at,outcome:status,request_version:4,deleted_member_levels:1,deleted_member_reputation:0,deleted_achievements:0,deleted_event_participants:0,deleted_event_attendance:0,retained_total:status==='PARTIAL'?1:0}]});
  execute.mockRejectedValue(new Error('Unexpected query after workflow state fence'));
  const db={transaction:vi.fn(async(action:(tx:unknown)=>Promise<unknown>)=>action({execute}))};
  return {row,execute,service:new SubjectRequestService(db as never,{require:vi.fn()})};
}
describe('subject privacy service boundaries',()=>{
  it('has fixed bounded categories statuses and denial codes, with honest copy/point-in-time warning',()=>{
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length);expect(STATUSES).toContain('EXECUTING');expect(DENIAL_CODES).toHaveLength(5);
    expect(SCOPE_WARNING).toContain('historical backups');expect(SCOPE_WARNING).toContain('Future activity');expect(WORKFLOW_EVIDENCE_WARNING).toContain('Other governance history');
  });
  it('requires actual owner, not rank or role mappings, before destructive database access',async()=>{
    const db={execute:vi.fn(),transaction:vi.fn()};const permissions={require:vi.fn()};const service=new SubjectRequestService(db as never,permissions);
    for(const action of [()=>service.confirm(actor,'bad','bad'),()=>service.execute(actor,'bad','bad'),()=>service.deny(actor,'bad','POLICY_RETAINED')])await expect(action()).rejects.toMatchObject({code:'PERMISSION'});
    expect(db.transaction).not.toHaveBeenCalled();expect(permissions.require).not.toHaveBeenCalled();
    expect(()=>owner({...actor,userId:actor.guildOwnerId})).not.toThrow();
  });
  it('fails closed for DM, unverifiable membership or mismatched returned identity, never accepting a subject parameter',async()=>{
    const db={execute:vi.fn(),transaction:vi.fn()};const service=new SubjectRequestService(db as never,{require:vi.fn()});
    const fetch=vi.fn(async()=>({id:'990000000000000099',guild:{id:guildId}}));
    const interaction={inGuild:()=>true,guildId,user:{id:userId},guild:{id:guildId,members:{fetch}}};
    await expect(service.createSelfRequest({...interaction,inGuild:()=>false})).rejects.toMatchObject({code:'VALIDATION'});
    await expect(service.createSelfRequest(interaction)).rejects.toMatchObject({code:'PERMISSION'});
    expect(fetch).toHaveBeenCalledWith({user:userId,force:true});
    fetch.mockRejectedValueOnce(new Error('not a member'));
    await expect(service.createSelfRequest(interaction)).rejects.toMatchObject({code:'PERMISSION'});expect(db.transaction).not.toHaveBeenCalled();
  });
  it('requires ADMIN review and validates UUIDs without a cast scan',async()=>{
    const db={execute:vi.fn(),transaction:vi.fn()};const service=new SubjectRequestService(db as never,{require:vi.fn().mockRejectedValue(new Error('denied'))});
    await expect(service.list(actor)).rejects.toThrow('denied');await expect(service.preview(actor,'bad')).rejects.toThrow('denied');expect(db.execute).not.toHaveBeenCalled();
    expect(()=>key('bad')).toThrow();expect(()=>key('123e4567-e89b-42d3-a456-426614174000')).not.toThrow();
  });
  it('sanitizes direct and wrapped PostgreSQL failures without retaining SQL or content',async()=>{
    const db={transaction:vi.fn().mockRejectedValue({message:'PRIVATE_SQL_SENTINEL',cause:{code:'40001',message:'PRIVATE_SQL_SENTINEL'}})};
    const service=new SubjectRequestService(db as never,{require:vi.fn()});
    const conflict=service.preview(actor,'123e4567-e89b-42d3-a456-426614174000');
    await expect(conflict).rejects.toMatchObject({code:'CONFLICT'});
    await conflict.catch(error=>{expect(error.cause).toBeUndefined();expect(error.message).not.toContain('PRIVATE_SQL_SENTINEL');});
    db.transaction.mockRejectedValueOnce(new Error('PRIVATE_SQL_SENTINEL'));
    const failure=service.preview(actor,'123e4567-e89b-42d3-a456-426614174000');
    await expect(failure).rejects.toMatchObject({code:'DATABASE'});
    await failure.catch(error=>{expect(error.cause).toBeUndefined();expect(error.message).not.toContain('PRIVATE_SQL_SENTINEL');});
  });
  it.each(['CONFIRMED','EXECUTING','COMPLETED','PARTIAL','DENIED'] as const)('rejects preview from %s for ADMIN and actual owner before any inventory or mutation',async status=>{
    for(const reviewer of [actor,ownerActor]){
      const f=stateDatabase(status),before=structuredClone(f.row);
      await expect(f.service.preview(reviewer,requestId)).rejects.toMatchObject({code:'CONFLICT'});
      expect(f.execute).toHaveBeenCalledTimes(3);expect(f.row).toEqual(before);
    }
  });
  it.each(['PENDING','CONFIRMED','EXECUTING','COMPLETED','PARTIAL','DENIED'] as const)('rejects confirmation from %s without reading or consuming a preview',async status=>{
    const f=stateDatabase(status),before=structuredClone(f.row);
    await expect(f.service.confirm(ownerActor,requestId,previewId)).rejects.toMatchObject({code:'CONFLICT'});
    expect(f.execute).toHaveBeenCalledTimes(3);expect(f.row).toEqual(before);
  });
  it.each(['PENDING','PREVIEWED','EXECUTING','DENIED'] as const)('rejects execution from %s without receipt access or deletion',async status=>{
    const f=stateDatabase(status),before=structuredClone(f.row);
    await expect(f.service.execute(ownerActor,requestId,previewId)).rejects.toMatchObject({code:'CONFLICT'});
    expect(f.execute).toHaveBeenCalledTimes(3);expect(f.row).toEqual(before);
  });
  it.each(['EXECUTING','COMPLETED','PARTIAL','DENIED'] as const)('rejects denial from %s without changing metadata',async status=>{
    const f=stateDatabase(status),before=structuredClone(f.row);
    await expect(f.service.deny(ownerActor,requestId,'POLICY_RETAINED')).rejects.toMatchObject({code:'CONFLICT'});
    expect(f.execute).toHaveBeenCalledTimes(3);expect(f.row).toEqual(before);
  });
  it.each(['COMPLETED','PARTIAL'] as const)('returns existing receipt only for idempotent execution of %s',async status=>{
    const f=stateDatabase(status,true),before=structuredClone(f.row);
    const result=await f.service.execute(ownerActor,requestId,previewId);
    expect(result.request.status).toBe(status);expect(result.receipt?.outcome).toBe(status);
    expect(f.execute).toHaveBeenCalledTimes(4);expect(f.row).toEqual(before);
  });
  it('count matching is canonical and never ignores changed retained categories',()=>{
    const a=[{category:'MEMBER_LEVEL_STATE' as const,disposition:'ERASE' as const,count:1},{category:'MODERATION_ACCOUNTABILITY' as const,disposition:'RETAIN' as const,count:2}];
    expect(countsEqual(a,[...a].reverse())).toBe(true);expect(countsEqual(a,[a[0]!])).toBe(false);
  });
});
