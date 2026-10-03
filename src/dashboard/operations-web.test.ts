import { describe, expect, it, vi } from 'vitest';
import { createDashboardServer, type DashboardWebDeps } from './web.js';
import { DashboardAccess } from './access/dashboard-access.js';
import { PermissionService, type PermissionLevel } from '../core/permissions/permission-service.js';
import { ReadinessService } from '../core/operations/readiness.js';
import { operationsFixture } from '../app/v84-operations-fixtures.js';
import { renderOperationsDashboard } from './operations-ui.js';
import { renderPage } from './ui.js';
import { V5Scheduler } from '../app/v5-scheduler.js';
import { ModerationScheduler } from '../modules/moderation/scheduler.js';

const guildId = '123456789012345678', otherGuild = '999999999999999999', userId = '234567890123456789';
const headers = { cookie: 'dashboard_session=valid' };
function setup(rank: PermissionLevel = 'ADMIN') {
  let present = true, gateway = true, phase = 'RUNNING', v5 = 'HEALTHY', moderation = 'HEALTHY';
  const membersFetch = vi.fn(async () => { if (!present) throw new Error('SYNTHETIC_PRIVATE_REST'); return { id: userId, guild: { id: guildId }, roles: { cache: new Map([['345678901234567890', {}]]) } }; });
  const rolesFetch = vi.fn(async () => undefined);
  const guildFetch = vi.fn(async (input: { guild: string }) => ({ id: input.guild, name: '<Synthetic guild>', ownerId: rank === 'GUILD_OWNER' ? userId : '456789012345678901', members: { fetch: membersFetch }, roles: { fetch: rolesFetch } }));
  const client = { isReady: vi.fn(() => gateway), guilds: { fetch: guildFetch }, rest: { get: vi.fn(() => { throw new Error('Unexpected REST'); }) } };
  const permissions = new PermissionService({ getRoleLevels: async () => [rank] }, rank === 'BOT_OWNER' ? new Set([userId]) : new Set());
  const probe = vi.fn(async () => ({ database: 'ready' as const, migrations: 'ready' as const, observedCount: 21 }));
  const readiness = new ReadinessService(probe, () => client.isReady(), () => phase, () => ({ v5, moderation }));
  const check = vi.spyOn(readiness, 'check');
  const inspect = vi.fn(async (_guild: string) => operationsFixture());
  const authGetSession = vi.fn(async (raw: string | undefined) => raw === 'valid' ? { userId, oauthGuildIds: [guildId, otherGuild], expiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 60_000) } : null);
  const deps = { client, services: { modules: { isEnabled: vi.fn(async () => false) }, permissions },
    access: new DashboardAccess(client as never, permissions), operations: { inspect }, readiness,
    read: {}, audit: { record: vi.fn(() => { throw new Error('Unexpected mutation audit'); }) },
    auth: { getSession: authGetSession, clearSessionCookie: () => ({ name: 'dashboard_session', value: '', options: { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 0 } }), csrfToken: () => 'csrf', verifyCsrf: () => true },
    baseUrl: 'https://dashboard.example', logger: { error: vi.fn() } } as unknown as DashboardWebDeps;
  return { deps, probe, check, inspect, client, guildFetch, membersFetch, rolesFetch, authGetSession,
    gateway: (value: boolean) => { gateway = value; }, absent: () => { present = false; },
    phase: (value: string) => { phase = value; }, states: (a: string, b: string) => { v5 = a; moderation = b; } };
}

