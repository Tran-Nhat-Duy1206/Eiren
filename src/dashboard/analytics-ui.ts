import { escapeHtml as e, notice, statusBadge, tableShell, utc } from './presentation.js';

type Row = Record<string, unknown>;
const record = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error) && !(v instanceof Date) ? v as Row : {};
const scalar = (v: unknown): unknown => typeof v === 'number' ? Number.isFinite(v) ? v : '—' : typeof v === 'string' || typeof v === 'boolean' ? v : v instanceof Date ? utc(v) : '—';
const numeric = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const rows = (v: unknown, limit: number): Row[] => Array.isArray(v) ? v.slice(0, limit).map(record) : [];
const date = (v: unknown): string => v instanceof Date || typeof v === 'string' ? utc(v) : '—';
function fixedTable(title: string, value: unknown, columns: readonly string[], limit: number): string {
  if (!Array.isArray(value)) return `<p>${e(title)}: unavailable.</p>`;
  if (!value.length) return `<p>${e(title)}: no recorded rows.</p>`;
  return tableShell(title, columns, rows(value, limit).map(row => columns.map(key => /^(bucketStart|updatedAt)$/.test(key) ? date(row[key]) : scalar(row[key]))));
}
const metadata = (value: unknown, keys: readonly string[]): string => `<dl class="analytics-metadata">${keys.map(key => `<dt>${e(key)}</dt><dd>${e(scalar(record(value)[key]))}</dd>`).join('')}</dl>`;
function distribution(title: string, value: unknown): string {
  if (value === undefined || value === null || value instanceof Error) return `<p>${e(title)}: unavailable.</p>`;
  const entries = Object.entries(record(value)).slice(0, 10);
  return entries.length ? tableShell(title, ['Category', 'Count'], entries.map(([key, value]) => [key, scalar(value)])) : `<p>${e(title)}: no recorded categories.</p>`;
}
function additional(data: Row): string {
  const d = record(data.details);
  const detailKeys: Record<string, readonly string[]> = { tickets: ['opened', 'closed', 'open', 'averageResolutionSeconds'], suggestions: ['submitted', 'votes'], events: ['created', 'rsvps', 'attendance'], giveaways: ['created', 'entries', 'winners'], tempvoice: ['created', 'active'] };
  return `<details class="analytics-additional"><summary>Additional recorded analytics</summary>
<dl class="analytics-metadata"><dt>Since (UTC)</dt><dd>${e(date(data.since))}</dd><dt>Until (UTC)</dt><dd>${e(date(data.until))}</dd><dt>Configured timezone (display label only)</dt><dd>${e(scalar(data.timezone))}</dd></dl>
${metadata(data, ['guildId', 'range'])}<h3>Recorded totals</h3>${metadata(data.totals, ['messages', 'joins', 'leaves', 'net', 'voiceSeconds'])}
${fixedTable('Hourly trend (first 100 rows shown; source bounded to 2160; timestamps UTC)', data.trend, ['bucketStart', 'messages', 'joins', 'leaves', 'voiceSeconds'], 100)}
${fixedTable('Voice channels (up to 10)', data.voiceChannels, ['channelId', 'voiceSeconds'], 10)}
${fixedTable('Commands (up to 10)', data.commands, ['commandName', 'invocations', 'errors', 'totalDurationMs'], 10)}<h3>Business aggregates</h3>${metadata(data.business, ['moderation_cases', 'tickets', 'suggestions', 'events', 'attendance', 'giveaways', 'giveaway_entries', 'giveaway_winners', 'level_members', 'reputation_members', 'achievements'])}<h3>Detail aggregates</h3>${distribution('Moderation actions', record(d.moderation).actions)}
${fixedTable('Moderation daily (up to 92)', record(d.moderation).daily, ['day', 'count'], 92)}
${Object.entries(detailKeys).map(([key, keys]) => `<h4>${e(key)}</h4>${metadata(d[key], keys)}`).join('')}
${fixedTable('Tickets daily (up to 92)', record(d.tickets).daily, ['day', 'opened', 'closed'], 92)}
${['suggestions', 'events', 'giveaways'].map(key => distribution(`${key} statuses`, record(d[key]).statuses)).join('')}
${distribution('Achievement distribution', record(d.achievements).distribution)}
${fixedTable('Local days (up to 92; existing configured-day aggregates)', data.localDays, ['day', 'messages', 'joins', 'leaves', 'net', 'voice_seconds'], 92)}</details>`;
}
export type AnalyticsInput = { guildId: string; csrfToken: string; data?: unknown; range?: string; analyticsEnabled: boolean; showSettings: boolean; notice?: string; disabledModule?: string };
export function renderAnalyticsDashboard(input: AnalyticsInput): string {
  const base = `/g/${encodeURIComponent(input.guildId)}`, data = record(input.data), totals = record(data.totals);
  const ranges = [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']] as const;
  const range = ranges.some(([key]) => key === input.range) ? input.range : '7d';
  const metric = (label: string, value: number | undefined, detail: string): string => `<div class="analytics-metric"><dt>${e(label)}</dt><dd>${value === undefined ? '—' : e(value)}</dd><p>${e(value === undefined ? `${detail} · Unavailable` : detail)}</p></div>`;
  const voice = numeric(totals.voiceSeconds);
  const confirm = '<label class="analytics-confirm"><input type="checkbox" name="confirm" value="yes" required> I confirm this destructive action</label>';
  const form = (action: string, title: string, description: string, fields: string, danger: boolean): string => `<form class="analytics-settings-card" method="post" action="${e(`${base}/action/${action}`)}"><div class="analytics-settings-heading"><h3>${e(title)}</h3>${action === 'analytics-toggle' ? statusBadge(input.analyticsEnabled) : ''}</div><p>${e(description)}</p><input type="hidden" name="csrfToken" value="${e(input.csrfToken)}">${fields}
${confirm}<button class="${danger ? 'btn-danger' : 'btn-primary'}" type="submit">Set analytics ${danger ? 'retention' : 'availability'}</button></form>`;
  return `<div class="analytics-page">${input.notice ? notice(input.notice, 'SUCCESS') : ''}
<header class="analytics-header"><div><h1>Analytics</h1><p>See activity at a glance, then manage collection and retention without losing context.</p></div>
<form class="analytics-range" method="get" action="${e(`${base}/analytics`)}"><label for="analytics-range">Analytics range<select id="analytics-range" name="range">${ranges.map(([key, label]) => `<option value="${key}"${range === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label><button class="btn-secondary" type="submit">Show range</button></form></header>
${!input.analyticsEnabled || input.disabledModule ? notice('Analytics is disabled for this server. Historical data may still exist.', 'NEUTRAL') : `<dl class="analytics-metrics">
${metric('Messages', numeric(totals.messages), 'Recorded messages in this range')}
${metric('Members', numeric(data.currentMemberCount), 'Current server members')}
${metric('Voice', voice === undefined ? undefined : Math.floor(voice / 60), 'min · Whole minutes in this range')}
${metric('Channels shown (up to 10)', Array.isArray(data.channels) ? Math.min(data.channels.length, 10) : undefined, 'Recorded channel rows shown')}</dl>
<section class="analytics-channel-card"><h2>Channel activity</h2><p>A compact view of where message activity was observed in the selected range.</p>
<p class="analytics-window">Selected range; timestamps UTC. Configured timezone: ${e(scalar(data.timezone))} (display label only).</p>
${Array.isArray(data.channels) && data.channels.length ? tableShell('Read-only summary: Channel activity (up to 10 records; UTC window)', ['Channel ID', 'Messages', 'Voice (seconds)'], rows(data.channels, 10).map(row => [scalar(row.channelId), scalar(row.messages), scalar(row.voiceSeconds)]), { idColumns: [0] }) : `<p>${Array.isArray(data.channels) ? 'No analytics records for this range.' : 'Channel activity unavailable.'}</p>`}
${additional(data)}</section>`}
${input.showSettings ? `<section class="analytics-settings"><h2>Analytics settings</h2><p>Keep configuration secondary to the data.</p><div class="analytics-settings-grid">
${form('analytics-toggle', 'Collection status', 'Turning Analytics off stops new collection. Historical data is not deleted.', `<label for="analytics-enabled">Analytics availability<select id="analytics-enabled" name="enabled" required><option value="true"${input.analyticsEnabled ? ' selected' : ''}>Enabled</option><option value="false"${!input.analyticsEnabled ? ' selected' : ''}>Disabled</option></select></label>`, false)}
${form('analytics-retention', 'Retention policy', 'Changing retention affects how long Analytics records remain. Existing cleanup policy applies.', '<label for="analytics-days">Retention days<input id="analytics-days" name="days" type="number" min="30" max="730" step="1" aria-describedby="analytics-days-help" required></label><small id="analytics-days-help">Whole days within the existing permitted range.</small>', true)}</div></section>` : ''}</div>`;
}
