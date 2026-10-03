import type { OperationsDashboardView } from '../services/operations-view.js';
import type { SchedulerTelemetrySnapshot } from '../core/operations/scheduler-telemetry.js';
import { escapeHtml as e } from './ui.js';

const utc = (value: Date | null): string => value && Number.isFinite(value.getTime()) ? `${value.toISOString()} UTC` : '—';
const table = (caption: string, columns: readonly string[], rows: readonly (readonly unknown[])[]): string => `<div class="table-wrap"><table><caption>${e(caption)}</caption><thead><tr>${columns.map(c => `<th scope="col">${e(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${e(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
function scheduler(name: string, value: SchedulerTelemetrySnapshot): string {
  return `<section><h3>${e(name)} — ${e(value.state)}</h3><p>Since process restart. Ticks attempted: ${e(value.tickCount)}; active tick: ${e(value.running ? 'RUNNING' : 'IDLE')}. Started: ${e(utc(value.startedAt))}; stopped: ${e(utc(value.stoppedAt))}. Last tick started: ${e(utc(value.lastTickStartedAt))}; completed: ${e(utc(value.lastTickCompletedAt))}; active since: ${e(utc(value.activeTickStartedAt))}.</p>${table('Job telemetry — Since process restart', ['Job', 'State', 'Last attempt (UTC)', 'Last success (UTC)', 'Last failure (UTC)', 'Duration (ms)', 'Running since (UTC)', 'Failure category', 'Static stage'], value.jobs.map(job => [job.name, job.state, utc(job.lastAttemptAt), utc(job.lastSuccessAt), utc(job.lastFailureAt), job.lastDurationMs ?? '—', utc(job.currentRunningSince), job.lastFailureCategory ?? '—', job.stage ?? '—']))}</section>`;
}
export function renderOperationsDashboard(guildId: string, data: OperationsDashboardView): string {
  const { process: processState, readiness, guild } = data;
  const processRows: unknown[][] = [
    ['Process phase', processState.phase], ['Process started (UTC)', utc(processState.processStartedAt)],
    ['Process uptime (seconds, process clock)', Math.floor(processState.uptimeMs / 1000)],
    ['Startup schema probe', processState.startupProbe], ['Startup failure category', processState.startupProbeFailureCategory ?? '—'],
    ['Readiness', readiness.ready ? 'READY' : 'NOT_READY'], ['Database', readiness.database], ['Migrations', readiness.migrations],
    ['Expected migration count', readiness.expectedCount], ['Observed migration count', readiness.observedCount ?? 'UNAVAILABLE'],
    ['Expected latest migration tag', readiness.expectedTag], ['Observed latest migration tag', readiness.observedTag ?? 'UNAVAILABLE'],
    ['Discord gateway', readiness.gateway], ['Scheduler freshness', readiness.scheduler],
  ];
  for (const [name, value] of Object.entries(processState.reconciliations)) processRows.push([`${name} startup reconciliation`, value.status], [`${name} safe failure category`, value.failureCategory ?? '—']);
  const base = `/g/${encodeURIComponent(guildId)}`;
  const boundaryLabels: Partial<Record<string, string>> = { backup_health: 'Production backup health',
    discord_orphans: 'Actual Discord ticket-channel orphan state', tls_health: 'External TLS / reverse-proxy health',
    historical_failures: 'Scheduler failures before current process restart' };
  return `<section><h2>Process / readiness</h2><p>Runtime telemetry since process restart. No durable history; an absence of errors does not prove historic health.</p>${table('Global process metadata (process clock)', ['Field', 'State'], processRows)}</section>
<section><h2>Scheduler status — Since process restart</h2><p>Freshness requires a completed tick within max(3 × interval, 90 seconds), with no active tick exceeding that threshold. A failed individual job is DEGRADED; fresh ticks alone do not prove every job succeeded.</p>${scheduler('V5 scheduler', data.schedulers.v5)}${scheduler('Moderation scheduler', data.schedulers.moderation)}</section>
<section><h2>Guild modules</h2><p>Effective availability and persisted state epoch/version; not an application release version. Core is always enabled. No override means epoch 0.</p>${guild.modules === null ? '<p>UNAVAILABLE</p>' : table('Selected guild only', ['Module key', 'Effective state', 'Epoch/version'], guild.modules.map(m => [m.key, m.enabled ? 'ENABLED' : 'DISABLED', m.version]))}</section>
<section><h2>Guild operational backlog</h2><p>Read-only durable evidence for this guild only. Ages use PostgreSQL time, not browser time. Pending work may be awaiting the next normal tick; fresh claims are not failures.</p>${table('Guild-scoped counts and database ages', ['Diagnostic', 'Classification', 'Count', 'Oldest relevant timestamp (UTC)', 'Age (seconds, DB clock)'], guild.diagnostics.filter(d => d.status !== 'NOT_TRACKED').map(d => [d.key, d.status, d.count ?? 'UNAVAILABLE', utc(d.oldestAt), d.ageSeconds ?? '—']))}</section>
<section><h2>Governance warnings / existing reconciliation links</h2><p>Automation UNCERTAIN: The external side effect cannot be proven. Do not blindly retry; inspect and reconcile. <a href="${e(`${base}/automations`)}">Existing Automations reconciliation view</a>.</p><p>Governance audit gap: The domain mutation committed, but the normal dashboard audit write was not confirmed. Do not repeat the mutation. Gaps are not failed domain mutations.</p><p><a href="${e(`${base}/data-retention`)}">Existing Data Retention governance</a> · <a href="${e(`${base}/privacy`)}">Existing Privacy governance</a>. Those guarded workflows remain authoritative.</p><p>Operations never retries, repairs, restarts, clears evidence, executes privacy requests or performs retention. Refresh with a normal GET.</p></section>
<section><h2>Explicit not-tracked boundaries</h2><p>NOT_TRACKED is unknown, not zero or healthy.</p>${table('No durable proof in Eiren', ['Boundary', 'State'], guild.diagnostics.filter(d => d.status === 'NOT_TRACKED').map(d => [`${boundaryLabels[d.key] ?? d.key} (${d.key})`, 'NOT_TRACKED']))}<p>Database-backed sessions and fresh Discord authorization are required for this page. During dependency outages it may not render; use /healthz, /readyz and sanitized process logs. Synthetic restore rehearsal does not prove production backup availability.</p></section>`;
}
