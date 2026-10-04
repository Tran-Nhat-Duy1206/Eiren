import { describe, expect, it, vi } from 'vitest';
import { createDashboardServer } from './web.js';
import { brandMark } from './brand.js';
import { AppError } from '../core/errors/errors.js';

const guildId = '123456789012345678';
const token = 'a'.repeat(64);
const origin = 'https://dashboard.example';
function fixture() {
  const authorize = vi.fn(async (id: string, _session?: unknown, _level?: string) => { if (id !== guildId) throw new AppError('PERMISSION', 'Guild inaccessible.'); return { guildId: id, userId: guildId, guildOwnerId: guildId, roleIds: [] }; });
  const listAccessible = vi.fn(async () => [{ id: guildId, name: '<img src=x>' }]);
  const setEnabled = vi.fn(async () => undefined);
  const audit = vi.fn(async () => undefined);
  const auth = { startOAuth: vi.fn(() => ({ authorizationUrl: 'https://discord.com/authorize', stateCookie: { name: 'dashboard_oauth_state', value: 'state', options: { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: true, maxAge: 600 } } })), completeOAuth: vi.fn(), clearStateCookie: () => ({ name: 'dashboard_oauth_state', value: '', options: { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: true, maxAge: 0 } }), clearSessionCookie: () => ({ name: 'dashboard_session', value: '', options: { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: true, maxAge: 0 } }), getSession: vi.fn(async (raw: string) => raw === token ? { userId: guildId, oauthGuildIds: [guildId], displayName: null, createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 86400000), absoluteExpiresAt: new Date(Date.now() + 86400000) } : null), revokeSession: vi.fn(), csrfToken: vi.fn(() => 'csrf'), verifyCsrf: vi.fn((raw: string, submitted: string) => raw === token && submitted === 'csrf') };
  const mutations = { warn: vi.fn(async () => undefined), close: vi.fn(async () => undefined), status: vi.fn(async () => undefined), configureLevels: vi.fn(async () => undefined), transition: vi.fn(async () => undefined), end: vi.fn(async () => undefined), setEnabled, retention: vi.fn(async () => undefined), setRole: vi.fn(async () => undefined) };
  const services = { modules: { setEnabled, isEnabled: vi.fn(async () => true) }, guildConfig: { get: vi.fn(async () => ({ timezone: 'UTC' })), update: vi.fn() }, permissions: { resolve: vi.fn(async () => 'GUILD_OWNER'), setRole: mutations.setRole }, moderation: { perform: mutations.warn }, tickets: { close: mutations.close }, suggestions: { status: mutations.status }, levels: { configure: mutations.configureLevels }, events: { transition: mutations.transition }, giveaways: { end: mutations.end }, repository: {} };
  const read = { overview: vi.fn(async () => [{ name: '<script>alert(1)</script>' }]) };
  const roleId = '234567890123456789';
  const guild = { id: guildId, name: 'Example', memberCount: 42, roles: { fetch: vi.fn(async () => ({ id: roleId, managed: false, editable: true, permissions: { any: vi.fn(() => false) } })) } };
  const gateway = { warn: vi.fn() };
  const deps = { client: { guilds: { fetch: vi.fn(async () => guild) } } as never, services: services as never, auth: auth as never, access: { authorize, listAccessible } as never, read: read as never, audit: { record: audit }, analytics: { configure: mutations.retention, summary: vi.fn(async () => ({})) }, moderationGatewayForGuild: vi.fn(async () => gateway as never), secureCookies: true, baseUrl: origin };
  return { deps, authorize, listAccessible, setEnabled, audit, auth, read, mutations, services, roleId, gateway, guild };
}
const cookie = { cookie: `dashboard_session=${token}`, host: 'dashboard.example', origin };
describe('dashboard HTTP boundary', () => {
  it('returns a secret-free health response and external stylesheet with restrictive CSP', async () => { const { deps } = fixture(); const app = await createDashboardServer(deps); const health = await app.inject('/healthz'); expect(health.json()).toEqual({ status: 'ok' }); const html = await app.inject('/login'); expect(html.headers['content-security-policy']).toContain("script-src 'none'"); expect(html.body).toContain('/assets/dashboard.css'); await app.close(); });
  it('opens a guild picker link through the protected overview route without granting foreign guilds', async () => {
    const { deps, authorize, listAccessible } = fixture();
    const app = await createDashboardServer(deps);
    expect((await app.inject('/guilds')).statusCode).toBe(302);
    const picker = await app.inject({ url: '/guilds', headers: cookie });
    expect(picker.statusCode).toBe(200);
    const destination = picker.body.match(/href="(\/g\/\d{17,20}\/overview)"/)?.[1];
    expect(destination).toBe(`/g/${guildId}/overview`);
    expect((await app.inject(destination!)).statusCode).toBe(302);
    expect((await app.inject({ url: destination!, headers: cookie })).statusCode).toBe(200);
    expect(authorize).toHaveBeenCalledWith(guildId, expect.any(Object), 'HELPER');
    const foreign = '999999999999999999';
    listAccessible.mockResolvedValueOnce([{ id: foreign, name: 'Forged' }]);
    const forgedPicker = await app.inject({ url: '/guilds', headers: cookie });
    expect(forgedPicker.body).toContain(`/g/${foreign}/overview`);
    expect((await app.inject({ url: `/g/${foreign}/overview`, headers: cookie })).statusCode).toBe(403);
    expect(authorize).toHaveBeenCalledWith(foreign, expect.any(Object), 'HELPER');
    await app.close();
  });
  it('requires authentication and current guild authorization on every read, escaping HTML', async () => { const { deps, authorize } = fixture(); const app = await createDashboardServer(deps); expect((await app.inject(`/g/${guildId}/overview`)).statusCode).toBe(302); const response = await app.inject({ method: 'GET', url: `/g/${guildId}/overview`, headers: cookie }); expect(response.statusCode).toBe(200); expect(response.body).toContain('&lt;script&gt;'); expect(response.body).not.toContain('<script>'); expect(authorize).toHaveBeenCalledWith(guildId, expect.objectContaining({ userId: guildId, oauthGuildIds: [guildId] }), 'HELPER'); expect((await app.inject({ url: '/g/999999999999999999/overview', headers: cookie })).statusCode).toBe(403); await app.close(); });
  it('shows bounded analytics and the REST guild member count with selected IANA timezone', async () => {
    const { deps, authorize } = fixture();
    const app = await createDashboardServer(deps);
    const response = await app.inject({ url: `/g/${guildId}/analytics?range=24h`, headers: cookie });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('42');
    expect(deps.analytics.summary).toHaveBeenCalledWith(guildId, '24h', 'UTC');
    expect(authorize).toHaveBeenCalledWith(guildId, expect.any(Object), 'HELPER');
    expect((await app.inject({ url: `/g/${guildId}/analytics?range=365d`, headers: cookie })).statusCode).toBe(400);
    await app.close();
  });
  it('blocks CSRF and cross-origin mutation, uses the injected domain service and audits success', async () => { const { deps, setEnabled, audit } = fixture(); const app = await createDashboardServer(deps); const url = `/g/${guildId}/action/module-toggle`; const payload = { csrfToken: 'csrf', module: 'tickets', enabled: 'true', confirm: 'yes' }; expect((await app.inject({ method: 'POST', url, headers: { ...cookie, origin: 'https://evil.example' }, payload })).statusCode).toBe(403); expect((await app.inject({ method: 'POST', url, headers: cookie, payload: { ...payload, csrfToken: 'wrong' } })).statusCode).toBe(403); expect(setEnabled).not.toHaveBeenCalled(); const ok = await app.inject({ method: 'POST', url, headers: cookie, payload }); expect(ok.statusCode).toBe(303); expect(setEnabled).toHaveBeenCalledWith(guildId, 'tickets', true, guildId); expect(audit).toHaveBeenCalledWith(expect.objectContaining({ success: true, requestId: expect.any(String) })); await app.close(); });
  it('rejects forged Host headers and never trusts forwarded hosts for origin', async () => { const { deps, setEnabled } = fixture(); const app = await createDashboardServer(deps); const response = await app.inject({ method: 'POST', url: `/g/${guildId}/action/module-toggle`, headers: { ...cookie, host: 'evil.example', origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' }, payload: { csrfToken: 'csrf', module: 'tickets', enabled: 'true' } }); expect(response.statusCode).toBe(403); expect(setEnabled).not.toHaveBeenCalled(); await app.close(); });
  it('does not reexecute domain mutations when success audit persistence fails', async () => { const { deps, setEnabled, audit } = fixture(); audit.mockRejectedValueOnce(new Error('database secret')); const app = await createDashboardServer(deps); const response = await app.inject({ method: 'POST', url: `/g/${guildId}/action/module-toggle`, headers: cookie, payload: { csrfToken: 'csrf', module: 'tickets', enabled: 'true', confirm: 'yes' } }); expect(response.statusCode).toBe(303); expect(setEnabled).toHaveBeenCalledTimes(1); expect(response.body).not.toContain('database secret'); await app.close(); });
  it('rejects oversized bodies and unknown actions without invoking business services', async () => { const { deps, setEnabled } = fixture(); const app = await createDashboardServer(deps); expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/module-toggle`, headers: cookie, payload: { csrfToken: 'csrf', module: 'x'.repeat(33_000), enabled: 'true' } })).statusCode).toBe(413); expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/no-such-action`, headers: cookie, payload: {} })).statusCode).toBe(404); expect(setEnabled).not.toHaveBeenCalled(); await app.close(); });

  it('reuses exactly the injected domain mutation for each V6 action, after all security gates', async () => {
    const f = fixture();
    const actor = { guildId, userId: guildId, guildOwnerId: guildId, roleIds: [] };
    const cases = [
      { name: 'moderation-warn', key: 'warn', level: 'MODERATOR', page: 'moderation', confirm: true, fields: { targetId: f.roleId, reason: 'Rule violation' }, args: [{ actor, action: 'WARN', targetId: f.roleId, reason: 'Rule violation' }, f.gateway] },
      { name: 'ticket-close', key: 'close', level: 'MODERATOR', page: 'tickets', confirm: true, fields: { id: '12', reason: 'Resolved' }, args: [actor, 12, 'Resolved'] },
      { name: 'suggestion-status', key: 'status', level: 'MODERATOR', page: 'suggestions', confirm: false, fields: { id: '13', status: 'ACCEPTED' }, args: [actor, 13, 'ACCEPTED'] },
      { name: 'levels-config', key: 'configureLevels', level: 'ADMIN', page: 'levels', confirm: false, fields: { minLength: '20' }, args: [guildId, { minLength: 20 }] },
      { name: 'event-cancel', key: 'transition', level: 'MODERATOR', page: 'events', confirm: true, fields: { id: '14' }, args: [actor, 14, 'cancel'] },
      { name: 'giveaway-end', key: 'end', level: 'MODERATOR', page: 'giveaways', confirm: true, fields: { id: '15' }, args: [actor, 15] },
      { name: 'module-toggle', key: 'setEnabled', level: 'ADMIN', page: 'settings', confirm: true, fields: { module: 'tickets', enabled: 'true' }, args: [guildId, 'tickets', true, guildId] },
      { name: 'analytics-retention', key: 'retention', level: 'ADMIN', page: 'analytics', confirm: false, fields: { days: '90' }, args: [actor, 90] },
      { name: 'role-set', key: 'setRole', level: 'GUILD_OWNER', page: 'roles', confirm: true, fields: { roleId: f.roleId, level: 'MODERATOR' }, args: [actor, f.roleId, 'MODERATOR', f.services.repository] },
    ] as const;
    const all = Object.values(f.mutations);
    for (const c of cases) {
      const app = await createDashboardServer(f.deps);
      const url = `/g/${guildId}/action/${c.name}`;
      const payload = { csrfToken: 'csrf', ...c.fields, ...(c.confirm ? { confirm: 'yes' } : {}) };
      for (const method of ['GET', 'HEAD'] as const) await app.inject({ method, url, headers: cookie });
      expect(all.every(fn => fn.mock.calls.length === 0)).toBe(true);
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers: { ...cookie, origin: 'https://attacker.example' }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: cookie, payload: { ...payload, csrfToken: 'invalid' } })).statusCode).toBe(403);
      if (c.confirm) expect((await app.inject({ method: 'POST', url, headers: cookie, payload: { ...payload, confirm: '' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/g/999999999999999999/action/${c.name}`, headers: cookie, payload })).statusCode).toBe(403);
      expect(all.every(fn => fn.mock.calls.length === 0)).toBe(true);
      const result = await app.inject({ method: 'POST', url, headers: cookie, payload });
      expect(result.statusCode).toBe(303);
      const keys: Record<string, string> = { 'moderation-warn':'warning-recorded', 'ticket-close':'ticket-closed', 'suggestion-status':'suggestion-updated', 'levels-config':'levels-updated', 'event-cancel':'event-cancelled', 'giveaway-end':'giveaway-ended', 'module-toggle':'module-updated', 'analytics-retention':'analytics-updated', 'role-set':'role-updated' };
      expect(result.headers.location).toBe(`/g/${guildId}/${c.page}?notice=${keys[c.name]}`);
      expect(f.authorize).toHaveBeenCalledWith(guildId, expect.anything(), c.level);
      expect(f.mutations[c.key]).toHaveBeenCalledExactlyOnceWith(...c.args);
      expect(all.reduce((n, fn) => n + fn.mock.calls.length, 0)).toBe(1);
      all.forEach(fn => fn.mockClear());
      await app.close();
    }
    expect(f.deps.moderationGatewayForGuild).toHaveBeenCalledExactlyOnceWith(guildId);
    expect(f.guild.roles.fetch).toHaveBeenCalledExactlyOnceWith(f.roleId);
  });

  it('enforces mock authorization boundaries and revokes changed role access on the next request', async () => {
    const f = fixture(); const app = await createDashboardServer(f.deps);
    const rank = { HELPER: 0, MODERATOR: 1, ADMIN: 2, GUILD_OWNER: 3 };
    let current: keyof typeof rank = 'HELPER';
    f.authorize.mockImplementation(async (id, _session, required) => {
      if (id !== guildId || rank[current] < rank[required as keyof typeof rank]) throw new AppError('PERMISSION', 'Denied');
      return { guildId: id, userId: guildId, guildOwnerId: guildId, roleIds: [] };
    });
    const calls = [
      { action: 'suggestion-status', fields: { id: '1', status: 'ACCEPTED' }, minimum: 'MODERATOR' },
      { action: 'levels-config', fields: { minLength: '2' }, minimum: 'ADMIN' },
      { action: 'role-set', fields: { roleId: f.roleId, level: 'HELPER', confirm: 'yes' }, minimum: 'GUILD_OWNER' },
    ] as const;
    for (const role of ['HELPER', 'MODERATOR', 'ADMIN'] as const) {
      current = role;
      for (const c of calls) {
        const result = await app.inject({ method: 'POST', url: `/g/${guildId}/action/${c.action}`, headers: cookie, payload: { csrfToken: 'csrf', ...c.fields } });
        expect(result.statusCode).toBe(rank[role] >= rank[c.minimum] ? 303 : 403);
      }
    }
    current = 'GUILD_OWNER';
    expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/role-set`, headers: cookie, payload: { csrfToken: 'csrf', ...calls[2].fields } })).statusCode).toBe(303);
    current = 'HELPER';
    expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/role-set`, headers: cookie, payload: { csrfToken: 'csrf', ...calls[2].fields } })).statusCode).toBe(403);
    expect(f.mutations.setRole).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects malformed identifiers and oversized payloads without exposing service error secrets', async () => {
    const f = fixture(); const app = await createDashboardServer(f.deps);
    for (const [action, fields] of [
      ['ticket-close', { id: '-1', reason: 'Resolved', confirm: 'yes' }],
      ['event-cancel', { id: '9007199254740992', confirm: 'yes' }],
      ['moderation-warn', { targetId: 'not-a-snowflake', reason: 'Bad', confirm: 'yes' }],
      ['role-set', { roleId: 'invalid', level: 'HELPER', confirm: 'yes' }],
    ] as const) expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/${action}`, headers: cookie, payload: { csrfToken: 'csrf', ...fields } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/ticket-close`, headers: cookie, payload: { csrfToken: 'csrf', id: '1', reason: 'x'.repeat(33_000), confirm: 'yes' } })).statusCode).toBe(413);
    expect(Object.values(f.mutations).every(fn => fn.mock.calls.length === 0)).toBe(true);
    f.mutations.close.mockRejectedValueOnce(new Error('SQL SELECT password=supersecret\n at private/server.ts:12'));
    const failed = await app.inject({ method: 'POST', url: `/g/${guildId}/action/ticket-close`, headers: cookie, payload: { csrfToken: 'csrf', id: '1', reason: 'Resolved', confirm: 'yes' } });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toMatch(/^Action failed \([^)]+\)$/);
    expect(failed.body).not.toMatch(/SQL|password|supersecret|private\/server| at /i);
    await app.close();
  });

  it('escapes hostile titles, prizes, and usernames with no executable script policy', async () => {
    const f = fixture();
    f.guild.name = '<svg onload=alert(1)>';
    Object.assign(f.read, {
      events: vi.fn(async () => [{ title: '<img src=x onerror=alert(1)>' }]),
      giveaways: vi.fn(async () => [{ prize: '<script>alert(2)</script>' }]),
      members: vi.fn(async () => [{ username: '<iframe src=evil>' }]),
    });
    const app = await createDashboardServer(f.deps);
    for (const page of ['events', 'giveaways', 'members']) {
      const result = await app.inject({ url: `/g/${guildId}/${page}`, headers: cookie });
      expect(result.statusCode).toBe(200);
      expect(result.headers['content-security-policy']).toContain("script-src 'none'");
      expect(result.body).toContain('&lt;svg onload=alert(1)&gt;');
      expect(result.body.split(brandMark)).toHaveLength(2); // Only the exact static first-party mark is permitted.
      expect(result.body.replaceAll(brandMark, '')).not.toMatch(/<svg|<script|<iframe|<img src=x/i);
      if (page === 'events') expect(result.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
      if (page === 'giveaways') expect(result.body).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    }
    expect(Object.values(f.mutations).every(fn => fn.mock.calls.length === 0)).toBe(true);
    await app.close();
  });
});
