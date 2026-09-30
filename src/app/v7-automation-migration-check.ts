import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { validateAutomationConfig } from '../modules/automation/config.js';
import { AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS } from '../modules/automation/contracts.js';

// Rehearse the exact migration in a disposable PostgreSQL schema with valid V7.1 inert rows.
// No production table or migration journal is modified.
const { db, pool } = createDatabase(loadEnv().DATABASE_URL);
const schema = `v73_review_${randomUUID().replaceAll('-', '')}`;
const name = `"${schema}"`;
const checks: Record<string, boolean> = {};
const check = (key: string, value: boolean) => { checks[key] = value; if (!value) throw new Error(key); };
let created = false;
let stage = 'create-schema';
try {
  await db.execute(sql.raw(`CREATE SCHEMA ${name}`));
  created = true;
  await db.transaction(async tx => {
    stage = 'legacy-fixtures';
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${name}, public`));
    await tx.execute(sql.raw('CREATE TABLE guilds (id text PRIMARY KEY)'));
    await tx.execute(sql.raw('CREATE TABLE automations (id bigint PRIMARY KEY)'));
    // V7.1 permits action edits and action runs without a configured-position FK.
    await tx.execute(sql.raw('CREATE TABLE automation_actions (automation_id bigint NOT NULL, position integer NOT NULL, action_key text NOT NULL, action_version integer NOT NULL, config jsonb NOT NULL, PRIMARY KEY(automation_id,position))'));
    await tx.execute(sql.raw('CREATE TABLE automation_executions (id uuid PRIMARY KEY, guild_id text NOT NULL, automation_id bigint NOT NULL)'));
    await tx.execute(sql.raw('CREATE TABLE automation_action_runs (execution_id uuid NOT NULL, position integer NOT NULL, PRIMARY KEY(execution_id,position))'));
    await tx.execute(sql.raw("INSERT INTO guilds VALUES ('g')"));
    await tx.execute(sql.raw('INSERT INTO automations (id) VALUES (1)'));
    await tx.execute(sql.raw("INSERT INTO automation_actions VALUES (1,0,'STAFF_LOG',1,'{\"channelId\":\"12345678901234567\",\"message\":\"edited\"}')"));
    await tx.execute(sql.raw(`INSERT INTO automation_executions VALUES ('${randomUUID()}','g',1),('${randomUUID()}','g',1)`));
    // One action run has lost its configured position; the other position survives but its
    // current config cannot be proven to match the historical queued action.
    await tx.execute(sql.raw('INSERT INTO automation_action_runs SELECT id, 1 FROM automation_executions LIMIT 1'));
    await tx.execute(sql.raw('INSERT INTO automation_action_runs SELECT id, 0 FROM automation_executions ORDER BY id DESC LIMIT 1'));
    const statements = readFileSync(new URL('../../drizzle/0015_previous_rocket_racer.sql', import.meta.url), 'utf8')
      .split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean);
    for (const [index, statement] of statements.entries()) {
      stage = `migration-statement-${index + 1}`;
      // The authored 0015 SQL qualifies FKs with public; only redirect that qualifier
      // into the disposable V7.1 schema. All migration statements otherwise run verbatim.
      await tx.execute(sql.raw(statement.replaceAll('"public".', `${name}.`)));
    }
    stage = 'verify-snapshots';
    const result = await tx.execute(sql.raw('SELECT ar.position, snap.action_key, snap.config FROM automation_action_runs ar JOIN automation_execution_actions snap ON snap.execution_id=ar.execution_id AND snap.position=ar.position ORDER BY ar.position'));
    const rows = result.rows as { position: number; action_key: string; config: Record<string, unknown> }[];
    check('legacyRunsUpgradeWithoutLosingPositions', rows.length === 2 && rows[0]?.position === 0 && rows[1]?.position === 1);
    check('legacySnapshotsNeverClaimActionProvenance', rows.every(row => row.action_key === 'LEGACY_INERT' && row.config.provenance === 'V7_1_UNVERIFIED'));
    let legacyRunnable = false;
    try { validateAutomationConfig({ schemaVersion: 1, enabled: true,
      trigger: { id: 'SCHEDULED', version: 1, config: { kind: 'daily', time: '12:00', timezone: 'UTC' } },
      actions: [{ id: rows[0]!.action_key, version: 1, config: rows[0]!.config }] },
    AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS); legacyRunnable = true; } catch { /* Expected: no legacy action definition. */ }
    check('legacySentinelFailsTypedFinalAuthorization', !legacyRunnable);
    // Simulate the already-applied, pre-correction 0015 backfill that misidentified
    // one inert run with the current action JSON; 0016 must mark it unverified.
    await tx.execute(sql.raw('DROP TRIGGER automation_execution_actions_immutable ON automation_execution_actions'));
    await tx.execute(sql.raw("UPDATE automation_execution_actions SET action_key='STAFF_LOG', config='{\"channelId\":\"12345678901234567\",\"message\":\"edited\"}'::jsonb WHERE position=0"));
    await tx.execute(sql.raw('CREATE TRIGGER automation_execution_actions_immutable BEFORE UPDATE ON automation_execution_actions FOR EACH ROW EXECUTE FUNCTION automation_execution_actions_reject_update()'));
    const firstExecution = await tx.execute(sql.raw('SELECT id FROM automation_executions LIMIT 1'));
    const executionId = String(firstExecution.rows[0]!.id);
    const attemptId = randomUUID();
    await tx.execute(sql.raw("INSERT INTO guilds VALUES ('other')"));
    await tx.execute(sql.raw(`INSERT INTO automation_execution_attempts (id,guild_id,execution_id) VALUES ('${attemptId}','other','${executionId}')`));
    const followup = readFileSync(new URL('../../drizzle/0016_cynical_proudstar.sql', import.meta.url), 'utf8')
      .split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean);
    for (const [index, statement] of followup.entries()) {
      stage = `followup-statement-${index + 1}`;
      await tx.execute(sql.raw(statement.replaceAll('"public".', `${name}.`)));
    }
    stage = 'verify-followup';
    const repaired = await tx.execute(sql.raw(`SELECT guild_id FROM automation_execution_attempts WHERE id='${attemptId}'`));
    check('existingWrongGuildAttemptsReattributed', repaired.rows[0]?.guild_id === 'g');
    const reread = await tx.execute(sql.raw('SELECT action_key,config FROM automation_execution_actions WHERE position=0'));
    check('previouslyApplied0015SnapshotsInvalidated', reread.rows.every(item => item.action_key === 'LEGACY_INERT' &&
      (item.config as { provenance?: string }).provenance === 'V7_1_UNVERIFIED'));
    let forgedAttemptAccepted = false;
    await tx.execute(sql.raw('SAVEPOINT v73_fk_review'));
    try {
      await tx.execute(sql.raw(`INSERT INTO automation_execution_attempts (id,guild_id,execution_id) VALUES ('${randomUUID()}','other','${executionId}')`));
      forgedAttemptAccepted = true;
    } catch { await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT v73_fk_review')); }
    await tx.execute(sql.raw('RELEASE SAVEPOINT v73_fk_review'));
    check('followupCompositeFKRejectsWrongGuild', !forgedAttemptAccepted);
    // Rehearse the exact additive 0017 against the resulting V7.3 schema, including
    // old LEGACY_INERT rows. No live/public schema or migration journal is touched.
    const v74 = readFileSync(new URL('../../drizzle/0017_eager_genesis.sql', import.meta.url), 'utf8')
      .split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean);
    for (const [index, statement] of v74.entries()) {
      stage = `v74-statement-${index + 1}`;
      await tx.execute(sql.raw(statement.replaceAll('"public".', `${name}.`)));
    }
    stage = 'verify-v74-upgrade';
    const dispatchToken = randomUUID();
    await tx.execute(sql.raw(`UPDATE automation_action_runs SET dispatch_token='${dispatchToken}' WHERE execution_id='${executionId}'`));
    const tokenRows = await tx.execute(sql.raw(`SELECT dispatch_token FROM automation_action_runs WHERE execution_id='${executionId}'`));
    check('v74DispatchEvidenceUpgradeWithoutLosingLegacyRuns', tokenRows.rows.length >= 1 &&
      tokenRows.rows.every(item => item.dispatch_token === dispatchToken));
    await tx.execute(sql.raw(`UPDATE automation_action_runs SET reconciliation_result='CONFIRMED_SENT',
      reconciled_by='12345678901234567', reconciled_at=now() WHERE execution_id='${executionId}'`));
    const reconciled = await tx.execute(sql.raw(`SELECT reconciliation_result,reconciled_by,reconciled_at FROM automation_action_runs WHERE execution_id='${executionId}'`));
    check('v74ReconciliationMetadataPersisted', reconciled.rows[0]?.reconciliation_result === 'CONFIRMED_SENT' &&
      reconciled.rows[0]?.reconciled_by === '12345678901234567' && Boolean(reconciled.rows[0]?.reconciled_at));
    let incompleteAllowed = false;
    await tx.execute(sql.raw('SAVEPOINT v74_reconciliation_review'));
    try {
      await tx.execute(sql.raw(`UPDATE automation_action_runs SET reconciled_at=NULL WHERE execution_id='${executionId}'`));
      incompleteAllowed = true;
    } catch { await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT v74_reconciliation_review')); }
    await tx.execute(sql.raw('RELEASE SAVEPOINT v74_reconciliation_review'));
    check('v74IncompleteReconciliationRejected', !incompleteAllowed);
  });
} catch (error) {
  console.error(JSON.stringify({ checks, stage, errorType: error instanceof Error ? error.name : 'unknown',
    failedCheck: error instanceof Error && Object.hasOwn(checks, error.message) ? error.message : 'migration' }));
  process.exitCode = 1;
} finally {
  try { if (created) await db.execute(sql.raw(`DROP SCHEMA ${name} CASCADE`)); }
  finally { await pool.end(); }
  if (!process.exitCode) console.log(JSON.stringify({ checks, passedCount: Object.values(checks).filter(Boolean).length }));
}
