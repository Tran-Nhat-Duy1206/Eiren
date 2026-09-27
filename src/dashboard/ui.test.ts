import { describe, expect, it } from 'vitest';
import { dashboardCss, escapeHtml, renderGuildPicker, renderLogin, renderPage } from './ui.js';

const hostile = `<script>alert('x')</script><img src=x onerror="alert(1)">`;
const base = { page: 'overview', guildId: '123', guildName: 'Example', csrfToken: 'csrf' };
const routes = ['overview', 'moderation', 'members', 'roles', 'tickets', 'suggestions', 'levels', 'events', 'giveaways', 'analytics', 'settings'];

describe('dashboard server-rendered UI', () => {
  it('escapes text, attributes and URLs without scripts or inline styles', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml(null)).toBe('');
    const pages = [renderLogin(hostile), renderGuildPicker([{ id: `x" onclick="bad()`, name: hostile }], hostile), renderPage({ ...base, guildId: `x" onclick="bad()`, guildName: hostile, csrfToken: hostile, notice: hostile, actorLevel: hostile, data: [{ title: hostile, prize: hostile, displayName: hostile }] })];
    for (const html of pages) {
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).not.toMatch(/\son(?:error|click)="/i);
      expect(html).not.toMatch(/<style\b|\sstyle=|javascript:/i);
      expect(html).toContain('<link rel="stylesheet" href="/assets/dashboard.css">');
    }
    expect(pages[2]).toContain('&lt;script&gt;');
    expect(pages[1]).toContain('%22%20onclick%3D%22');
    const suggestion = renderPage({ ...base, page: 'suggestions', data: [{ id: 1, content: hostile, upvotes: 2 }] });
    expect(suggestion).toContain('&lt;script&gt;');
    expect(suggestion).not.toContain('<script>');
    for (const page of ['events', 'giveaways', 'members']) {
      const rendered = renderPage({ ...base, page, data: [{ title: hostile, prize: hostile, username: hostile }] });
      expect(rendered).toContain('&lt;script&gt;');
      expect(rendered).not.toContain('<img');
    }
  });
  it('links exactly to supported route keys and renders object read models', () => {
    for (const route of routes) {
      const html = renderPage({ ...base, page: route, analyticsEnabled: true, data: { settings: { timezone: 'UTC', secretToken: 'PRIVATE' }, items: [{ label: 'Visible', transcript: 'PRIVATE', reportBody: 'PRIVATE' }] } });
      expect(html).toContain(`href="/g/123/${route}" aria-current="page"`);
      expect(html).toContain('aria-label="Dashboard"');
      expect(html).not.toContain('PRIVATE');
      expect(html).toContain('UTC');
      expect(html).toContain('<caption>Read-only summary');
    }
    expect(renderPage(base)).toContain('href="/g/123/settings"');
    expect(renderPage(base)).not.toContain('/bot-settings');
  });
  it('renders forms with exact action names, CSRF, role gating and destructive confirmation', () => {
    const cases = [
      ['settings', 'ADMIN', ['module-toggle', 'guild-timezone']],
      ['moderation', 'MODERATOR', ['moderation-warn']],
      ['tickets', 'MODERATOR', ['ticket-close']],
      ['suggestions', 'MODERATOR', ['suggestion-status']],
      ['levels', 'ADMIN', ['levels-config']],
      ['events', 'MODERATOR', ['event-cancel']],
      ['giveaways', 'MODERATOR', ['giveaway-end']],
      ['analytics', 'ADMIN', ['analytics-toggle', 'analytics-retention']],
      ['roles', 'GUILD_OWNER', ['role-set', 'role-remove']],
    ] as const;
    for (const [page, actorLevel, actions] of cases) {
      const html = renderPage({ ...base, page, actorLevel });
      for (const action of actions) expect(html).toContain(`action="/g/123/action/${action}"`);
      expect(html).toContain('name="csrfToken" value="csrf"');
      for (const action of actions) expect(renderPage({ ...base, page, actorLevel: 'MEMBER' })).not.toContain(`/action/${action}`);
    }
    for (const page of ['settings', 'tickets', 'events', 'giveaways', 'analytics', 'roles']) expect(renderPage({ ...base, page, actorLevel: 'BOT_OWNER' })).toContain('name="confirm" value="yes" required');
    expect(renderPage({ ...base, page: 'suggestions', actorLevel: 'MODERATOR' })).toContain('value="UNDER_REVIEW"');
    expect(renderPage({ ...base, page: 'suggestions', actorLevel: 'MODERATOR' })).toContain('value="ACCEPTED"');
    expect(renderPage({ ...base, page: 'roles', actorLevel: 'ADMIN' })).not.toContain('/action/role-set');
  });
  it('provides member lookup, analytics range, logout and safe disabled states', () => {
    expect(renderPage({ ...base, page: 'members', userId: hostile })).toContain('action="/g/123/members"');
    expect(renderPage({ ...base, page: 'members', userId: hostile })).toContain('name="userId"');
    const analytics = renderPage({ ...base, page: 'analytics', actorLevel: 'ADMIN' });
    expect(analytics).toContain('Analytics is disabled');
    expect(analytics).toContain('name="range"');
    for (const range of ['24h', '7d', '30d', '90d']) expect(analytics).toContain(`value="${range}"`);
    expect(renderPage({ ...base, page: 'Unknown' })).toContain('Page unavailable');
    expect(renderGuildPicker([], 'csrf')).toContain('action="/logout"');
    expect(renderPage(base)).toContain('action="/logout"');
    const disabled = renderPage({ ...base, page: 'tickets', actorLevel: 'ADMIN', disabledModule: 'tickets' });
    expect(disabled).toContain('tickets is disabled');
    expect(disabled).not.toContain('/action/ticket-close');
    expect(renderLogin()).not.toContain('action="/logout"');
  });
  it('bounds output and supports mobile keyboard navigation', () => {
    expect(renderPage({ ...base, data: Array.from({ length: 100 }, (_, i) => ({ label: hostile.repeat(10), index: i })) }).length).toBeLessThan(200_000);
    const css = dashboardCss();
    expect(css).toMatch(/@media\(max-width:700px\)/);
    expect(css).toMatch(/overflow-x:auto/);
    expect(css).toMatch(/focus-visible/);
    expect(renderLogin()).toContain('href="#main"');
  });
});
