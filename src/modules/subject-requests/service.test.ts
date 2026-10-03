import { describe,it,expect,vi } from 'vitest';
import { SubjectRequestService } from './service.js';
import { CATEGORIES,DENIAL_CODES,STATUSES,SCOPE_WARNING,WORKFLOW_EVIDENCE_WARNING } from './contracts.js';
import { countsEqual,key,owner } from './repository.js';
const guildId='990000000000000001',userId='990000000000000002';
const actor={guildId,userId,guildOwnerId:'990000000000000003',roleIds:[]};
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
  it('count matching is canonical and never ignores changed retained categories',()=>{
    const a=[{category:'MEMBER_LEVEL_STATE' as const,disposition:'ERASE' as const,count:1},{category:'MODERATION_ACCOUNTABILITY' as const,disposition:'RETAIN' as const,count:2}];
    expect(countsEqual(a,[...a].reverse())).toBe(true);expect(countsEqual(a,[a[0]!])).toBe(false);
  });
});
