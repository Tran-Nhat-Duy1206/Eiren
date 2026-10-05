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
  it('links each manageable guild directly to its protected overview page', () => {
    const picker = renderGuildPicker([{ id: '123456789012345678', name: 'Development' }, { id: '987654321098765432', name: 'Other' }]);
    expect(picker).toContain('href="/g/123456789012345678/overview"');
    expect(picker).toContain('href="/g/987654321098765432/overview"');
    expect(picker).not.toMatch(/href="\/g\/\d{17,20}"/);
    const encoded = renderGuildPicker([{ id: `x" onclick="bad()`, name: 'Hostile' }]);
    expect(encoded).toContain('href="/g/x%22%20onclick%3D%22bad()/overview"');
    expect(encoded).not.toMatch(/\sonclick=/i);
  });
  it('links exactly to supported route keys and renders object read models', () => {
    for (const route of routes) {
      const html = renderPage({ ...base, page: route, analyticsEnabled: true, data: route === 'analytics' ? { timezone: 'UTC', totals: { messages: 137, voiceSeconds: 180 }, currentMemberCount: 42, channels: [{ channelId: '123', messages: 137, voiceSeconds: 180 }] } : { settings: { timezone: 'UTC', secretToken: 'PRIVATE' }, items: [{ label: 'Visible', transcript: 'PRIVATE', reportBody: 'PRIVATE' }] } });
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
    expect(css).toMatch(/@media\(max-width:48rem\)/);
    expect(css).toMatch(/overflow-x:auto/);
    expect(css).toMatch(/focus-visible/);
    expect(css).toContain('textarea:focus-visible');
    expect(css).toContain('input,select,textarea{');
    expect(renderLogin()).toContain('href="#main"');
  });
});

import { renderAutomationDashboard, type AutomationDashboardView } from './automation-ui.js';

const bad = `<img src=x onerror="boom">@everyone & 'hello'`;
const now = new Date('2026-01-02T03:04:05Z');
const data: AutomationDashboardView = {
  moduleEnabled: false,
  channels: [{ id: '1', name: bad }],
  rules: [{ id: 4, name: bad, enabled: true, triggerKey: 'SCHEDULED', triggerConfig: { kind: 'daily', time: '09:00', timezone: 'UTC' }, timezone: 'UTC', nextRunAt: now, configVersion: 2, updatedAt: now, actionKeys: ['STATIC_MESSAGE', 'STAFF_LOG'] }],
  selected: { id: 4, name: bad, enabled: true, triggerKey: 'DAILY', triggerVersion: 1, triggerConfig: { kind: 'daily', time: '09:00', timezone: 'UTC' }, timezone: 'UTC', cooldownSeconds: 5, nextRunAt: now, configVersion: 2, authorizedBy: bad, updatedAt: now, actions: [{ position: 0, actionKey: 'STATIC_MESSAGE', actionVersion: 1, config: { channelId: '1', message: bad } }, { position: 1, actionKey: 'STAFF_LOG', actionVersion: 1, config: { channelId: 'missing', message: bad } }] },
  executions: [{ id: 'e1', automationId: 4, automationName: bad, triggerKey: 'DAILY', status: 'UNCERTAIN', attempts: 1, createdAt: now, completedAt: null, safeErrorCode: 'UNKNOWN', configVersion: 2, moduleEpoch: 1 }],
  selectedExecution: { id: 'e1', automationId: 4, automationName: bad, triggerKey: 'DAILY', status: 'UNCERTAIN', attempts: 1, createdAt: now, completedAt: null, safeErrorCode: 'UNKNOWN', configVersion: 2, moduleEpoch: 1, actions: [{ position: 0, actionKey: 'STATIC_MESSAGE', actionVersion: 1, status: 'UNCERTAIN', attempts: 1, discordMessageId: null, safeErrorCode: 'UNKNOWN', updatedAt: now, reconciliationResult: null, reconciledBy: null, reconciledAt: null }], reconciliation: [{ position: 0, allowSent: true, allowNotSent: false }] },
};

