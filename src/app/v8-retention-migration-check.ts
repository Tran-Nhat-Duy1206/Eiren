import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../core/database/connection.js';

// An explicit second DATABASE, never the live database. CI can provision one on its PG17 server.
if (!process.env.DATABASE_URL) throw new Error('Explicit synthetic DATABASE_URL required; local .env is never loaded.');
const primary = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(primary.hostname)) throw new Error('Loopback PostgreSQL required.');
const source = process.env.V8_DISPOSABLE_DATABASE_URL;
if (!source) throw new Error('Set V8_DISPOSABLE_DATABASE_URL to an owned disposable PostgreSQL database, separate from DATABASE_URL.');
const disposable = new URL(source);
if (disposable.protocol !== 'postgres:' && disposable.protocol !== 'postgresql:') throw new Error('Disposable source must be PostgreSQL.');
if (disposable.host !== primary.host) throw new Error('Disposable database must use the same PostgreSQL server as DATABASE_URL.');
if (disposable.pathname === primary.pathname) throw new Error('Refusing migration rehearsal on the primary database.');
if (!/^(v8_|eiren_v8_|test_v8_)[a-z0-9_]*$/.test(decodeURIComponent(disposable.pathname.slice(1)))) throw new Error('Disposable database name must start with v8_, eiren_v8_, or test_v8_.');
const { db, pool } = createDatabase(source);
const schema = `v8_upgrade_${randomUUID().replaceAll('-', '')}`;
const q = `"${schema}"`;
const payload = `private-${randomUUID()}`;
const checks: string[] = [];
const check = (name: string, condition: unknown) => { if (!condition) throw new Error(name); checks.push(name); };
let created = false;
let stage = 'setup';
try {
  await db.execute(sql.raw(`CREATE SCHEMA ${q}`)); created = true;
  await db.transaction(async tx => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${q}, public`));
    const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: { idx: number; tag: string }[] };
    check('journal contains ordered 0000 through 0019 migrations', journal.entries.length === 20 && journal.entries.every((entry, index) => entry.idx === index && entry.tag.startsWith(String(index).padStart(4, '0') + '_')) && journal.entries[18]?.tag === '0018_neat_tarantula');
    async function apply(entry: { idx: number; tag: string }) {
      const text = readFileSync(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
      const statements = text.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
      check(`journal migration ${entry.tag} has statements`, statements.length > 0);
      for (const [index, statement] of statements.entries()) {
        stage = `${entry.tag} statement ${index + 1}`;
        // Generated public-qualified FKs must reference our OWN isolated schema.
        await tx.execute(sql.raw(statement.replaceAll('"public".', `${q}.`)));
      }
    }
    for (const entry of journal.entries.slice(0, 18)) await apply(entry);
    stage = 'pre-0018 real schema fixtures';
    await tx.execute(sql`INSERT INTO guilds (id) VALUES ('v8-preexisting')`);
    await tx.execute(sql`INSERT INTO tickets (guild_id,creator_id,type,status,closed_at,transcript,close_reason)
      VALUES ('v8-preexisting','v8-owner','SUPPORT','CLOSED',now() - interval '800 days',${payload},${payload}),
      ('v8-preexisting','v8-owner','SUPPORT','OPEN',NULL,${payload},NULL)`);
    await tx.execute(sql`INSERT INTO reports (guild_id,reporter_id,category,status,closed_at,description,evidence_url,resolution_note)
      VALUES ('v8-preexisting','v8-owner','OTHER','CLOSED',now() - interval '800 days',${payload},${payload},${payload}),
      ('v8-preexisting','v8-owner','OTHER','OPEN',NULL,${payload},${payload},NULL)`);
    await tx.execute(sql`INSERT INTO appeals (guild_id,appellant_id,status,reviewed_at,reason,review_note)
      VALUES ('v8-preexisting','v8-owner','REJECTED',now() - interval '800 days',${payload},${payload}),
      ('v8-preexisting','v8-owner','PENDING',NULL,${payload},NULL)`);
    for (const entry of journal.entries.slice(18)) {
    await apply(entry);
    stage = `${entry.tag} preservation assertions`;
    const rows = await tx.execute(sql`SELECT
      (SELECT array_agg(transcript ORDER BY id) FROM tickets) AS tickets,
      (SELECT array_agg(close_reason ORDER BY id) FROM tickets WHERE status='CLOSED') AS close_reasons,
      (SELECT array_agg(description ORDER BY id) FROM reports) AS reports,
      (SELECT array_agg(evidence_url ORDER BY id) FROM reports) AS evidence,
      (SELECT array_agg(resolution_note ORDER BY id) FROM reports WHERE status='CLOSED') AS resolutions,
      (SELECT array_agg(reason ORDER BY id) FROM appeals) AS appeals,
      (SELECT array_agg(review_note ORDER BY id) FROM appeals WHERE status='REJECTED') AS review_notes`);
    const values = rows.rows[0];
    check('all six preexisting closed and open narratives unchanged', ['tickets','reports','appeals'].every(key => Array.isArray(values?.[key]) && (values[key] as string[]).length === 2 && (values[key] as string[]).every(v => v === payload)));
    check('all secondary private fields unchanged', ['close_reasons','evidence','resolutions','review_notes'].every(key => Array.isArray(values?.[key]) && (values[key] as string[]).every(v => v === payload)));
    const states = await tx.execute(sql`SELECT (SELECT count(*)::int FROM tickets WHERE status='OPEN' AND transcript IS NOT NULL) AS open_tickets,
      (SELECT count(*)::int FROM reports WHERE status='OPEN' AND description IS NOT NULL) AS open_reports,
      (SELECT count(*)::int FROM appeals WHERE status='PENDING' AND reason IS NOT NULL) AS pending_appeals`);
    check('active rows retain their status and payload', states.rows[0]?.open_tickets === 1 && states.rows[0]?.open_reports === 1 && states.rows[0]?.pending_appeals === 1);
    const policy = await tx.execute(sql.raw('SELECT count(*)::int AS total FROM retention_policies'));
    const receipts = await tx.execute(sql.raw('SELECT count(*)::int AS total FROM retention_receipts'));
    const previews = await tx.execute(sql.raw('SELECT count(*)::int AS total FROM retention_previews'));
    check('no implicit policy opt-in', policy.rows[0]?.total === 0);
    check('no implicit receipt or preview', receipts.rows[0]?.total === 0 && previews.rows[0]?.total === 0);
    }
    const defaults = await tx.execute(sql.raw("INSERT INTO retention_policies (guild_id) VALUES ('v8-preexisting') RETURNING enabled,ticket_retention_days,report_retention_days,appeal_retention_days,version"));
    check('database policy defaults remain off', defaults.rows[0]?.enabled === false && defaults.rows[0]?.ticket_retention_days === 90 && defaults.rows[0]?.report_retention_days === 365 && defaults.rows[0]?.appeal_retention_days === 365 && defaults.rows[0]?.version === 0);
  });
  console.log(JSON.stringify({ suite: 'v8-migration', checks: checks.length, names: checks }));
} catch (error) {
  console.error(JSON.stringify({ suite: 'v8-migration', passed: checks.length, stage, error: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
} finally {
  try { if (created) await db.execute(sql.raw(`DROP SCHEMA ${q} CASCADE`)); }
  finally { await pool.end(); }
}
