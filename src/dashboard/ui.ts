import { renderAutomationDashboard, type AutomationDashboardView } from './automation-ui.js';
import { renderRetentionDashboard, type RetentionView, type RetentionPreview } from './retention-ui.js';

type PageInput = { page: string; guildId: string; guildName: string; csrfToken: string; items?: unknown; data?: unknown; notice?: string; analyticsEnabled?: boolean; disabledModule?: string; actorLevel?: string; range?: string; userId?: string; retentionPreview?: RetentionPreview | null; isGuildOwner?: boolean };

export function escapeHtml(input: unknown): string {
  return String(input ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

const pages = [ ['overview', 'Overview'], ['moderation', 'Moderation'], ['members', 'Members'], ['roles', 'Roles'], ['tickets', 'Tickets'], ['suggestions', 'Suggestions'], ['levels', 'Levels'], ['events', 'Events'], ['giveaways', 'Giveaways'], ['analytics', 'Analytics'], ['automations', 'Automations'], ['data-retention', 'Data retention'], ['settings', 'Bot Settings'] ] as const;
type Page = typeof pages[number][0];
const levels = ['MEMBER', 'HELPER', 'MODERATOR', 'SENIOR_MODERATOR', 'ADMIN', 'GUILD_OWNER', 'BOT_OWNER'];
const may = (actor: string | undefined, required: string): boolean => actor !== undefined && levels.indexOf(actor) >= levels.indexOf(required);
const path = (guildId: string): string => `/g/${encodeURIComponent(guildId)}`;
const logout = (csrfToken?: string): string => csrfToken === undefined ? '' : `<form method="post" action="/logout" class="logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}"><button type="submit">Log out</button></form>`;
const layout = (title: string, body: string, nav = '', csrfToken?: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Eiren Dashboard</title><link rel="stylesheet" href="/assets/dashboard.css"></head><body><a class="skip" href="#main">Skip to content</a><header class="top"><strong>Eiren Dashboard</strong><span>${escapeHtml(title)}</span>${logout(csrfToken)}</header>${nav}<main id="main" tabindex="-1">${body}</main><footer>Dashboard</footer></body></html>`;

export function renderLogin(error?: string): string {
  return layout('Sign in', `<section class="panel"><h1>Sign in</h1><p>Sign in with Discord to manage your servers.</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<a class="button" href="/auth/discord">Continue with Discord</a></section>`);
}

export function renderGuildPicker(guilds: Array<{ id: string; name: string }>, csrfToken?: string): string {
  const entries = guilds.slice(0, 100).map(({ id, name }) => `<li><a href="${escapeHtml(`${path(String(id))}/overview`)}">${escapeHtml(name)} <span class="muted">Open dashboard</span></a></li>`).join('');
  return layout('Choose a server', `<section class="panel"><h1>Choose a server</h1>${guilds.length ? `<ul class="guild-list">${entries}</ul>` : '<p class="empty">No manageable servers are available.</p>'}${guilds.length > 100 ? '<p>Only the first 100 servers are shown.</p>' : ''}</section>`, '', csrfToken);
}

const protectedKey = /(?:secret|token|password|authorization|credential|private|transcript|reporttext|appealtext|supporttext|messagecontent|content|body|email|phone|ipaddress|webhook|oauth|cookie|sessionhash)/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const readable = (value: unknown): string => value instanceof Date ? value.toISOString() : typeof value === 'string' ? value.slice(0, 240) : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '—';
function table(input: unknown, showSuggestionContent = false): string {
  if (!Array.isArray(input) || !input.length) return '<p class="empty">No records to show.</p>';
  const rows = input.slice(0, 100).filter(record);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => (showSuggestionContent && key === 'content') || !protectedKey.test(key)).slice(0, 8);
  if (!rows.length || !columns.length) return '<p class="empty">No public summary fields to show.</p>';
  return `<p>${rows.length} record${rows.length === 1 ? '' : 's'} shown${input.length > 100 ? ' (first 100)' : ''}.</p><div class="table-wrap" role="region" aria-label="Read-only records" tabindex="0"><table><caption>Read-only summary (up to 100 records)</caption><thead><tr>${columns.map((key) => `<th scope="col">${escapeHtml(key)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((key) => `<td>${escapeHtml(readable(row[key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function sections(input: unknown, name: string, depth = 0): string {
  if (Array.isArray(input)) return table(input, name === 'Suggestions');
  if (!record(input)) return '<p class="empty">No records to show.</p>';
  return Object.entries(input).filter(([key]) => !protectedKey.test(key)).slice(0, 16).map(([key, value]) => {
    const title = key.replace(/([a-z])([A-Z])/g, '$1 $2');
    const body = Array.isArray(value) ? table(value) : record(value) && depth < 3
      ? sections(value, `${name} ${title}`, depth + 1) : `<p>${escapeHtml(readable(value))}</p>`;
    return `<section aria-label="${escapeHtml(`${name} ${title}`)}"><h2>${escapeHtml(title)}</h2>${body}</section>`;
  }).join('') || '<p class="empty">No public summary fields to show.</p>';
}
const text = (name: string, label: string, max = 200, pattern = ''): string => `<label>${escapeHtml(label)}<input name="${escapeHtml(name)}" type="text" maxlength="${max}"${pattern ? ` pattern="${pattern}"` : ''} required></label>`;
const number = (name: string, label: string, min: number, max: number): string => `<label>${escapeHtml(label)}<input name="${escapeHtml(name)}" type="number" min="${min}" max="${max}" step="1" required></label>`;
const choice = (name: string, label: string, options: readonly string[]): string => `<label>${escapeHtml(label)}<select name="${escapeHtml(name)}" required>${options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}</select></label>`;

export function renderPage({ page, guildId, guildName, csrfToken, items, data, notice, analyticsEnabled = false, disabledModule, actorLevel, range, userId, retentionPreview, isGuildOwner = false }: PageInput): string {
  const selected = pages.find(([key, title]) => key === page || title === page);
  const key = selected?.[0];
  const base = path(guildId);
  const navigation = `<nav class="side" aria-label="Dashboard"><a href="/guilds">All servers</a><ul>${pages.filter(([route]) => !['automations', 'data-retention'].includes(route) || may(actorLevel, 'ADMIN')).map(([route, title]) => `<li><a href="${escapeHtml(`${base}/${route}`)}"${key === route ? ' aria-current="page"' : ''}>${escapeHtml(title)}</a></li>`).join('')}</ul></nav>`;
  const form = (action: string, label: string, fields: string, destructive = false): string => `<form method="post" action="${escapeHtml(`${base}/action/${action}`)}"><h2>${escapeHtml(label)}</h2><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">${fields}${destructive ? '<label class="check"><input type="checkbox" name="confirm" value="yes" required> I confirm this destructive action</label>' : ''}<button type="submit">${escapeHtml(label)}</button></form>`;
  const forms: string[] = [];
  const add = (required: string, action: string, label: string, fields: string, destructive = false) => { if (!disabledModule && may(actorLevel, required)) forms.push(form(action, label, fields, destructive)); };
  if (key === 'settings') {
    add('ADMIN', 'module-toggle', 'Set module availability', text('module', 'Module key', 40, '[a-z][a-z0-9_-]*') + choice('enabled', 'Enabled', ['true', 'false']), true);
    add('ADMIN', 'guild-timezone', 'Set server timezone', text('timezone', 'IANA timezone', 64));
  }
  if (key === 'moderation') add('MODERATOR', 'moderation-warn', 'Warn member', text('targetId', 'Member ID', 20, '[0-9]{17,20}') + text('reason', 'Reason', 400), true);
  if (key === 'tickets') add('MODERATOR', 'ticket-close', 'Close ticket', number('id', 'Ticket ID', 1, Number.MAX_SAFE_INTEGER) + text('reason', 'Reason', 400), true);
  if (key === 'suggestions') add('MODERATOR', 'suggestion-status', 'Update suggestion status', number('id', 'Suggestion ID', 1, Number.MAX_SAFE_INTEGER) + choice('status', 'Status', ['PENDING', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'IMPLEMENTED']));
  if (key === 'levels') add('ADMIN', 'levels-config', 'Set minimum message length', number('minLength', 'Minimum message length', 0, 2000));
  if (key === 'events') add('MODERATOR', 'event-cancel', 'Cancel event', number('id', 'Event ID', 1, Number.MAX_SAFE_INTEGER), true);
  if (key === 'giveaways') add('MODERATOR', 'giveaway-end', 'End giveaway', number('id', 'Giveaway ID', 1, Number.MAX_SAFE_INTEGER), true);
  if (key === 'analytics') {
    add('ADMIN', 'analytics-toggle', 'Set analytics availability', choice('enabled', 'Enabled', ['true', 'false']), true);
    add('ADMIN', 'analytics-retention', 'Set analytics retention', number('days', 'Retention days', 30, 730), true);
  }
  if (key === 'roles') {
    add('GUILD_OWNER', 'role-set', 'Set permission role', text('roleId', 'Role ID', 20, '[0-9]{17,20}') + choice('level', 'Permission level', ['HELPER', 'MODERATOR', 'SENIOR_MODERATOR', 'ADMIN']), true);
    add('GUILD_OWNER', 'role-remove', 'Remove permission role', text('roleId', 'Role ID', 20, '[0-9]{17,20}'), true);
  }
  const rangeSelector = key === 'analytics' ? `<form method="get" action="${escapeHtml(`${base}/analytics`)}"><label>Analytics range<select name="range">${(['24h', '7d', '30d', '90d'] as const).map((option) => `<option value="${option}"${range === option ? ' selected' : ''}>${option}</option>`).join('')}</select></label><button type="submit">Show range</button></form>` : '';
  const memberLookup = key === 'members' ? `<form method="get" action="${escapeHtml(`${base}/members`)}"><label>Member user ID<input type="text" name="userId" maxlength="20" pattern="[0-9]{17,20}" value="${escapeHtml(userId ?? '')}" required></label><button type="submit">Look up member</button></form>` : '';
  const source = items ?? data;
  const summary = key === 'data-retention' ? data ? renderRetentionDashboard(guildId, csrfToken, data as RetentionView, retentionPreview ?? null, isGuildOwner) : '<p class="empty">Retention service unavailable.</p>' : key === 'automations' ? may(actorLevel, 'ADMIN') && data ? renderAutomationDashboard({ guildId, csrfToken, data: data as AutomationDashboardView }) : '<p class="error" role="alert">This page is not available.</p>' : !key ? '<p class="error" role="alert">This page is not available.</p>' : disabledModule
    ? `<p class="disabled" role="status">${escapeHtml(disabledModule)} is disabled for this server.</p>`
    : key === 'analytics' && !analyticsEnabled ? '<p class="disabled" role="status">Analytics is disabled for this server.</p>' : sections(source, selected[1]);
  return layout(guildName, `<div class="content"><p class="eyebrow">${escapeHtml(guildName)}</p><h1>${escapeHtml(selected?.[1] ?? 'Page unavailable')}</h1>${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ''}${rangeSelector}${memberLookup}${summary}${forms.join('')}${actorLevel ? `<p class="muted">Access level: ${escapeHtml(actorLevel)}</p>` : ''}</div>`, navigation, csrfToken);
}

export function dashboardCss(): string {
  return `:root{color-scheme:dark;--bg:#101827;--surface:#19263b;--text:#f5f8ff;--muted:#bdc9dc;--line:#445670;--accent:#8bc5ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.55 system-ui,sans-serif;display:grid;grid-template-columns:minmax(12rem,16rem) minmax(0,1fr);min-height:100vh}a{color:var(--accent)}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,.table-wrap:focus-visible{outline:3px solid #ffdc78;outline-offset:3px}.skip{position:absolute;left:-9999px;top:0;background:var(--surface);padding:.6rem}.skip:focus{left:1rem;z-index:10}.top{grid-column:1/-1;display:flex;gap:1rem;align-items:center;flex-wrap:wrap;padding:1rem 1.5rem;border-bottom:1px solid var(--line)}.logout{margin:0 0 0 auto;padding:0;background:none}.side{padding:1rem;border-right:1px solid var(--line)}.side ul{list-style:none;padding:0;margin:.6rem 0}.side a{display:block;padding:.45rem .7rem;border-radius:.4rem}.side a[aria-current=page]{background:var(--surface);color:var(--text);font-weight:700}main{min-width:0;padding:clamp(1rem,3vw,2rem)}.panel,.content{max-width:75rem}.panel{background:var(--surface);padding:1.5rem;border-radius:.7rem}.guild-list{list-style:none;padding:0}.guild-list li{padding:.7rem;border-bottom:1px solid var(--line)}.muted,.eyebrow{color:var(--muted)}.error,.notice,.disabled,.empty{padding:.9rem;border:1px solid var(--line);border-radius:.4rem}.error{border-color:#ff9a9a}.disabled{opacity:.8}.table-wrap{overflow-x:auto;max-width:100%}table{border-collapse:collapse;width:100%;text-align:left}caption{text-align:left;color:var(--muted);padding:.5rem}th,td{border-bottom:1px solid var(--line);padding:.65rem;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:minmax(8rem,15rem) 1fr;gap:.4rem}dd{margin:0;overflow-wrap:anywhere}form{display:grid;gap:1rem;max-width:35rem;padding:1rem;background:var(--surface);border-radius:.5rem;margin-top:1rem}label{display:grid;gap:.35rem}label.check{display:flex;align-items:center}input,select,textarea{font:inherit;padding:.5rem;min-width:0}button,.button{display:inline-block;background:var(--accent);color:#101827;border:0;border-radius:.4rem;padding:.65rem 1rem;font:inherit;cursor:pointer;text-decoration:none;width:max-content}footer{grid-column:1/-1;padding:1rem;color:var(--muted);border-top:1px solid var(--line)}@media(max-width:700px){body{display:block}.side{border-right:0;border-bottom:1px solid var(--line)}.side ul{display:flex;overflow-x:auto;gap:.35rem}.side a{white-space:nowrap}.table-wrap{overflow-x:auto}dl{grid-template-columns:1fr}}`;
}
