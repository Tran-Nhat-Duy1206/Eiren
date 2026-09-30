#!/usr/bin/env node
// V8.1: synthetic, disposable PostgreSQL 17 rehearsal. Never point this at user data.
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';

const MARKER = '990000000000000001'; // fake 18-digit Discord-shaped ID
const TIMEOUT_MS = 90_000;
const J = (message) => console.log(`Restore rehearsal: ${message}`);
let stage = 'configuration';
let interrupted = false;
let cleaning = false;
let running;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  if (!cleaning) running?.kill(); // Always allow bounded cleanup to finish.
});
const cliEnv = Object.fromEntries(['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'DOCKER_CONFIG']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const fail = (message) => { throw new Error(message); };

function address(name, value) {
  if (!value) fail(`${name} is required`);
  let url;
  try { url = new URL(value); } catch { fail(`${name} is invalid`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || !url.username || !url.password || !url.pathname || url.pathname === '/')
    fail(`${name} must be a plain PostgreSQL URL with a database and local credentials`);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(`${name} must use a loopback host`);
  const namePart = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(namePart)) fail(`${name} has an unsupported database name`);
  return { url, name: namePart };
}

async function client(url) {
  const connection = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 10_000 });
  await connection.connect();
  return connection;
}

async function run(executable, args, env = cliEnv, stdoutFile, cleanup = false) {
  if (interrupted && !cleanup) fail('interrupted');
  const handle = stdoutFile ? await open(stdoutFile, 'w', 0o600) : null;
  try {
    await new Promise((ok, reject) => {
      const child = spawn(executable, args, { stdio: ['ignore', handle?.fd ?? 'ignore', 'ignore'], env, windowsHide: true, shell: false });
      running = child;
      const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, TIMEOUT_MS);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code === 0 && (!interrupted || cleanup)) ok(); else reject(new Error(interrupted ? 'interrupted' : `exit ${code}`));
      });
    });
  } finally {
    running = undefined;
    await handle?.close();
  }
}

