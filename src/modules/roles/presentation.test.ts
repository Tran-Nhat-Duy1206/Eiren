import { describe, it, expect } from 'vitest';
import { panel, parsePanelId, BUTTON_PREFIX, SELECT_PREFIX } from './service.js';
import type { RoleMenu, RoleMenuOption } from './repository.js';
const menu = { id:42,name:'Synthetic roles',kind:'BUTTON',exclusive:false,maxValues:12 } as RoleMenu;
const options = Array.from({length:12},(_,i)=>({ id:i+1, label:`Role ${i+1}`, description:null }) as RoleMenuOption);
describe('V8.5 role menu presentation compatibility', () => {
  it('preserves original button IDs and safe mentions at maximum panel size', () => {
    const result=panel(menu,options); expect(result.allowedMentions).toEqual({parse:[]}); expect(result.content).toBe('**Synthetic roles**\nChoose up to 12 roles.'); expect(result.content.length).toBeLessThanOrEqual(2000); expect(result.components).toHaveLength(5);
    const buttons=result.components.map(row=>row.toJSON().components as {type:number;custom_id?:string;label?:string}[]).flat(); expect(buttons.every(b=>b.type===2)).toBe(true);
    for(let i=0;i<12;i++){const add=buttons[i*2] as {custom_id:string;label:string}; const remove=buttons[i*2+1] as {custom_id:string;label:string};expect(add.custom_id).toBe(`role-menu:button:42:${i+1}:add`);expect(remove.custom_id).toBe(`role-menu:button:42:${i+1}:remove`);expect(parsePanelId(add.custom_id,BUTTON_PREFIX)).toEqual({menuId:42,optionId:i+1,action:'add'});expect(add.label).toBe(`+ Role ${i+1}`);}
    expect(result.components.every(row=>row.toJSON().components.length<=5)).toBe(true);
  });
  it('preserves original select/option identities and existing limits',()=>{
    const result=panel({...menu,kind:'SELECT',maxValues:25},Array.from({length:25},(_,i)=>({...options[0]!,id:i+1,label:`Role ${i+1}`}))); const select=result.components[0]!.toJSON().components[0] as {custom_id:string;options:{value:string}[];max_values:number};expect(select.custom_id).toBe('role-menu:select:42');expect(select.options.map(o=>o.value)).toEqual(Array.from({length:25},(_,i)=>String(i+1)));expect(select.max_values).toBe(25);expect(parsePanelId(select.custom_id,SELECT_PREFIX)).toEqual({menuId:42});
  });
});
