import { describe, it, expect } from 'vitest';
import { escapeHtml, statusBadge, notice, emptyState, panel, metadataList, tableShell, fieldHelp, formGroup, destructiveWarning, pageHeader, utc } from './presentation.js';
import { renderPage, renderLogin, renderGuildPicker, dashboardCss } from './ui.js';
const attack = '<img src=x onerror="alert(1)">&\'"';
const base = { guildId: '900000000000000001', guildName: attack, csrfToken: 'synthetic-csrf', actorLevel: 'GUILD_OWNER' };
describe('V8.5 shared SSR presentation', () => {
  it('escapes every text/data slot without serializing unknown errors', () => {
    const outputs = [statusBadge(attack), notice(attack, 'INFO', attack), emptyState(attack, attack), panel(attack, '<p>trusted generated body</p>'), metadataList([[attack, attack]]), tableShell(attack, [attack], [[attack]]), fieldHelp('help', attack), formGroup(attack, '<input name="safe">'), destructiveWarning(attack), pageHeader(attack, attack)];
    for (const html of outputs) { expect(html).not.toContain('<img'); expect(html).toContain('&lt;img'); }
    expect(escapeHtml(new Error('PRIVATE DRIVER TEXT'))).toBe('—');
    expect(statusBadge(new Error('PRIVATE DRIVER TEXT'))).not.toContain('PRIVATE');
    expect(metadataList([['ID', attack]])).toContain('&quot;');
  });
  it('covers all canonical labels with text and distinct semantic states', () => {
    const labels = ['Enabled', 'Disabled', 'Active', 'Pending', 'Running', 'Succeeded', 'Failed', 'Skipped', 'Uncertain', 'Closed', 'Open', 'Under Review', 'Accepted', 'Rejected', 'Implemented'];
    for (const label of labels) expect(statusBadge(label)).toContain(`>${label}</span>`);
    expect(statusBadge('UNCERTAIN')).toContain('status-warning'); expect(statusBadge('FAILED')).toContain('status-danger');
    expect(statusBadge(false)).toContain('status-neutral'); expect(statusBadge('PENDING')).toContain('status-warning'); expect(statusBadge('RUNNING')).toContain('status-info');
    expect(statusBadge('NOT_TRACKED')).not.toContain('status-success'); expect(statusBadge('UNAVAILABLE')).not.toContain('status-success');
  });
  it('uses accessible notices, UTC dates and named focusable table regions', () => {
    expect(notice('Saved')).toContain('role="status"'); expect(notice('Safe request error', 'DANGER')).toContain('role="alert"');
    expect(utc(new Date(1767225600123))).toBe('2026-01-01T00:00:00.123Z UTC');
    const html = tableShell('Case metadata', ['Case ID', 'Status'], [['12345678901234567890', 'ACTIVE']], { statusColumns: [1], idColumns: [0] });
    expect(html).toContain('tabindex="0"'); expect(html).toContain('<caption>Case metadata</caption>'); expect(html).toContain('scope="col"'); expect(html).toContain('id-value'); expect(html).toContain('>Active</span>');
  });
  it('renders public pages with one main, escaped server names and contextual empty states', () => {
    for (const html of [renderLogin(), renderLogin(attack), renderGuildPicker([{ id: '900000000000000001', name: attack }]), renderGuildPicker([])]) {
      expect(html.match(/<main\b/g)).toHaveLength(1); expect(html).toContain('href="#main"'); expect(html).toContain('id="main"'); expect(html).not.toContain('<script'); expect(html).not.toContain('<img'); expect(html).not.toMatch(/\son(?:click|change)=/i);
    }
    expect(renderGuildPicker([])).toContain('No manageable servers'); expect(renderLogin(attack)).toContain('role="alert"');
  });
  it('adopts all ordinary pages with grouped current navigation and wrapping labels', () => {
    const pages = ['overview','moderation','members','roles','tickets','suggestions','levels','events','giveaways','analytics','settings'];
    for (const page of pages) {
      const html = renderPage({ ...base, page, data: [], analyticsEnabled: true });
      expect(html.match(/<main\b/g)).toHaveLength(1); expect(html.match(/<h1\b/g)).toHaveLength(1); expect(html).toContain(`href="/g/${base.guildId}/${page}" aria-current="page"`); expect(html).toContain('Navigation groups'); expect(html).toContain('Governance'); expect(html).not.toContain('<img'); expect(html).not.toContain('<script');
      const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)];
      for (const [, form] of forms) for (const control of form!.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
        if (/type="hidden"/.test(control[2]!)) continue;
        const at = form!.indexOf(control[0]); expect(form!.lastIndexOf('<label', at)).toBeGreaterThan(form!.lastIndexOf('</label>', at));
      }
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); expect(new Set(ids).size).toBe(ids.length);
      for (const [, id] of html.matchAll(/aria-describedby="([^"]+)"/g)) expect(ids).toContain(id);
    }
  });
  it('preserves access gates, confirmation constraints and full authorized summary text', () => {
    const member = renderPage({ ...base, actorLevel:'MEMBER', page:'overview', data:[] }); expect(member).not.toContain('/operations'); expect(member).not.toContain('/privacy'); expect(member).not.toContain('/data-retention'); expect(member).not.toContain('/automations');
    const admin = renderPage({ ...base, actorLevel:'ADMIN', page:'roles', data:[] }); expect(admin).not.toContain('/action/role-set');
    const owner = renderPage({ ...base, page:'roles', data:[] }); expect(owner).toContain('/action/role-remove'); expect(owner).toContain('btn-danger'); expect(owner).toContain('name="confirm" value="yes" required');
    const long = 'Authorized public suggestion '.repeat(30); expect(renderPage({ ...base, page:'suggestions', items:[{id:42, status:'PENDING', content:long}] })).toContain(long);
    expect(renderPage({ ...base, page:'moderation', items:[{id:42, reportText:'PRIVATE', transcript:'PRIVATE', reason:'Authorized reason'}] })).not.toContain('PRIVATE');
    expect(renderPage({ ...base, page:'settings', disabledModule:'settings', data:[] })).toContain('Historical data may still exist');
  });
  it('defines implementation tokens and explicit responsive form/nav/table/action rules without remote assets', () => {
    const css = dashboardCss(); for (const token of ['bg','surface','surface-raised','surface-muted','text','text-muted','border','border-strong','accent','focus','success','warning','danger','info','neutral','space-1','space-2','space-3','space-4','space-5','space-6','space-8']) expect(css).toContain(`--${token}:`);
    for (const part of ['@media(max-width:64rem)','@media(max-width:48rem)','@media(max-width:27rem)','overflow-x:auto','min-height:44px','.action-group','form{max-width:100%','focus-visible']) expect(css).toContain(part);
    expect(css).not.toMatch(/url\(|@import|https?:/i);
  });
  it('shows six existing overview counts without inventing new data or trends', () => {
    const counts = {activeCases:1, openReports:2, openTickets:3,pendingSuggestions:4,scheduledEvents:5,activeGiveaways:6}; const html = renderPage({...base,page:'overview',data:{counts,settings:{timezone:'UTC'},modules:[]}});
    expect(html).toContain('metric-grid'); for (const count of Object.values(counts)) expect(html).toContain(`>${count}</dd>`); expect(html).not.toContain('Trend +');
  });
});
