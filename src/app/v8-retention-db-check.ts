import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { runExtendedRetentionChecks } from './v8-retention-regression-driver.js';
import { TicketRepository } from '../modules/tickets/repository.js';
import { ReportRepository } from '../modules/reports/repository.js';
import { ReportService } from '../modules/reports/service.js';
import { PermissionService } from '../core/permissions/permission-service.js';
import { createDatabase } from '../core/database/connection.js';
import { appeals, guilds, reports, retentionPolicies, retentionPreviews, retentionReceipts, tickets } from '../core/database/schema.js';
import { DataRetentionService } from '../modules/data-retention/service.js';
import { runRetentionMaintenance } from '../modules/data-retention/maintenance.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Explicit synthetic DATABASE_URL required; local .env is never loaded.');
const target = new URL(databaseUrl);
const databaseName = decodeURIComponent(target.pathname.slice(1));
if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname) ||
  !(/^eiren_v8_[a-z0-9_]+$/.test(databaseName) || (process.env.GITHUB_ACTIONS === 'true' && databaseName === 'eiren'))) {
  throw new Error('Refusing destructive maintenance validation outside an explicitly isolated loopback V8 database (or empty CI eiren database).');
}
const connection = createDatabase(databaseUrl);
const db = connection.db;
const guildId = `v8-check-${randomUUID()}`;
const otherId = `v8-check-${randomUUID()}`;
const ownerId = 'v8-fixture-owner';
const actor = { guildId, userId: ownerId, guildOwnerId: ownerId, roleIds: [] };
const other = { guildId: otherId, userId: ownerId, guildOwnerId: ownerId, roleIds: [] };
const old = new Date(Date.now() - 800 * 86_400_000);
const secret = `private-fixture-${randomUUID()}`;
const checks: string[] = [];
function check(name: string, condition: unknown): asserts condition { if (!condition) throw new Error(name); checks.push(name); }
async function rejects(name: string, action: () => Promise<unknown>) {
  let failed = false;
  try { await action(); } catch { failed = true; }
  check(name, failed);
}
async function dbRejects(name: string, query: () => Promise<unknown>) { await rejects(name, query); }
const service = new DataRetentionService(db);
try {
  const existing = await db.execute(sql`SELECT (SELECT count(*) FROM guilds) AS guilds,
    (SELECT count(*) FROM tickets) AS tickets, (SELECT count(*) FROM reports) AS reports,
    (SELECT count(*) FROM appeals) AS appeals, (SELECT count(*) FROM retention_policies) AS policies,
    (SELECT count(*) FROM retention_previews) AS previews, (SELECT count(*) FROM retention_receipts) AS receipts`);
  check('isolated database contains no existing guild or retention data',
    Object.values(existing.rows[0] ?? {}).every(n => Number(n) === 0));
  await db.insert(guilds).values([{ id: guildId }, { id: otherId }]);
  const [ticket] = await db.insert(tickets).values({ guildId, creatorId: ownerId, type: 'SUPPORT', status: 'CLOSED', closedAt: old,
    closedBy: ownerId, closeReason: 'preserved-close-reason', transcriptGeneratedAt: old, transcript: secret }).returning();
  const [report] = await db.insert(reports).values({ guildId, reporterId: ownerId, category: 'OTHER', status: 'CLOSED', closedAt: old, description: secret, evidenceUrl: secret, resolutionNote: secret }).returning();
  const [appeal] = await db.insert(appeals).values({ guildId, appellantId: ownerId, status: 'REJECTED', reviewedAt: old, reason: secret, reviewNote: secret }).returning();
  const [open] = await db.insert(tickets).values({ guildId, creatorId: ownerId, type: 'SUPPORT', status: 'OPEN', transcript: secret, createdAt: old }).returning();
  const [foreign] = await db.insert(tickets).values({ guildId: otherId, creatorId: ownerId, type: 'SUPPORT', status: 'CLOSED', closedAt: old, transcript: secret }).returning();
  check('synthetic fixtures inserted', !!ticket && !!report && !!appeal && !!open && !!foreign);
  const initial = await service.status(guildId);
  check('default off and no implicit policy', !initial.policy.enabled && (await db.select().from(retentionPolicies).where(eq(retentionPolicies.guildId, guildId))).length === 0);
  const noOptIn = await runRetentionMaintenance(db);
  check('old private backlog with no owner optin receives zero redaction', noOptIn.ticket === 0 && noOptIn.report === 0 && noOptIn.appeal === 0 &&
    (await db.select().from(tickets).where(eq(tickets.id, ticket.id)))[0]?.transcript === secret &&
    (await db.select().from(reports).where(eq(reports.id, report.id)))[0]?.description === secret &&
    (await db.select().from(appeals).where(eq(appeals.id, appeal.id)))[0]?.reason === secret);
  await rejects('owner required', () => service.preview({ ...actor, userId: 'not-owner' }, { ticketDays: 30, reportDays: 90, appealDays: 90 }));
  await rejects('window lower bound', () => service.preview(actor, { ticketDays: 29, reportDays: 90, appealDays: 90 }));
  await rejects('window upper bound', () => service.preview(actor, { ticketDays: 30, reportDays: 731, appealDays: 90 }));
  await dbRejects('database policy window check', () => db.insert(retentionPolicies).values({ guildId, ticketRetentionDays: 29 }));
  await dbRejects('database preview window check', () => db.insert(retentionPreviews).values({ id: randomUUID(), guildId, requestedBy: ownerId, ticketDays: 29, reportDays: 90, appealDays: 90, eligibleTicketCount: 0, eligibleReportCount: 0, eligibleAppealCount: 0, baseVersion: 0, expiresAt: new Date(Date.now() + 60000) }));
  const windows = { ticketDays: 30, reportDays: 90, appealDays: 90 };
  const preview = await service.preview(actor, windows);
  check('preview counts private domains', preview.eligibleCounts.ticket === 1 && preview.eligibleCounts.report === 1 && preview.eligibleCounts.appeal === 1);
  const requester = { ...actor, userId: 'other-requester', guildOwnerId: 'other-requester' };
  check('other requester preview hidden', await service.getPreview(requester, preview.id) === null);
  await rejects('other requester confirm refused', () => service.confirm(requester, preview.id));
  await rejects('cross guild clearHold', () => service.clearHold(actor, 'TICKET', foreign.id));
  check('cross guild preview hidden', (await service.getPreview(other, preview.id)) === null);
  await rejects('cross guild confirm', () => service.confirm(other, preview.id));
  await rejects('cross guild hold', () => service.setHold(actor, 'TICKET', foreign.id));
  await service.setHold(actor, 'TICKET', ticket.id);
  await rejects('count changing preview', () => service.confirm(actor, preview.id));
  const held = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
  check('hold persisted', held[0]?.retentionHold && held[0]?.retentionHoldBy === ownerId);
  await service.clearHold(actor, 'TICKET', ticket.id);
  const expired = await service.preview(actor, windows);
  await db.update(retentionPreviews).set({ createdAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() - 1000) }).where(eq(retentionPreviews.id, expired.id));
  await rejects('expired preview', () => service.confirm(actor, expired.id));
  const fresh = await service.preview(actor, windows);
  await service.confirm(actor, fresh.id);
  await rejects('consumed preview', () => service.confirm(actor, fresh.id));
  let enabled = await service.status(guildId);
  check('explicit owner optin', enabled.policy.enabled && enabled.policy.confirmedBy === ownerId && enabled.policy.version > 0);
  await rejects('stale version preview', () => service.confirm(actor, preview.id));
  const changePreview = await service.preview(actor, { ticketDays: 31, reportDays: 91, appealDays: 91 });
  const changed = await service.confirm(actor, changePreview.id);
  check('window change requires fresh confirmation and increments version', changed.previousEnabled && changed.version === enabled.policy.version + 1 &&
    changed.ticketDays === 31 && changed.reportDays === 91 && changed.appealDays === 91);
  enabled = await service.status(guildId);
  const outcome = await runRetentionMaintenance(db);
  const [redactedTicket] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
  const [redactedReport] = await db.select().from(reports).where(eq(reports.id, report.id));
  const [redactedAppeal] = await db.select().from(appeals).where(eq(appeals.id, appeal.id));
  check('redaction rows found', !!redactedTicket && !!redactedReport && !!redactedAppeal);
  check('three private payloads redacted', redactedTicket.transcript === null && redactedTicket.transcriptRedactedAt && redactedReport.description === null && redactedReport.narrativeRedactedAt && redactedAppeal.reason === null && redactedAppeal.narrativeRedactedAt);
  check('associated private fields removed', redactedReport.evidenceUrl === null && redactedReport.resolutionNote === null && redactedAppeal.reviewNote === null);
  check('lifecycle identity retained', redactedTicket.id === ticket.id && redactedTicket.status === 'CLOSED' && redactedReport.id === report.id && redactedReport.status === 'CLOSED' && redactedAppeal.id === appeal.id && redactedAppeal.status === 'REJECTED');
  check('nonpayload close reason generation time category actors and terminal dates preserved',
    redactedTicket.closeReason === ticket.closeReason && redactedTicket.creatorId === ticket.creatorId && redactedTicket.closedBy === ticket.closedBy &&
    redactedTicket.transcriptGeneratedAt?.getTime() === ticket.transcriptGeneratedAt?.getTime() && redactedTicket.closedAt?.getTime() === ticket.closedAt?.getTime() &&
    redactedReport.category === report.category && redactedReport.reporterId === report.reporterId && redactedReport.closedAt?.getTime() === report.closedAt?.getTime() &&
    redactedAppeal.appellantId === appeal.appellantId && redactedAppeal.caseId === appeal.caseId && redactedAppeal.reviewedAt?.getTime() === appeal.reviewedAt?.getTime());
  check('policy version stamped', redactedTicket.transcriptRetentionPolicyVersion === enabled.policy.version && redactedReport.narrativeRetentionPolicyVersion === enabled.policy.version && redactedAppeal.narrativeRetentionPolicyVersion === enabled.policy.version);
  const receipts = await db.select().from(retentionReceipts).where(eq(retentionReceipts.guildId, guildId));
  check('receipts only authorization metadata', receipts.length === 3 && receipts.every(r => r.policyVersion === enabled.policy.version && r.policyAuthorizerId === ownerId && r.redactedAt instanceof Date));
  await rejects('redaction first refuses hold', () => service.setHold(actor, 'TICKET', ticket.id));
  const ticketRepository = new TicketRepository(db);
  let fetches = 0;
  const archived = await ticketRepository.archive(guildId, ticket.id, ownerId, 'must not overwrite', async () => { fetches++; return secret; });
  check('actual archive redacted CLOSED invokes zero fetch', !archived.changed && fetches === 0 && archived.row.transcript === null);
  check('saveTranscript cannot overwrite redaction', await ticketRepository.saveTranscript(guildId, ticket.id, secret) === undefined);
  const reportRepository = new ReportRepository(db);
  const reportService = new ReportService(reportRepository, new PermissionService({ getRoleLevels: async () => [] }));
  const normalActor = { ...actor, userId: 'normal-submitter' };
  const normalReport = await reportService.submitReport(normalActor, { category: 'OTHER', description: '  normal nonempty report  ' });
  const normalAppeal = await reportService.submitAppeal(normalActor, { reason: '  normal nonempty appeal  ' });
  check('normal service creation retains nonempty narratives', normalReport.description === 'normal nonempty report' && normalAppeal.reason === 'normal nonempty appeal');
  await rejects('service rejects empty report', () => reportService.submitReport(normalActor, { category: 'OTHER', description: '   ' }));
  await rejects('service rejects empty appeal', () => reportService.submitAppeal(normalActor, { reason: '   ' }));
  check('close refuses redacted report write', await reportRepository.closeReport(guildId, report.id, ownerId, secret) === undefined);
  check('review refuses redacted appeal write', await reportRepository.reviewAppeal(guildId, appeal.id, ownerId, 'ACCEPTED', secret) === undefined);
  const scoped = await service.status(otherId);
  check('status receipts and active holds guild scoped', scoped.recentReceipts.length === 0 && Object.values(scoped.holdCounts).every(n => n === 0));
  check('active and foreign payload remain', (await db.select().from(tickets).where(eq(tickets.id, open.id)))[0]?.transcript === secret && (await db.select().from(tickets).where(eq(tickets.id, foreign.id)))[0]?.transcript === secret);
  check('bounded maintenance result', Object.values(outcome).every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 500));
  // Two workers contend for one eligible record while a policy-row barrier is held.
  const [raceTicket] = await db.insert(tickets).values({ guildId, creatorId: ownerId, type: 'SUPPORT', status: 'CLOSED', closedAt: old, transcript: secret }).returning();
  check('race ticket inserted', !!raceTicket);
  let release!: () => void, ready!: () => void;
  const barrier = new Promise<void>(resolve => { ready = resolve; });
  const lockedPolicy = db.transaction(async tx => {
    await tx.execute(sql`SELECT guild_id FROM retention_policies WHERE guild_id = ${guildId} FOR UPDATE`);
    ready();
    await new Promise<void>(resolve => { release = resolve; });
  });
  await barrier;
  const workers = [runRetentionMaintenance(db), runRetentionMaintenance(db)];
  let observed = false;
  try {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const waiting = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%retention_policies%'`);
      if (Number(waiting.rows[0]?.count) >= 1) { observed = true; break; }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally { release(); }
  await lockedPolicy;
  const results = await Promise.all(workers);
  check('worker observed waiting behind policy barrier', observed);
  const raceReceipts = await db.select().from(retentionReceipts).where(eq(retentionReceipts.guildId, guildId));
  check('two workers redact exactly once', results[0]!.ticket + results[1]!.ticket === 1 && raceReceipts.filter(r => r.recordId === raceTicket.id && r.domain === 'TICKET').length === 1);
  // A worker has selected the candidate but is blocked on the policy row.
  // Commit a hold first; it must recheck the target under that row lock.
  const [holdRaceTicket] = await db.insert(tickets).values({ guildId, creatorId: ownerId, type: 'SUPPORT', status: 'CLOSED', closedAt: old, transcript: secret }).returning();
  check('hold race ticket inserted', !!holdRaceTicket);
  let finishHold!: () => void, holdReady!: () => void;
  const holdLocked = db.transaction(async tx => {
    await tx.execute(sql`SELECT guild_id FROM retention_policies WHERE guild_id = ${guildId} FOR UPDATE`);
    holdReady();
    await new Promise<void>(resolve => { finishHold = resolve; });
    await tx.execute(sql`UPDATE tickets SET retention_hold = true,retention_hold_by = ${ownerId},retention_hold_at = clock_timestamp() WHERE guild_id = ${guildId} AND id = ${holdRaceTicket.id}`);
  });
  await new Promise<void>(resolve => { holdReady = resolve; });
  const heldWorker = runRetentionMaintenance(db);
  let holdWaitObserved = false;
  try {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const waiting = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%retention_policies%'`);
      if (Number(waiting.rows[0]?.count) >= 1) { holdWaitObserved = true; break; }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally { finishHold(); }
  await holdLocked;
  const heldOutcome = await heldWorker;
  check('hold blocks stale selected worker', holdWaitObserved && heldOutcome.ticket === 0 &&
    (await db.select().from(tickets).where(eq(tickets.id, holdRaceTicket.id)))[0]?.transcript === secret &&
    (await db.select().from(retentionReceipts).where(eq(retentionReceipts.recordId, holdRaceTicket.id))).length === 0);
  // Enabled version changes alone must fence a selected row, without disabling.
  const [versionTicket] = await db.insert(tickets).values({ guildId, creatorId: ownerId, type: 'SUPPORT', status: 'CLOSED', closedAt: old, transcript: secret }).returning();
  let finishVersion!: () => void, versionReady!: () => void;
  const versionBarrier = new Promise<void>(resolve => { versionReady = resolve; });
  const versionLocked = db.transaction(async tx => {
    await tx.execute(sql`SELECT guild_id FROM retention_policies WHERE guild_id = ${guildId} FOR UPDATE`);
    versionReady();
    await new Promise<void>(resolve => { finishVersion = resolve; });
    await tx.execute(sql`UPDATE retention_policies SET version = version + 1 WHERE guild_id = ${guildId}`);
  });
  await versionBarrier;
  const versionWorker = runRetentionMaintenance(db);
  let versionObserved = false;
  try {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const waiting = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%retention_policies%'`);
      if (Number(waiting.rows[0]?.count) >= 1) { versionObserved = true; break; }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally { finishVersion(); }
  await versionLocked;
  const versionOutcome = await versionWorker;
  check('enabled version change fences stale selection', versionObserved && versionOutcome.ticket === 0 && (await service.status(guildId)).policy.enabled &&
    (await db.select().from(tickets).where(eq(tickets.id, versionTicket!.id)))[0]?.transcript === secret &&
    (await db.select().from(retentionReceipts).where(eq(retentionReceipts.recordId, versionTicket!.id))).length === 0);
  // A disabled/version-changed policy must similarly fence an already-selected row.
  const [disableRaceTicket] = await db.insert(tickets).values({ guildId, creatorId: ownerId, type: 'SUPPORT', status: 'CLOSED', closedAt: old, transcript: secret }).returning();
  check('disable race ticket inserted', !!disableRaceTicket);
  let finishDisable!: () => void, disableReady!: () => void;
  const disableLocked = db.transaction(async tx => {
    await tx.execute(sql`SELECT guild_id FROM retention_policies WHERE guild_id = ${guildId} FOR UPDATE`);
    disableReady();
    await new Promise<void>(resolve => { finishDisable = resolve; });
    await tx.execute(sql`UPDATE retention_policies SET enabled = false,version = version + 1 WHERE guild_id = ${guildId}`);
  });
  await new Promise<void>(resolve => { disableReady = resolve; });
  const disabledWorker = runRetentionMaintenance(db);
  let disableWaitObserved = false;
  try {
    for (let attempt = 0; attempt < 5000; attempt++) {
      const waiting = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%retention_policies%'`);
      if (Number(waiting.rows[0]?.count) >= 1) { disableWaitObserved = true; break; }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally { finishDisable(); }
  await disableLocked;
  const disabledOutcome = await disabledWorker;
  check('disable and version fence stale selected worker', disableWaitObserved && disabledOutcome.ticket === 0 &&
    (await db.select().from(tickets).where(eq(tickets.id, disableRaceTicket.id)))[0]?.transcript === secret &&
    (await db.select().from(retentionReceipts).where(eq(retentionReceipts.recordId, disableRaceTicket.id))).length === 0);
  check('disable persists', !(await service.status(guildId)).policy.enabled);
  const second = await runRetentionMaintenance(db);
  check('idempotent second maintenance', second.ticket === 0 && (await db.select().from(retentionReceipts).where(eq(retentionReceipts.guildId, guildId))).length === 4);
  await db.update(retentionReceipts).set({ redactedAt: new Date(Date.now() - 731 * 86_400_000) }).where(eq(retentionReceipts.guildId, guildId));
  await db.update(retentionPreviews).set({ createdAt: new Date(Date.now() - 26 * 3_600_000), expiresAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(retentionPreviews.guildId, guildId));
  await runRetentionMaintenance(db);
  check('730d receipts pruned', (await db.select().from(retentionReceipts).where(eq(retentionReceipts.guildId, guildId))).length === 0);
  check('24h previews pruned', (await db.select().from(retentionPreviews).where(eq(retentionPreviews.guildId, guildId))).length === 0);
  await runExtendedRetentionChecks(db, check, rejects);
  await db.delete(guilds).where(eq(guilds.id, guildId));
  await db.delete(guilds).where(eq(guilds.id, otherId));
  const cleanup = await db.execute(sql`SELECT (SELECT count(*) FROM guilds) AS guilds,
    (SELECT count(*) FROM tickets) AS tickets,(SELECT count(*) FROM reports) AS reports,
    (SELECT count(*) FROM appeals) AS appeals,(SELECT count(*) FROM retention_policies) AS policies,
    (SELECT count(*) FROM retention_previews) AS previews,(SELECT count(*) FROM retention_receipts) AS receipts`);
  check('all suite guild and retention fixtures cleaned', Object.values(cleanup.rows[0] ?? {}).every(n => Number(n)===0));
  console.log(JSON.stringify({ suite: 'v8-retention-db', checks: checks.length, names: checks }));
} catch (error) {
  console.error(JSON.stringify({ suite: 'v8-retention-db', passed: checks.length, failure: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
} finally {
  try { await db.delete(guilds).where(eq(guilds.id, guildId)); await db.delete(guilds).where(eq(guilds.id, otherId)); }
  finally { await connection.pool.end(); }
}