async function main() {
  if (process.env.RESTORE_REHEARSAL_CONFIRM !== 'isolated-synthetic-only') fail('set RESTORE_REHEARSAL_CONFIRM=isolated-synthetic-only');
  const source = address('DATABASE_URL', process.env.DATABASE_URL);
  const target = address('RESTORE_DATABASE_URL', process.env.RESTORE_DATABASE_URL);
  if (!/^eiren_restore_[a-z0-9_]{1,32}$/.test(target.name)) fail('restore target must be explicitly named eiren_restore_<suffix>');
  if (source.url.host !== target.url.host || source.url.username !== target.url.username || source.url.password !== target.url.password)
    fail('source and target must use the same loopback server and synthetic credentials');
  if (source.name === target.name || !(/^eiren_v8_[a-z0-9_]+$/.test(source.name) ||
    (process.env.GITHUB_ACTIONS === 'true' && source.name === 'eiren')))
    fail('source must be an explicitly named synthetic V8 database (or CI eiren) distinct from target');
  const container = process.env.RESTORE_PG17_CONTAINER;
  if (container && (process.env.GITHUB_ACTIONS !== 'true' || !/^[a-f0-9]{12,64}$/.test(container)
    || source.url.hostname !== '127.0.0.1' || (source.url.port || '5432') !== '5432'))
    fail('PostgreSQL service-container tools are permitted only on the matching CI loopback port');
  const tool = (name) => container ? name : resolve(process.env.PG17_BIN || '', process.platform === 'win32' ? `${name}.exe` : name);
  // Without PG17_BIN, use PATH. No shell and no URL/password argument to external tools.
  const hostTool = (name) => process.env.PG17_BIN ? tool(name) : (process.platform === 'win32' ? `${name}.exe` : name);
  const execPg = (name, args, output) => container
    ? run('docker', ['exec', '--user', 'postgres', container, name, ...args], cliEnv, output)
    : run(hostTool(name), args, { ...cliEnv, PGPASSWORD: decodeURIComponent(source.url.password) }, output);
  let src, admin, adminUrl, restored;
  let directory, artifact, targetCreateAttempted = false, markerAttempted = false, dumpRemoved = false;
  const targetOwnershipMarker = randomInt(1_000_000_000, 2_000_000_000);
  try {
    stage = 'source inspection';
    src = await client(source.url);
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')).entries;
    if (journal.length !== 18 || journal[0]?.idx !== 0 || journal[17]?.idx !== 17 || !journal[17]?.tag.startsWith('0017_'))
      fail('approved migration inventory must be exactly 0000–0017');
    const applied = (await src.query('SELECT created_at::text AS applied_at, hash FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    if (applied.length !== journal.length) fail('source migration journal differs from 0000–0017');
    for (let i = 0; i < journal.length; i++) {
      const migration = journal[i];
      const sql = await readFile(new URL(`../drizzle/${migration.tag}.sql`, import.meta.url));
      if (migration.idx !== i || !migration.tag.startsWith(String(i).padStart(4, '0')) ||
        applied[i]?.applied_at !== String(migration.when) || applied[i]?.hash !== createHash('sha256').update(sql).digest('hex'))
        fail('source migration timestamp or SQL hash differs from approved migrations');
    }
    // The archive covers all schemas. Reject extra namespaces, foreign/materialized tables,
    // and every populated public table; this must be a disposable, migration-only database.
    const extraSchemas = await src.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public', 'drizzle', 'information_schema') AND nspname NOT LIKE 'pg_%'");
    if (extraSchemas.rowCount) fail('source includes an unapproved schema');
    const externalRelations = await src.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('f', 'm')");
    if (externalRelations.rowCount) fail('source includes foreign or materialized data');
    if ((await src.query('SELECT EXISTS(SELECT 1 FROM pg_largeobject_metadata LIMIT 1) AS populated')).rows[0]?.populated)
      fail('source includes PostgreSQL large objects');
    const publicTables = (await src.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
    if (publicTables.length < 20) fail('source schema inventory is incomplete');
    for (const { tablename } of publicTables) {
      const quoted = tablename.replaceAll('"', '""'); // name comes from PostgreSQL catalog, never operator input
      if ((await src.query(`SELECT EXISTS(SELECT 1 FROM public."${quoted}" LIMIT 1) AS populated`)).rows[0]?.populated)
        fail('source must contain zero records in every public data table');
    }
    adminUrl = new URL(source.url);
    adminUrl.pathname = '/postgres';
    admin = await client(adminUrl);
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target.name]);
    if (existing.rowCount) fail('restore target already exists; refusing to overwrite or drop it');
    directory = await mkdtemp(join(tmpdir(), 'eiren-v8-restore-'));
    artifact = container ? `/tmp/eiren-v8-restore-${randomUUID()}.dump` : join(directory, 'snapshot.dump');
    if (container) {
      stage = 'PostgreSQL service identity';
      const identityFile = join(directory, 'identity.txt');
      const expected = (await src.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0]?.id;
      await run('docker', ['exec', '--user', 'postgres', container, 'psql', '-U', decodeURIComponent(source.url.username),
        '-d', source.name, '-A', '-t', '-c', 'SELECT system_identifier::text FROM pg_control_system()'], cliEnv, identityFile);
      if (!expected || (await readFile(identityFile, 'utf8')).trim() !== expected)
        fail('Docker PostgreSQL service does not match inspected loopback server');
    }
    stage = 'PostgreSQL tool version';
    const versionFile = join(directory, 'version.txt');
    for (const name of ['pg_dump', 'pg_restore']) {
      await execPg(name, ['--version'], versionFile);
      if (!/\(PostgreSQL\) 17(?:\.|\s|$)/.test(await readFile(versionFile, 'utf8'))) fail(`${name} must be PostgreSQL 17`);
    }
    J('source migration hashes verified through 0017; all public tables empty; PostgreSQL 17 tools confirmed');
    stage = 'synthetic source marker';
    markerAttempted = true; // A lost INSERT response is still cleaned up in finally.
    await src.query('INSERT INTO guilds (id) VALUES ($1)', [MARKER]);
    await src.query('INSERT INTO guild_settings (guild_id, timezone) VALUES ($1, $2)', [MARKER, 'UTC']);
    stage = 'dump';
    const pgArgs = container ? ['-U', decodeURIComponent(source.url.username), '--format=custom', '--no-owner', '--no-acl', '--file', artifact, source.name]
      : ['--host', source.url.hostname, '--port', source.url.port || '5432', '--username', decodeURIComponent(source.url.username), '--format=custom', '--no-owner', '--no-acl', '--file', artifact, source.name];
    await execPg('pg_dump', pgArgs);
    J('synthetic source dumped in custom format');
    stage = 'create empty restore target';
    // target.name is strictly allowlisted; refuse an already-existing database, even if empty.
    targetCreateAttempted = true;
    // Mark ownership atomically with CREATE: an acknowledged or lost response can be
    // reconciled without ever dropping a pre-existing/unrelated database.
    await admin.query(`CREATE DATABASE "${target.name}" TEMPLATE template0 CONNECTION LIMIT ${targetOwnershipMarker}`);
    stage = 'restore';
    const restoreArgs = container ? ['-U', decodeURIComponent(source.url.username), '--dbname', target.name, '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', artifact]
      : ['--host', target.url.hostname, '--port', target.url.port || '5432', '--username', decodeURIComponent(target.url.username), '--dbname', target.name, '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', artifact];
    await execPg('pg_restore', restoreArgs);
    J('distinct empty target restored');
    stage = 'restored schema and marker';
    restored = await client(target.url);
    const restoredJournal = (await restored.query('SELECT created_at::text AS applied_at, hash FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    if (restoredJournal.length !== applied.length || restoredJournal.some((row, i) => row.applied_at !== applied[i].applied_at || row.hash !== applied[i].hash))
      fail('restored ordered migration timestamps/hashes differ');
    const relations = await restored.query("SELECT to_regclass('public.guilds') AS guilds, to_regclass('public.guild_settings') AS settings, to_regclass('public.automation_action_runs') AS actions");
    if (!relations.rows[0]?.guilds || !relations.rows[0]?.settings || !relations.rows[0]?.actions) fail('restored tables missing');
    const fk = await restored.query("SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid = 'public.guild_settings'::regclass AND contype = 'f'");
    if (fk.rows[0]?.count < 1) fail('restored foreign key missing');
    const marker = await restored.query('SELECT g.id FROM guilds g JOIN guild_settings s ON s.guild_id = g.id WHERE g.id = $1 AND s.timezone = $2', [MARKER, 'UTC']);
    if (marker.rowCount !== 1) fail('synthetic marker or guild FK missing');
    stage = 'restored database smoke';
    await run(process.execPath, ['--import', 'tsx', 'src/app/db-smoke.ts'], {
      ...cliEnv, DATABASE_URL: target.url.toString(), DISCORD_TOKEN: 'synthetic-restore-only', DISCORD_CLIENT_ID: MARKER,
      LOG_LEVEL: 'error', DASHBOARD_ENABLED: 'false', AI_ENABLED: 'false', ENABLE_GUILD_MEMBERS_INTENT: 'false',
    });
    J('restored journal, representative tables/FK, marker and rollback-only db:smoke passed');
  } finally {
    stage = 'cleanup';
    cleaning = true;
    await restored?.end().catch(() => { process.exitCode = 1; });
    if (markerAttempted) {
      try { await src.query('DELETE FROM guilds WHERE id = $1', [MARKER]); }
      catch {
        // A lost write/connection must not leave the synthetic marker behind.
        try { const retry = await client(source.url); try { await retry.query('DELETE FROM guilds WHERE id = $1', [MARKER]); } finally { await retry.end(); } }
        catch { process.exitCode = 1; }
      }
    }
    await src?.end().catch(() => { process.exitCode = 1; });
    if (targetCreateAttempted) {
      // CREATE might have committed before its response was lost. Drop only the
      // database whose unique CREATE-time marker and owner match this invocation.
      let keeper = admin, reconnect = false;
      try {
        let row;
        try { row = (await keeper.query('SELECT datconnlimit, datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_database WHERE datname = $1', [target.name])).rows[0]; }
        catch { keeper = await client(adminUrl); reconnect = true; row = (await keeper.query('SELECT datconnlimit, datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_database WHERE datname = $1', [target.name])).rows[0]; }
        if (row && (row.datconnlimit !== targetOwnershipMarker || !row.owned)) process.exitCode = 1;
        else if (row) await keeper.query(`DROP DATABASE "${target.name}"`);
      } catch { process.exitCode = 1; }
      finally { if (reconnect) await keeper.end().catch(() => { process.exitCode = 1; }); }
    }
    await admin?.end().catch(() => { process.exitCode = 1; });
    if (artifact) {
      if (container) await run('docker', ['exec', '--user', 'postgres', container, 'rm', '-f', '--', artifact], cliEnv, undefined, true).then(() => { dumpRemoved = true; }).catch(() => { process.exitCode = 1; });
      else { await rm(artifact, { force: true }).then(() => { dumpRemoved = true; }).catch(() => { process.exitCode = 1; }); }
    }
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => { process.exitCode = 1; });
    if (artifact && !dumpRemoved) fail('temporary archive cleanup failed');
  }
  if (process.exitCode || interrupted) fail('rehearsal cleanup or signal handling failed');
  J('source marker removed; owned restore database dropped; temporary dump removed');
}

main().catch(error => {
  // Driver/CLI error messages may contain credentials or URLs. Emit only a fixed stage and safe error class.
  console.error(`Restore rehearsal failed during ${stage} (${error instanceof Error ? error.name : 'unknown'}); no connection detail printed`);
  process.exitCode = 1;
});
