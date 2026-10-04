export type Tone = 'SUCCESS' | 'WARNING' | 'DANGER' | 'NEUTRAL' | 'INFO';
/** Text/data only: never implicitly serialize Error, arbitrary objects or their getters. */
export function escapeHtml(input: unknown): string {
  const value = input == null ? '' : typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint' ? String(input)
    : input instanceof Date && Number.isFinite(input.getTime()) ? input.toISOString() : '—';
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const states: Readonly<Record<string, readonly [string, Tone]>> = {
  ENABLED: ['Enabled', 'SUCCESS'], TRUE: ['Enabled', 'SUCCESS'], DISABLED: ['Disabled', 'NEUTRAL'], FALSE: ['Disabled', 'NEUTRAL'], ACTIVE: ['Active', 'SUCCESS'],
  PENDING: ['Pending', 'WARNING'], RUNNING: ['Running', 'INFO'], SUCCEEDED: ['Succeeded', 'SUCCESS'],
  FAILED: ['Failed', 'DANGER'], SKIPPED: ['Skipped', 'NEUTRAL'], UNCERTAIN: ['Uncertain', 'WARNING'],
  CLOSED: ['Closed', 'NEUTRAL'], OPEN: ['Open', 'INFO'], UNDER_REVIEW: ['Under Review', 'INFO'],
  ACCEPTED: ['Accepted', 'SUCCESS'], REJECTED: ['Rejected', 'DANGER'], IMPLEMENTED: ['Implemented', 'SUCCESS'],
  READY: ['Ready', 'SUCCESS'], NOT_READY: ['Not ready', 'WARNING'], HEALTHY: ['Healthy', 'SUCCESS'],
  DEGRADED: ['Degraded', 'WARNING'], STARTING: ['Starting', 'WARNING'], STOPPING: ['Stopping', 'WARNING'],
  STOPPED: ['Stopped', 'NEUTRAL'], STALE: ['Stale', 'WARNING'], EMPTY: ['Empty', 'NEUTRAL'],
  ACTIONABLE: ['Actionable', 'WARNING'], AMBIGUOUS: ['Ambiguous', 'WARNING'], UNAVAILABLE: ['Unavailable', 'WARNING'],
  NOT_TRACKED: ['NOT_TRACKED', 'NEUTRAL'], MISMATCH: ['Mismatch', 'DANGER'], COMPLETED: ['Completed', 'SUCCESS'],
  PARTIAL: ['Partial', 'WARNING'], CONFIRMED: ['Confirmed', 'INFO'], PREVIEWED: ['Previewed', 'WARNING'],
  EXECUTING: ['Executing', 'INFO'], DENIED: ['Denied', 'DANGER'], CANCELLED: ['Cancelled', 'NEUTRAL'],
  ENDED: ['Ended', 'NEUTRAL'], SCHEDULED: ['Scheduled', 'INFO'], CREATING: ['Creating', 'INFO'],
  DELETING: ['Deleting', 'WARNING'], PROCESSING: ['Processing', 'INFO'], CLAIMED: ['Claimed', 'INFO'],
};
export function statusBadge(value: unknown): string {
  const raw = typeof value === 'boolean' ? value ? 'ENABLED' : 'DISABLED' : typeof value === 'string' ? value : 'Unknown';
  const key = raw.trim().toUpperCase().replaceAll(' ', '_');
  const [label, tone] = states[key] ?? [raw || 'Unknown', 'NEUTRAL'];
  return `<span class="status status-${tone.toLowerCase()}${Object.hasOwn(states, key) ? ' status-known' : ''}" data-status="${escapeHtml(key)}">${escapeHtml(label)}</span>`;
}
export function notice(text: string, tone: Tone = 'INFO', heading?: string): string {
  return `<div class="notice notice-${tone.toLowerCase()}" role="${tone === 'DANGER' ? 'alert' : 'status'}">${heading ? `<strong>${escapeHtml(heading)}</strong>` : ''}<p>${escapeHtml(text)}</p></div>`;
}
export const emptyState = (title: string, detail?: string): string => `<div class="empty-state"><p>${escapeHtml(title)}</p>${detail ? `<p class="muted">${escapeHtml(detail)}</p>` : ''}</div>`;
/** bodyHtml/controlHtml slots are composed escaped SSR markup, never raw domain text. */
export const panel = (title: string, bodyHtml: string): string => `<section class="panel"><h2>${escapeHtml(title)}</h2>${bodyHtml}</section>`;
export const metadataList = (entries: readonly (readonly [string, unknown])[]): string => `<dl class="metadata">${entries.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd${/\bID\b| by$|hash$/i.test(key) ? ' class="id-value"' : ''}>${escapeHtml(value)}</dd>`).join('')}</dl>`;
export function tableShell(caption: string, columns: readonly string[], rows: readonly (readonly unknown[])[], options: { statusColumns?: readonly number[]; idColumns?: readonly number[] } = {}): string {
  return `<div class="table-wrap" role="region" aria-label="${escapeHtml(caption)}" tabindex="0"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${columns.map(c => `<th scope="col">${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((v, i) => `<td${options.idColumns?.includes(i) ? ' class="id-value"' : ''}>${options.statusColumns?.includes(i) ? statusBadge(v) : escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
export const fieldHelp = (id: string, text: string): string => `<small class="field-help" id="${escapeHtml(id)}">${escapeHtml(text)}</small>`;
export const formGroup = (label: string, controlHtml: string, helpHtml = ''): string => `<div class="form-group"><label>${escapeHtml(label)}${controlHtml}</label>${helpHtml}</div>`;
export const destructiveWarning = (text: string): string => `<div class="destructive-warning">${notice(text, 'WARNING', 'Before confirming')}</div>`;
export const pageHeader = (title: string, description?: string): string => `<div class="page-header"><h1>${escapeHtml(title)}</h1>${description ? `<p class="muted">${escapeHtml(description)}</p>` : ''}</div>`;
export const inputId = (scope: string, name: string): string => `field-${scope.replace(/[^a-zA-Z0-9_-]/g, '-')}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
export function utc(value: Date | string | null): string { if (!value) return '—'; const d = value instanceof Date ? value : new Date(value); return Number.isFinite(d.getTime()) ? `${d.toISOString()} UTC` : '—'; }
