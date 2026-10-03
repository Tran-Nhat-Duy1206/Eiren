import { expect, it, vi } from 'vitest';
import { OperationsService } from './operations-service.js';
import type { OperationalDatabase } from '../core/operations/diagnostics.js';
it('bounds overrides to registered keys and keeps effective classification injected',async()=>{
 const describeOperationalStates=vi.fn((states:readonly {moduleKey:string;enabled:boolean;version:number}[])=>[{key:'core',enabled:true,version:0},{key:'events',enabled:states[0]?.enabled??false,version:states[0]?.version??0}]);
 const query=vi.fn(async()=>({rows:[{module_key:'events',enabled:true,version:4}]}));
 const service=new OperationsService({inspect:async()=>[]},{query:query as OperationalDatabase['query']},{describeOperationalStates});
 expect(await service.view('g')).toEqual({diagnostics:[],modules:[{key:'core',enabled:true,version:0},{key:'events',enabled:true,version:4}]});
 expect(query).toHaveBeenCalledWith(expect.stringContaining('module_key=ANY($2::text[])'),['g',['core','events'],2]);
});
it('module read failure is null not falsely enabled or empty while diagnostics survive',async()=>{
 const service=new OperationsService({inspect:async()=>[]},{query:async()=>{throw new Error('private');}},{describeOperationalStates:()=>[{key:'core',enabled:true,version:0}]});
 expect(await service.view('g')).toEqual({modules:null,diagnostics:[]});
});