describe('automation dashboard', () => {
  it('escapes names, channels, messages and renders selected two-action state', () => {
    const html = renderAutomationDashboard({ guildId: '123', csrfToken: bad, data });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="boom"');
    expect(html).toContain('&lt;img');
    expect(html).toContain('@everyone');
    expect(html).toContain('name="action0ChannelId"');
    expect(html).toContain('value="1" selected');
    expect(html).toContain('name="action1Type"');
    expect(html).toContain('value="STAFF_LOG" selected');
    expect(html).toContain('name="action1ChannelId"');
    expect(html).toContain('value="missing" selected');
    expect(html).toContain('maxlength="1000"');
    expect(html).toContain('name="scheduleKind"');
    expect(html).toContain('value="daily" selected');
    expect(html).toContain('2026-01-02T03:04:05.000Z');
    expect(html).toContain('Authorized by:');
    expect(html).toContain('Automation module: Disabled');
    expect(html).toContain('Daily 09:00 UTC');
    expect(html).toContain('value="09:00"');
    expect(html).toContain('value="missing" selected disabled');
  });
  it('prepopulates a one-time UTC schedule and defaults new rules to disabled', () => {
    const once = { ...data, selected: { ...data.selected!, triggerConfig: { kind: 'once', at: '2027-01-01T00:00:00.000Z' } } };
    const edit = renderAutomationDashboard({ guildId: '123', csrfToken: 'csrf', data: once });
    expect(edit).toContain('value="once" selected');
    expect(edit).toContain('value="2027-01-01T00:00:00.000Z"');
    expect(edit).toContain('Once 2027-01-01T00:00:00.000Z UTC');
    const create = renderAutomationDashboard({ guildId: '123', csrfToken: 'csrf', data: { ...data, selected: null } });
    expect(create).toContain('value="false" selected>No');
  });
  it('keeps all Discord-sized eligible channel options available without stale selections', () => {
    const channels = Array.from({ length: 101 }, (_, index) => ({ id: String(index + 1), name: `channel-${index + 1}` }));
    const html = renderAutomationDashboard({ guildId: '123', csrfToken: 'csrf', data: { ...data, channels, selected: null } });
    expect(html).toContain('<option value="101">#channel-101</option>');
  });
  it('shows exact POST actions, CSRF and confirmations without retry controls', () => {
    const html = renderAutomationDashboard({ guildId: '123', csrfToken: 'csrf', data });
    for (const action of ['automation-update', 'automation-disable', 'automation-delete', 'automation-reconcile-sent', 'automation-module-toggle']) {
      expect(html).toContain(`/action/${action}`);
    }
    expect(html).not.toContain('/action/automation-reconcile-not-sent');
    expect(html).toContain('name="automationId" value="4"');
    expect(html).toContain('name="executionId" value="e1"');
    expect(html).toContain('name="position" value="0"');
    expect(html).toContain('name="confirm" value="yes" required');
    expect(html).toContain('name="module" value="automation"');
    expect(html).toContain('name="csrfToken" value="csrf"');
    expect(html).toContain('The bot cannot determine whether Discord accepted this message. It will not resend automatically.');
    expect(html).not.toMatch(/<(?:button|a)\b[^>]*>[^<]*(?:Run now|Retry|Test send)/i);
    expect(html).not.toMatch(/action="[^"]*(?:retry|run-now|test-send)/i);
    expect(html).toContain('Do not blindly retry; inspect and reconcile.');
  });
  it('shows create inputs and gates navigation and content by ADMIN', () => {
    const create = renderAutomationDashboard({ guildId: '123', csrfToken: 'csrf', data: { ...data, selected: null, selectedExecution: null } });
    expect(create).toContain('/action/automation-create');
    for (const field of ['name', 'scheduleKind', 'dailyTime', 'onceAt', 'timezone', 'cooldownSeconds', 'enabled', 'action0Type', 'action0ChannelId', 'action0Message', 'action1Type', 'action1ChannelId', 'action1Message']) expect(create).toContain(`name="${field}"`);
    const member = renderPage({ page: 'overview', guildId: '123', guildName: 'Guild', csrfToken: 'csrf', actorLevel: 'MEMBER' });
    expect(member).not.toContain('/automations');
    const admin = renderPage({ page: 'automations', guildId: '123', guildName: 'Guild', csrfToken: 'csrf', actorLevel: 'ADMIN', data });
    expect(admin).toContain('href="/g/123/automations" aria-current="page"');
    expect(admin).toContain('/action/automation-update');
    expect(renderPage({ page: 'automations', guildId: '123', guildName: 'Guild', csrfToken: 'csrf', actorLevel: 'MEMBER', data })).not.toContain('/action/automation-update');
  });
});
