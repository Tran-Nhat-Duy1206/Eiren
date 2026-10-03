import { describe, expect, it, vi } from 'vitest';
import { OperationsDiagnostics, diagnosticQueries, type OperationalDatabase } from './diagnostics.js';
function reader(run: (text: string, values?: readonly unknown[]) => Promise<{rows: unknown[]}>): Pick<OperationalDatabase,'query'> { return {query: run as OperationalDatabase['query']}; }
describe('operations durable diagnostics', () => {
  it('uses fixed guild parameter aggregate projections and explicitly untracked capabilities', async () => {
    const query=vi.fn(async()=>({rows:[{count:'0',oldest_at:null,age_seconds:null,stale_count:'0'}]}));
    const rows=await new OperationsDiagnostics(reader(query)).inspect('guild-private');
    expect(rows.filter(r=>r.status==='EMPTY')).toHaveLength(diagnosticQueries.length);
    expect(rows.filter(r=>r.status==='NOT_TRACKED')).toHaveLength(4);
    for(const [text,values] of query.mock.calls as unknown as [string,unknown[]][]){expect(values).toEqual(['guild-private']);expect(text).not.toMatch(/SELECT\s+\*|json|transcript|description|prize|creator_id/i);expect(text).toContain('statement_timestamp()');}
  });
  it('classifies stale and fresh claims without host clock and isolates failure', async () => {
    const date=new Date('2020-01-01');
    const rows=await new OperationsDiagnostics(reader(async text=>{
      if(text.includes('governance_audit_gaps'))throw new Error('private error must not escape');
      return {rows:[{count:'2',oldest_at:date,age_seconds:10,stale_count:text.includes("status='RUNNING'")?'1':'0'}]};
    })).inspect('g');
    expect(rows.find(r=>r.key==='automation_running')?.status).toBe('STALE');
    expect(rows.find(r=>r.key==='giveaway_result_unresolved')?.status).toBe('PENDING');
    expect(rows.find(r=>r.key==='giveaway_draw_notify_unresolved')?.status).toBe('AMBIGUOUS');
    expect(rows.find(r=>r.key==='audit_gaps')).toEqual({key:'audit_gaps',status:'UNAVAILABLE',count:null,oldestAt:null,ageSeconds:null});
  });
  it('keeps newly due transitions pending until the DB 90-second grace', async () => {
    const keys=['event_scheduled_overdue','event_active_overdue','giveaway_active_overdue'];
    for(const age of [0,89,90,91]){
      const result=await new OperationsDiagnostics(reader(async()=>({rows:[{count:'1',oldest_at:new Date('2020-01-01'),age_seconds:age,stale_count:age>=90?'1':'0'}]}))).inspect('g');
      for(const key of keys){expect(result.find(r=>r.key===key)?.status).toBe(age>=90?'STALE':'PENDING');expect(diagnosticQueries.find(q=>q.key===key)?.text).toContain("<=statement_timestamp()-interval '90 seconds'");}
    }
  });
  it('rejects missing or unsafe aggregate values instead of fabricating zero', async () => {
    for(const rows of [[],[{count:'9007199254740992',oldest_at:null,age_seconds:null,stale_count:'0'}]]){
      const result=await new OperationsDiagnostics(reader(async()=>({rows}))).inspect('g');
      expect(result.slice(0,diagnosticQueries.length).every(r=>r.status==='UNAVAILABLE'&&r.count===null)).toBe(true);
    }
  });
  it('bounds hung readers and clears deadlines', async () => {
    vi.useFakeTimers();try{
      const pending=new OperationsDiagnostics(reader(()=>new Promise(()=>{}))).inspect('g');
      await vi.advanceTimersByTimeAsync(2200);
      expect((await pending).filter(r=>r.status==='UNAVAILABLE')).toHaveLength(diagnosticQueries.length);
      expect(vi.getTimerCount()).toBe(0);
    }finally{vi.useRealTimers();}
  });
});
