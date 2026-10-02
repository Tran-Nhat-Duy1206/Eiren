import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../core/database/connection.js';
import { runRetentionMaintenance } from '../modules/data-retention/maintenance.js';
import { DataRetentionService } from '../modules/data-retention/service.js';

type Check = (name: string, condition: unknown) => void;
type Rejects = (name: string, action: () => Promise<unknown>) => Promise<void>;
/** Only called after the entrypoint's fail-closed empty synthetic database guard. */
export async function runExtendedRetentionChecks(db: Database, check: Check, rejects: Rejects) {
  const prefix = `v8-extra-${randomUUID()}`;
  const ids: string[] = [];
  const trigger = `v8_receipt_failure_${randomUUID().replaceAll('-', '')}`;
  const service = new DataRetentionService(db);
  async function guild(suffix: string, enabled = true) {
    const id = `${prefix}-${suffix}`; ids.push(id);
    await db.execute(sql`INSERT INTO guilds (id) VALUES (${id})`);
    if (enabled) await db.execute(sql`INSERT INTO retention_policies (guild_id,enabled,version,confirmed_by,confirmed_at,ticket_retention_days,report_retention_days,appeal_retention_days) VALUES (${id},true,1,'fixture-owner',statement_timestamp(),30,90,90)`);
    return id;
  }
  const configs = [
    { table: 'tickets', who: 'creator_id', extra: ",type='SUPPORT'", columns: "creator_id,type", values: "'fixture','SUPPORT'", payload: 'transcript', marker: 'transcript_redacted_at', version: 'transcript_retention_policy_version', terminal: 'CLOSED', deadline: 'closed_at', active: ['OPEN','CLAIMED'], supplementary: [] },
    { table: 'reports', who: 'reporter_id', extra: ",category='OTHER'", columns: 'reporter_id,category', values: "'fixture','OTHER'", payload: 'description', marker: 'narrative_redacted_at', version: 'narrative_retention_policy_version', terminal: 'CLOSED', deadline: 'closed_at', active: ['OPEN','UNDER_REVIEW'], supplementary: ['evidence_url','resolution_note'] },
    { table: 'appeals', who: 'appellant_id', extra: '', columns: 'appellant_id', values: "'fixture'", payload: 'reason', marker: 'narrative_redacted_at', version: 'narrative_retention_policy_version', terminal: 'REJECTED', deadline: 'reviewed_at', active: ['PENDING'], supplementary: ['review_note'] },
  ];
  try {
    const invariant = await guild('invariants', false);
    for (const c of configs) {
      const result = await db.execute(sql.raw(`INSERT INTO ${c.table} (guild_id,${c.columns},status,${c.payload},${c.marker},${c.version}) VALUES ('${invariant}',${c.values},'${c.terminal}',NULL,statement_timestamp(),1) RETURNING id`));
      const record = Number(result.rows[0]!.id);
      for (const column of [c.payload, ...c.supplementary]) {
        await rejects(`${c.table} redacted ${column} database rejects`, () => db.execute(sql.raw(`UPDATE ${c.table} SET ${column}='forbidden' WHERE id=${record}`)));
      }
      await rejects(`${c.table} marked NULL version database rejects`, () => db.execute(sql.raw(`UPDATE ${c.table} SET ${c.version}=NULL WHERE id=${record}`)));
      await rejects(`${c.table} marker and complete hold incompatible`, () => db.execute(sql.raw(`UPDATE ${c.table} SET retention_hold=true,retention_hold_by='fixture',retention_hold_at=statement_timestamp() WHERE id=${record}`)));
      const live = await db.execute(sql.raw(`INSERT INTO ${c.table} (guild_id,${c.columns},status,${c.payload}) VALUES ('${invariant}',${c.values},'${c.active[0]}','private') RETURNING id`));
      const liveId = Number(live.rows[0]!.id);
      for (const assignment of ["retention_hold=true", "retention_hold_by='fixture'", "retention_hold_at=statement_timestamp()", "retention_hold=true,retention_hold_by='fixture'", "retention_hold=true,retention_hold_at=statement_timestamp()"]) {
        await rejects(`${c.table} rejects incomplete hold ${assignment}`, () => db.execute(sql.raw(`UPDATE ${c.table} SET ${assignment} WHERE id=${liveId}`)));
      }
    }
    const active = await guild('active');
    for (const c of configs) {
      for (const status of c.active) await db.execute(sql.raw(`INSERT INTO ${c.table} (guild_id,${c.columns},status,${c.deadline},${c.payload}) VALUES ('${active}',${c.values},'${status}',statement_timestamp()-interval '800 days','private')`));
      await db.execute(sql.raw(`INSERT INTO ${c.table} (guild_id,${c.columns},status,${c.deadline},${c.payload}) VALUES ('${active}',${c.values},'${c.terminal}',NULL,'private')`));
    }
    const activeOutcome = await runRetentionMaintenance(db);
    check('all nonterminal domains and NULL terminal dates untouched', activeOutcome.ticket === 0 && activeOutcome.report === 0 && activeOutcome.appeal === 0);
    for (const c of configs) {
      const state = await db.execute(sql.raw(`SELECT count(*)::int AS count FROM ${c.table} WHERE guild_id='${active}' AND ${c.payload}='private' AND ${c.marker} IS NULL`));
      check(`${c.table} active and NULL deadline payloads preserved`, Number(state.rows[0]?.count) === c.active.length + 1);
    }
    await db.execute(sql`UPDATE retention_policies SET enabled=false WHERE guild_id=${active}`);

    const failure = await guild('failure');
    for (const c of configs) await db.execute(sql.raw(`INSERT INTO ${c.table} (guild_id,${c.columns},status,${c.deadline},${c.payload}${c.supplementary.map(x => ',' + x).join('')}) VALUES ('${failure}',${c.values},'${c.terminal}',statement_timestamp()-interval '800 days','private'${c.supplementary.map(() => ",'private'").join('')})`));
    await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.guild_id='${failure}' THEN RAISE EXCEPTION 'owned synthetic receipt failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON retention_receipts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`));
    try {
      for (const c of configs) {
        await rejects(`${c.table} receipt failure rejects maintenance`, () => runRetentionMaintenance(db));
        const restored = await db.execute(sql.raw(`SELECT count(*)::int AS count FROM ${c.table} WHERE guild_id='${failure}' AND ${c.payload}='private' AND ${c.marker} IS NULL AND ${c.version} IS NULL ${c.supplementary.map(x => `AND ${x}='private'`).join(' ')}`));
        check(`${c.table} failed receipt leaves all payloads markers versions intact`, Number(restored.rows[0]?.count) === 1);
        // Skip this domain on the next tick, so each real domain transaction fails at its receipt INSERT.
        await db.execute(sql.raw(`UPDATE ${c.table} SET retention_hold=true,retention_hold_by='fixture',retention_hold_at=statement_timestamp() WHERE guild_id='${failure}'`));
      }
      const receipts = await db.execute(sql`SELECT count(*)::int AS count FROM retention_receipts WHERE guild_id=${failure}`);
      check('failed maintenance no receipts', receipts.rows[0]?.count === 0);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON retention_receipts`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${trigger}()`));
    }
    const heldStatus = await service.status(failure), unheldStatus = await service.status(invariant);
    check('active hold counts scoped across all domains', Object.values(heldStatus.holdCounts).every(n => n===1) && Object.values(unheldStatus.holdCounts).every(n => n===0));
    check('activeHolds metadata only scoped across all domains', heldStatus.activeHolds.length===3 && new Set(heldStatus.activeHolds.map(h => h.domain)).size===3 && heldStatus.activeHolds.every(h => h.heldBy==='fixture' && h.heldAt !== null && Number.isFinite(new Date(String(h.heldAt)).getTime()) && Object.keys(h).sort().join(',')==='domain,heldAt,heldBy,recordId') && unheldStatus.activeHolds.length===0);
    await db.execute(sql`UPDATE retention_policies SET enabled=false WHERE guild_id=${failure}`);

    const timeoutGuild = await guild('lock-timeout');
    const timeoutRow = await db.execute(sql`INSERT INTO tickets (guild_id,creator_id,type,status,closed_at,transcript) VALUES (${timeoutGuild},'fixture','SUPPORT','CLOSED',statement_timestamp()-interval '800 days','private') RETURNING id`);
    let releaseLock!: () => void, lockReady!: () => void;
    const ready = new Promise<void>(resolve => { lockReady=resolve; });
    const blocker = db.transaction(async tx => {
      await tx.execute(sql`SELECT guild_id FROM retention_policies WHERE guild_id=${timeoutGuild} FOR UPDATE`);
      lockReady();
      await new Promise<void>(resolve => { releaseLock=resolve; });
    });
    await ready;
    const started = performance.now();
    const timedWorker = runRetentionMaintenance(db).then(() => false, () => true);
    let observed = false;
    try {
      for (let attempt=0;attempt<5000;attempt++) {
        const waiting = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%retention_policies%'`);
        if (Number(waiting.rows[0]?.count)>0) { observed=true; break; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const failed = await timedWorker;
      check('held policy lock rejects worker within bounded timeout', observed && failed && performance.now()-started < 10000);
      const intact = await db.execute(sql`SELECT transcript,transcript_redacted_at FROM tickets WHERE id=${Number(timeoutRow.rows[0]!.id)}`);
      check('lock timeout leaves payload marker receipts unchanged', intact.rows[0]?.transcript==='private' && intact.rows[0]?.transcript_redacted_at===null && (await db.execute(sql`SELECT count(*)::int AS count FROM retention_receipts WHERE guild_id=${timeoutGuild}`)).rows[0]?.count===0);
    } finally { releaseLock(); await blocker; }
    const recovered = await runRetentionMaintenance(db);
    check('next worker healthy after contention released', recovered.ticket===1);
    await db.execute(sql`UPDATE retention_policies SET enabled=false WHERE guild_id=${timeoutGuild}`);

    const prune = await guild('prune');
    await db.execute(sql`INSERT INTO retention_receipts (guild_id,domain,record_id,policy_version,policy_authorizer_id,redacted_at) SELECT ${prune},'TICKET',9000000000+n,1,'fixture',statement_timestamp()-interval '731 days' FROM generate_series(1,601) n`);
    await db.execute(sql`INSERT INTO retention_receipts (guild_id,domain,record_id,policy_version,policy_authorizer_id,redacted_at) VALUES (${prune},'TICKET',9000001000,1,'fixture',statement_timestamp()-interval '729 days')`);
    // UUIDs are generated in JS, avoiding a PostgreSQL extension dependency.
    for (let start = 0; start < 601; start += 100) {
      const values = Array.from({ length: Math.min(100,601-start) }, () => `('${randomUUID()}','${prune}','fixture',30,90,90,0,0,0,1,statement_timestamp()-interval '27 hours',statement_timestamp()-interval '26 hours')`).join(',');
      await db.execute(sql.raw(`INSERT INTO retention_previews (id,guild_id,requested_by,ticket_days,report_days,appeal_days,eligible_ticket_count,eligible_report_count,eligible_appeal_count,base_version,created_at,expires_at) VALUES ${values}`));
    }
    const validPreview = await service.preview({ guildId: prune, userId: 'fixture-owner', guildOwnerId: 'fixture-owner' }, { ticketDays:30, reportDays:90, appealDays:90 });
    const recentPreview = randomUUID();
    await db.execute(sql`INSERT INTO retention_previews (id,guild_id,requested_by,ticket_days,report_days,appeal_days,eligible_ticket_count,eligible_report_count,eligible_appeal_count,base_version,created_at,expires_at,consumed_at) VALUES (${recentPreview},${prune},'fixture',30,90,90,0,0,0,1,statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 hour',statement_timestamp()-interval '90 minutes')`);
    const marked = await db.execute(sql`INSERT INTO tickets (guild_id,creator_id,type,status,transcript,transcript_redacted_at,transcript_retention_policy_version) VALUES (${prune},'fixture','SUPPORT','CLOSED',NULL,statement_timestamp()-interval '731 days',1) RETURNING id`);
    await db.execute(sql`INSERT INTO tickets (guild_id,creator_id,type,status,closed_at,transcript) VALUES (${prune},'fixture','SUPPORT','CLOSED',statement_timestamp()-interval '800 days','concurrent-new')`);
    const prunePass = await runRetentionMaintenance(db);
    check('pruning bounded at500 while new redaction proceeds', prunePass.receiptsPruned === 500 && prunePass.previewsPruned === 500 && prunePass.ticket === 1);
    const countPrune = await db.execute(sql`SELECT (SELECT count(*)::int FROM retention_receipts WHERE guild_id=${prune} AND redacted_at < statement_timestamp()-interval '730 days') AS receipts,(SELECT count(*)::int FROM retention_previews WHERE guild_id=${prune} AND expires_at < statement_timestamp()-interval '24 hours') AS previews`);
    check('over500 old receipts and previews require another tick', countPrune.rows[0]?.receipts === 101 && countPrune.rows[0]?.previews === 101);
    await db.execute(sql`INSERT INTO tickets (guild_id,creator_id,type,status,closed_at,transcript) VALUES (${prune},'fixture','SUPPORT','CLOSED',statement_timestamp()-interval '800 days','concurrent-new-2')`);
    const concurrent = await Promise.all([runRetentionMaintenance(db), runRetentionMaintenance(db)]);
    check('concurrent new redaction and prune ticks stay bounded exactly once', concurrent.every(r => r.receiptsPruned <= 500 && r.previewsPruned <= 500) && concurrent.reduce((n,r) => n+r.ticket,0)===1);
    const preserved = await db.execute(sql`SELECT (SELECT count(*)::int FROM retention_receipts WHERE guild_id=${prune}) AS receipts,(SELECT count(*)::int FROM retention_previews WHERE guild_id=${prune}) AS previews,(SELECT transcript_redacted_at IS NOT NULL AND transcript IS NULL FROM tickets WHERE id=${Number(marked.rows[0]!.id)}) AS marker`);
    check('younger730 receipt and new receipt survive old pruning', preserved.rows[0]?.receipts === 3);
    check('valid and recently consumed previews survive pruning', preserved.rows[0]?.previews === 2 && await service.getPreview({ guildId: prune, userId: 'fixture-owner', guildOwnerId: 'fixture-owner' }, validPreview.id) !== null);
    check('pruning never removes payload redaction marker', preserved.rows[0]?.marker === true);
    await db.execute(sql`UPDATE retention_policies SET enabled=false WHERE guild_id=${prune}`);

    const a = await guild('fair-A'), b = await guild('fair-B');
    for (const c of configs) {
      await db.execute(sql.raw(`INSERT INTO ${c.table} (guild_id,${c.columns},status,${c.deadline},${c.payload}) SELECT '${a}',${c.values},'${c.terminal}',statement_timestamp()-interval '800 days','private' FROM generate_series(1,201)`));
      await db.execute(sql.raw(`INSERT INTO ${c.table} (guild_id,${c.columns},status,${c.deadline},${c.payload}) VALUES ('${b}',${c.values},'${c.terminal}',statement_timestamp()-interval '800 days','private')`));
    }
    const fair = await runRetentionMaintenance(db);
    check('A201 B1 same pass every domain within global100', fair.ticket === 21 && fair.report === 21 && fair.appeal === 21 && [fair.ticket,fair.report,fair.appeal].every(n => n <= 100));
    for (const c of configs) {
      const counts = await db.execute(sql.raw(`SELECT guild_id,count(*)::int AS count FROM ${c.table} WHERE guild_id IN ('${a}','${b}') AND ${c.marker} IS NOT NULL GROUP BY guild_id`));
      check(`${c.table} per-guild20 fair B handled`, counts.rows.find(r => r.guild_id === a)?.count === 20 && counts.rows.find(r => r.guild_id === b)?.count === 1);
    }
    await db.execute(sql`UPDATE retention_policies SET enabled=false WHERE guild_id IN (${a},${b})`);
    const many: string[] = [];
    for (let i=0;i<106;i++) many.push(await guild(`rotation-${String(i).padStart(3,'0')}`));
    for (const c of configs) {
      for (const id of many) await db.execute(sql.raw(`INSERT INTO ${c.table} (guild_id,${c.columns},status,${c.deadline},${c.payload}) SELECT '${id}',${c.values},'${c.terminal}',statement_timestamp()-interval '800 days','private' FROM generate_series(1,21)`));
    }
    let ticks = 0, maximum = 0;
    for (;ticks<44;ticks++) {
      const r = await runRetentionMaintenance(db);
      maximum = Math.max(maximum,r.ticket,r.report,r.appeal);
      check(`rotation tick${ticks+1} caps each domain global100`, r.ticket <= 100 && r.report <= 100 && r.appeal <= 100);
      const left = await db.execute(sql`SELECT count(*)::int AS count FROM tickets WHERE guild_id LIKE ${prefix+'-rotation-%'} AND transcript IS NOT NULL`);
      if (left.rows[0]?.count === 0) { ticks++; break; }
    }
    check('more100 guilds all handled in finite ticks with actual global100 saturation', ticks <= 44 && maximum === 100);
    for (const c of configs) {
      const pending = await db.execute(sql.raw(`SELECT count(*)::int AS count FROM ${c.table} WHERE guild_id LIKE '${prefix}-rotation-%' AND ${c.marker} IS NULL`));
      check(`${c.table} rotation drains all106 guilds`, pending.rows[0]?.count === 0);
    }
    console.log(JSON.stringify({ suite:'v8-retention-bounds', guilds:106, ticks, maximumPerDomain:maximum }));
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON retention_receipts`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${trigger}()`));
    for (const id of ids) await db.execute(sql`DELETE FROM guilds WHERE id=${id}`);
  }
}