describe('V8.4 liveness/readiness and ADMIN read-only Operations', () => {
  it('healthz stays cheap 200 even with all dependencies unavailable and no action rate budget', async () => {
    const f = setup(); f.gateway(false); f.states('STALE', 'STALE'); f.phase('STOPPING');
    f.probe.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_DATABASE_URL'));
    const app = await createDashboardServer(f.deps);
    for (let i = 0; i < 125; i++) { const response = await app.inject('/healthz'); expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ status: 'ok' }); }
    expect(f.check).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled(); expect(f.client.isReady).not.toHaveBeenCalled();
    expect(f.guildFetch).not.toHaveBeenCalled(); expect(f.authGetSession).not.toHaveBeenCalled();
    expect(f.client.rest.get).not.toHaveBeenCalled(); await app.close();
  });
  it('readyz has no auth, content, IDs, timestamps or hashes and no-store', async () => {
    const f = setup(), app = await createDashboardServer(f.deps);
    const response = await app.inject('/readyz');
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ status: 'ready', checks: { database: 'ready', migrations: 'ready', gateway: 'ready', scheduler: 'ready' } });
    expect(f.authGetSession).not.toHaveBeenCalled(); expect(f.guildFetch).not.toHaveBeenCalled(); expect(f.client.rest.get).not.toHaveBeenCalled();
    f.gateway(false); expect((await app.inject('/readyz')).json().checks.gateway).toBe('not_ready');
    expect((await app.inject('/readyz')).statusCode).toBe(503); expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect(f.probe).toHaveBeenCalledOnce(); await app.close();
  });
  it.each(['STARTING', 'STALE', 'STOPPED'])('fails readyz for %s in either required scheduler', async state => {
    const f = setup(), app = await createDashboardServer(f.deps);
    for (const [a, b] of [[state, 'HEALTHY'], ['HEALTHY', state]]) { f.states(a!, b!); expect((await app.inject('/readyz')).statusCode).toBe(503); }
    f.states('HEALTHY', 'HEALTHY'); f.phase('STOPPING'); expect((await app.inject('/readyz')).statusCode).toBe(503);
    await app.close();
  });
  it('DB failure/migration mismatch return distinct fixed 503 bodies while healthz stays 200', async () => {
    for (const failed of [true, false]) {
      const f = setup();
      if (failed) f.probe.mockRejectedValue(new Error('SYNTHETIC_SECRET_SQL'));
      else f.probe.mockResolvedValue({ database: 'ready', migrations: 'mismatch' as never, observedCount: 20 });
      const app = await createDashboardServer(f.deps), response = await app.inject('/readyz');
      expect(response.statusCode).toBe(503); expect(response.json().checks.database).toBe(failed ? 'unavailable' : 'ready');
      expect(response.json().checks.migrations).toBe(failed ? 'unavailable' : 'mismatch');
      expect(response.body).not.toMatch(/SECRET|SQL|observed|count|hash|checkedAt/);
      expect((await app.inject('/healthz')).statusCode).toBe(200); await app.close();
    }
  });
  it.each(['ADMIN', 'GUILD_OWNER', 'BOT_OWNER'] as const)('permits %s through real fresh DashboardAccess without mutations', async rank => {
    const f = setup(rank), app = await createDashboardServer(f.deps);
    const response = await app.inject({ url: `/g/${guildId}/operations`, headers });
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(f.guildFetch).toHaveBeenCalledWith({ guild: guildId, force: true }); expect(f.membersFetch).toHaveBeenCalledWith({ user: userId, force: true });
    expect(f.rolesFetch).toHaveBeenCalled(); expect(f.inspect).toHaveBeenCalledExactlyOnceWith(guildId);
    expect(response.body).toContain('Runtime telemetry since process restart'); expect(response.body).toContain('DEGRADED');
    expect(response.body).toContain('Do not blindly retry; inspect and reconcile'); expect(response.body).toContain(`/g/${guildId}/automations`);
    expect(response.body).toContain('normal dashboard audit write was not confirmed'); expect(response.body).toContain('0020_subject_request_governance');
    expect(response.body).not.toMatch(/\/action\/|<script|<input[^>]+name="(?:restart|retry|repair)"|migration hash/i);
    expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/operations-retry`, headers, payload: { csrfToken: 'csrf' } })).statusCode).toBe(404);
    await app.close();
  });
  it.each(['MODERATOR', 'HELPER', 'MEMBER'] as const)('denies %s before operational reads', async rank => {
    const f = setup(rank), app = await createDashboardServer(f.deps);
    expect((await app.inject({ url: `/g/${guildId}/operations`, headers })).statusCode).toBe(403); expect(f.inspect).not.toHaveBeenCalled(); await app.close();
  });
  it('anonymous redirects; OAuth snapshot alone cannot bypass lost membership/wrong-guild member', async () => {
    const f = setup(), app = await createDashboardServer(f.deps);
    expect((await app.inject(`/g/${guildId}/operations`)).headers.location).toBe('/login');
    expect((await app.inject({ url: `/g/${otherGuild}/operations`, headers })).statusCode).toBe(403);
    f.absent(); expect((await app.inject({ url: `/g/${guildId}/operations`, headers })).statusCode).toBe(403);
    expect(f.inspect).not.toHaveBeenCalled(); await app.close();
  });
  it('real scheduler barrier makes readiness stale and recovers, while isolated job failure remains ready', async () => {
    const f = setup(); let now = 0, held: Promise<void> | null = null, release!: () => void, fail = false;
    const logger = { debug: vi.fn(), error: vi.fn() } as never;
    const later = vi.fn(async () => undefined);
    const v5 = new V5Scheduler([{ name: 'events', runDue: async () => { if (held) await held; if (fail) throw Object.assign(new Error('SYNTHETIC_PRIVATE'), { code: '08006' }); } }, { name: 'giveaways', runDue: later }], logger, 30_000, () => now);
    const moderation = new ModerationScheduler({ expireDue: async () => undefined } as never, async () => ({} as never), logger, 30_000, () => now);
    f.deps.readiness = new ReadinessService(f.probe, () => true, () => 'RUNNING', () => ({ v5: v5.telemetry.snapshot().state, moderation: moderation.telemetry.snapshot().state }), () => now);
    const app = await createDashboardServer(f.deps);
    expect((await app.inject('/readyz')).statusCode).toBe(503);
    await v5.tick(); await moderation.tick(); expect((await app.inject('/readyz')).statusCode).toBe(200);
    held = new Promise(resolve => { release = resolve; }); const active = v5.tick(); expect(v5.tick()).toBe(active);
    now = 90_001; await moderation.tick(); expect((await app.inject('/readyz')).json().checks.scheduler).toBe('stale');
    expect((await app.inject('/readyz')).statusCode).toBe(503); release(); await active; held = null;
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    fail = true; await v5.tick(); expect(later).toHaveBeenCalledTimes(3);
    expect(v5.telemetry.snapshot().jobs[0]).toMatchObject({ state: 'DEGRADED', lastFailureCategory: 'DATABASE' });
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    await v5.stop(); expect((await app.inject('/readyz')).json().checks.scheduler).toBe('stopped');
    await moderation.stop(); await app.close();
  });
  it('rejects refresh/action/guild query parameters without dispatching reads or mutations', async () => {
    const f = setup(), app = await createDashboardServer(f.deps);
    expect((await app.inject({ url: `/g/${guildId}/operations?guildId=${otherGuild}&retry=yes`, headers })).statusCode).toBe(400);
    expect(f.inspect).not.toHaveBeenCalled(); await app.close();
  });
  it('contains unexpected Operations errors to a fixed category without arbitrary class/message logging', async () => {
    const f = setup(); f.inspect.mockRejectedValue(Object.assign(new Error('SYNTHETIC_PRIVATE_BODY'), { name: 'SYNTHETIC_PRIVATE_CLASS' }));
    const app = await createDashboardServer(f.deps), response = await app.inject({ url: `/g/${guildId}/operations`, headers });
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain('SYNTHETIC_PRIVATE');
    expect(JSON.stringify((f.deps.logger!.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('SYNTHETIC_PRIVATE');
    expect(f.deps.logger!.error).toHaveBeenCalledWith(expect.objectContaining({ category: 'UNKNOWN' }), 'Dashboard request failed');
    await app.close();
  });
  it('escapes every displayed label and never serializes unknown/private fields', () => {
    const fixture = operationsFixture(); fixture.guild.modules![0]!.key = '<img src=x onerror=alert(1)>';
    Object.assign(fixture, { token: 'SYNTHETIC_PRIVATE_TOKEN', transcript: 'SYNTHETIC_PRIVATE_TRANSCRIPT' });
    Object.assign(fixture.readiness, { hash: 'SYNTHETIC_PRIVATE_HASH', sql: 'SYNTHETIC_PRIVATE_SQL' });
    const html = renderOperationsDashboard(guildId, fixture);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;'); expect(html).not.toContain('<img'); expect(html).not.toContain('SYNTHETIC_PRIVATE');
    for (const boundary of ['backup_health', 'discord_orphans', 'tls_health', 'historical_failures']) expect(html).toContain(boundary);
    for (const rank of ['HELPER', 'MODERATOR']) expect(renderPage({ page: 'overview', guildId, guildName: 'Synthetic', csrfToken: '', actorLevel: rank })).not.toContain(`/g/${guildId}/operations`);
  });
});
