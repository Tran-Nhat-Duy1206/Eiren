import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const entry=new URL('./v86-recovery-drill.ts',import.meta.url);
describe('V8.6 disposable drill static safety boundary',()=>{
  it('runtime local import closure has no Discord, bootstrap, environment loader or migration CLI',async()=>{
    const seen=new Set<string>();const external=new Set<string>();
    async function visit(file:URL):Promise<void>{
      const path=fileURLToPath(file);if(seen.has(path))return;seen.add(path);
      const source=await readFile(file,'utf8');
      expect(source).not.toMatch(/(?:from\s*|import\s*\()\s*['"](?:discord\.js|dotenv(?:\/[^'"]*)?)['"]/);
      for(const m of source.matchAll(/^import\s+(?!type\b).*?from\s*['"]([^'"]+)['"];?/gm)){
        const specifier=m[1]!;
        if(specifier.startsWith('.')){
          expect(specifier).not.toMatch(/(?:\/main|\/client|\/registry|app-env|\/config\/env|\/migrate)\.js$/);
          await visit(new URL(specifier.replace(/\.js$/,'.ts'),file));
        }else external.add(specifier);
      }
    }
    await visit(entry);
    expect([...external].filter(s=>!s.startsWith('node:')).sort()).toEqual(['drizzle-orm','drizzle-orm/node-postgres','drizzle-orm/node-postgres/migrator','drizzle-orm/pg-core','pg','zod']);
    expect(seen.size).toBeGreaterThan(8);
  });
  it('requires explicit synthetic confirmation and uniquely owned creation markers',async()=>{
    const s=await readFile(entry,'utf8');
    expect(s).toContain("process.env.RECOVERY_DRILL_CONFIRM==='isolated-synthetic-only'");
    expect(s).toContain('RECOVERY_DRILL_DATABASE_URL');
    expect(s).toContain("check('synthetic admin address',/^eiren_v8_[a-z0-9_]+$/.test(name)");
    expect(s).not.toContain('!!explicit||');
    expect(s).toContain('database previously nonexistent');
    expect(s).toContain('TEMPLATE template0 ENCODING');
    expect(s).toContain('row.owned&&row.datconnlimit===markers[i]');
    expect(s).not.toContain('--clean');
  });
  it('consumes idle client and pool errors before connecting without diagnostics',async()=>{
    const s=await readFile(entry,'utf8');
    expect(s.indexOf("c.on('error',onConnectionError)")).toBeLessThan(s.indexOf('await c.connect()'));
    expect(s.indexOf("pool.on('error',onConnectionError)")).toBeLessThan(s.indexOf('const db=drizzle(pool'));
    expect(s).toContain('function onConnectionError(){connectionLost=true;if(!cleaning)running?.kill();}');
    expect(s).toContain("catch{await c.end().catch(()=>undefined);throw new Error('Connection unavailable');}");
    expect(s).toContain("check('no asynchronous connection loss',!connectionLost)");
    expect(s).toContain('if(interrupted||connectionLost||process.exitCode)');
  });
  it('never exports fixture corrections or exposes private tool diagnostics',async()=>{
    const s=await readFile(entry,'utf8');
    expect(s).not.toMatch(/^export /m);
    expect(s).toContain("stdio:['ignore',handle?.fd??'ignore','ignore']");
    expect(s).toContain('PGPASSWORD:decodeURIComponent(adminUrl.password)');
    expect(s).not.toMatch(/console\.(?:log|error)\([^\n]*(?:SENTINEL|\.message|\.stack|adminUrl|urls\[)/);
    expect(s).toContain('before===await snapshot(target!)');
    expect(s).toContain('bBefore===await guildBSnapshot(target)');
  });
});
