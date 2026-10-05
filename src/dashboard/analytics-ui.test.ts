import { describe, expect, it } from 'vitest';
import { renderAnalyticsDashboard } from './analytics-ui.js';
import { renderPage, dashboardCss } from './ui.js';
import { dashboardTheme } from './theme.js';
const base = { guildId: 'x/y', csrfToken: 'csrf<&', analyticsEnabled: true, showSettings: true };
const data = { currentMemberCount: 42, timezone: 'Europe/London', since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-01-08T00:00:00Z'), totals: { messages: 137, voiceSeconds: 179, joins: 0, leaves: 3, net: -3 }, channels: [{ channelId: 'c<&', messages: 89, voiceSeconds: 17 }], trend: [], commands: [], voiceChannels: [], localDays: [], business: { tickets: 0 }, details: { tickets: { opened: 0, averageResolutionSeconds: null }, moderation: { actions: { WARN: 0 }, daily: [] } } };
describe('dedicated analytics SSR', () => {
  it('maps authoritative metrics and UTC channel rows without synthetic counts', () => {
    const html = renderAnalyticsDashboard({ ...base, data });
    for (const text of ['<dd>137</dd>', '<dd>42</dd>', '<dd>2</dd>', '<dd>1</dd>', 'Current server members', 'Channels shown (up to 10)', 'Whole minutes', 'Channel ID', 'Voice (seconds)', '2026-01-01T00:00:00.000Z UTC', 'Europe/London', 'c&lt;&amp;']) expect(html).toContain(text);
    expect(html).not.toContain('Observed members');
    const disclosureAt = html.indexOf('<details class="analytics-additional">');
    expect(html.indexOf('Since (UTC)')).toBeGreaterThan(disclosureAt);
    expect(html.indexOf('Until (UTC)')).toBeGreaterThan(disclosureAt);
    expect(html).toContain('Selected range; timestamps UTC. Configured timezone: Europe/London (display label only).');
    expect(html).not.toContain('<th scope="col">Status');
    expect(html.indexOf('<h1>Analytics')).toBeLessThan(html.indexOf('analytics-metrics'));
    expect(html.indexOf('<h2>Channel activity')).toBeLessThan(html.indexOf('<h2>Analytics settings'));
  });
  it('uses stable GET ranges, defaults to backend seven days and requires explicit submit', () => {
    for (const range of ['24h', '7d', '30d', '90d']) expect(renderAnalyticsDashboard({ ...base, range })).toContain(`value="${range}" selected`);
    const html = renderAnalyticsDashboard(base);
    expect(html).toContain('value="7d" selected');
    expect(html).toContain('method="get" action="/g/x%2Fy/analytics"');
    expect(html).toContain('>Show range</button>');
    expect(html).not.toMatch(/<script|onchange=|<img|<iframe|style=/);
  });
  it('retains missing/nonfinite states without fabricating zeros and accepts explicit zero', () => {
    const html = renderAnalyticsDashboard({ ...base, data: { currentMemberCount: 42, totals: { messages: -1, voiceSeconds: Infinity } } });
    expect(html.match(/<dd>—<\/dd>/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('<dd>0</dd>');
    const zero = renderAnalyticsDashboard({ ...base, data: { totals: { messages: 0, voiceSeconds: 0 }, currentMemberCount: 0, channels: [] } });
    expect(zero.split('</dl>')[0]!.match(/<dd>0<\/dd>/g)?.length).toBe(4);
    expect(zero).toContain('No analytics records for this range.');
  });
  it('bounds channels and additional source aggregates with zero and unknown preserved', () => {
    const html = renderAnalyticsDashboard({ ...base, data: { ...data, trend: Array.from({ length: 101 }, (_, i) => ({ bucketStart: data.since, messages: `hour-${i}` })), channels: Array.from({ length: 11 }, (_, i) => ({ channelId: `channel-${i}`, messages: i, voiceSeconds: 0 })) } });
    expect(html).toContain('channel-9'); expect(html).not.toContain('channel-10');
    expect(html).toContain('hour-99'); expect(html).not.toContain('hour-100');
    for (const text of ['Additional recorded analytics', 'Hourly trend', 'Voice channels', 'Commands', 'Business aggregates', 'Detail aggregates', 'Local days', 'WARN', 'averageResolutionSeconds', '<dd>0</dd>', '<dd>—</dd>']) expect(html).toContain(text);
  });
  it('gates settings explicitly and discards disabled historical metrics while allowing reenable', () => {
    const html = renderAnalyticsDashboard({ ...base, data, analyticsEnabled: false });
    expect(html).toContain('Analytics is disabled for this server. Historical data may still exist.');
    expect(html).not.toContain('<dd>137</dd>');
    expect(html).toContain('value="false" selected');
    expect(renderAnalyticsDashboard({ ...base, showSettings: false })).not.toContain('/action/');
    const input = { page: 'analytics', guildId: '123', guildName: 'Guild', csrfToken: 'csrf', analyticsEnabled: true, data };
    expect(renderPage({ ...input, actorLevel: 'HELPER' })).not.toContain('/action/analytics');
    expect(renderPage({ ...input, actorLevel: 'ADMIN' })).toContain('/action/analytics-toggle');
    expect(renderPage({ ...input, actorLevel: 'ADMIN', disabledModule: 'analytics' })).not.toContain('/action/analytics');
  });
  it('preserves POST policies, CSRF, confirmation and blank bounded retention', () => {
    const html = renderAnalyticsDashboard({ ...base, data });
    for (const action of ['analytics-toggle', 'analytics-retention']) expect(html).toContain(`/g/x%2Fy/action/${action}`);
    expect(html.match(/name="csrfToken" value="csrf&lt;&amp;"/g)?.length).toBe(2);
    expect(html.match(/name="confirm" value="yes" required/g)?.length).toBe(2);
    expect(html).toContain('class="btn-primary" type="submit">Set analytics availability');
    expect(html).toContain('class="btn-danger" type="submit">Set analytics retention');
    expect(html).toContain('min="30" max="730" step="1"');
    expect(html).not.toMatch(/name="days"[^>]*value=/);
    expect(html).toContain('Whole days within the existing permitted range.');
  });
  it('escapes notices and whitelisted fields without serializing unknown objects or errors', () => {
    const hostile = '<script>bad</script>';
    const unknown = { toString: () => { throw new Error('coercion'); } };
    const html = renderAnalyticsDashboard({ ...base, notice: hostile, data: { ...data, timezone: hostile, business: { tickets: new Error('SECRET') }, channels: [{ channelId: unknown, messages: hostile, voiceSeconds: new Error('SECRET') }], details: { moderation: { actions: new Error('SECRET') } } } });
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('SECRET'); expect(html).not.toContain('[object Object]');
  });
  it('keeps the primary caption accessible while leaving aggregate captions visible', () => {
    const html = renderAnalyticsDashboard({ ...base, data: { ...data, commands: [{ commandName: 'help', invocations: 1, errors: 0, totalDurationMs: 2 }] } });
    const caption = 'Read-only summary: Channel activity (up to 10 records; UTC window)';
    expect(html).toContain(`role="region" aria-label="${caption}" tabindex="0"><table><caption>${caption}</caption>`);
    expect(html).toContain('<caption>Commands (up to 10)</caption>');
    const added = dashboardCss().slice(dashboardTheme.length);
    expect(added).toContain('.analytics-channel-card > .table-wrap caption{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap;border:0}');
    expect(added).not.toMatch(/caption\{[^}]*display:none|caption\{[^}]*visibility:hidden/);
  });
  it('scopes quiet polish and preserves natural six-row settings and shared focus', () => {
    const added = dashboardCss().slice(dashboardTheme.length);
    for (const rule of added.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)) {
      const selector = rule[1]!.trim();
      if (selector.startsWith('@media') || selector.startsWith('@supports')) continue;
      for (const part of selector.split(',')) expect(part.trim()).toMatch(/^(?:\.analytics-|body:has\(\.analytics-page\))/);
    }
    expect(added).toContain('grid-template-rows:auto auto auto minmax(0,1fr) auto auto');
    for (const [selector, row] of [['.analytics-settings-heading', 1], ['p', 2], ['label:not(.analytics-confirm)', 3], ['small', 4], ['.analytics-confirm', 5]] as const) expect(added).toContain(`.analytics-settings-card>${selector}{grid-row:${row}}`);
    expect(added).toContain('.analytics-settings-card>button{grid-row:6;justify-self:start}');
    expect(added).toContain('.analytics-settings-card>input[type=hidden]{display:none}');
    expect(added).toContain('grid-template-rows:auto auto auto auto auto auto');
    expect(added).toContain('@supports(grid-template-rows:subgrid){\n@media(min-width:769px){.analytics-settings-grid{grid-template-rows:repeat(6,auto);row-gap:10px}');
    expect(added).toContain('.analytics-settings-card{grid-row:1 / span 6;grid-template-rows:subgrid}');
    expect(added).toContain('min-height:136px');
    expect(added).toContain('gap:6px;font-size:13px;color:var(--muted)');
    expect(added).toContain('body:has(.analytics-page){background:radial-gradient(ellipse at 85% 0%,#7c3aed14');
    expect(added).not.toMatch(/outline:|--focus:|animation:|filter:|glow-purple-strong|url\(/);
    expect(dashboardTheme).toContain('outline:3px solid var(--focus)');
    expect(dashboardTheme).toContain('@media(prefers-reduced-motion:reduce)');
  });
  it('keeps old CSS byte-identical as a prefix and scopes responsive additions', () => {
    const css = dashboardCss(); expect(css.startsWith(dashboardTheme)).toBe(true);
    const added = css.slice(dashboardTheme.length);
    for (const value of ['repeat(4,minmax(0,1fr))', 'repeat(2,minmax(0,1fr))', '@media(max-width:768px)', '@media(max-width:430px)', 'min-height:44px', 'overflow-x:auto', 'width:42px;height:3px', 'border-radius:14px']) expect(added).toContain(value);
    expect(added).not.toContain(':root');
    expect(added).toContain('.analytics-page .analytics-metrics{');
    expect(added).toContain('.analytics-page .analytics-metadata{');
    expect(added).not.toContain('summary:focus-visible');
    expect(renderAnalyticsDashboard(base)).toContain('See activity at a glance, then manage collection and retention without losing context.');
    expect(renderAnalyticsDashboard({ ...base, data })).toContain('A compact view of where message activity was observed in the selected range.');
  });
});
