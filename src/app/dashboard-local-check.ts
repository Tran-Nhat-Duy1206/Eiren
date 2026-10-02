import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { createDashboardServer, type DashboardWebDeps } from '../dashboard/web.js';

/** Local HTTP smoke plus synthetic ADMIN page/CSRF checks; never opens Discord OAuth. */
async function main(): Promise<void> {
  const { pool } = createDatabase(loadEnv().DATABASE_URL);
  let app: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  const deadline = AbortSignal.timeout(10_000);
  let url: string | undefined;
  let stopServer: ReturnType<typeof setTimeout> | undefined;
  const checks: Record<string, boolean> = { database: false, healthz: false, login: false, css: false, rootRedirect: false, guildsRedirect: false, restrictiveHeaders: false, secretFree: false,
    automationAdminPage: false, automationOriginCsrf: false, automationCsp: false,
    retentionPage: false, retentionOriginCsrf: false, retentionCsp: false };
  try {
    const connected = await pool.query('SELECT 1 AS ready');
    checks.database = connected.rows[0]?.ready === 1;
    if (!checks.database) throw new Error('Database connectivity check failed');

    const forbidden = (): never => { throw new Error('Unexpected OAuth or domain mutation'); };
    const localGuild = '123456789012345678';
    const localSession = 'v75-local-test-session';
    const deps = {
      client: { guilds: { fetch: async () => ({ id: localGuild, name: 'Local dashboard fixture' }) } },
      services: { modules: { isEnabled: async () => false }, permissions: { resolve: async () => 'GUILD_OWNER' },
        automation: { list: async () => [], listRecentExecutions: async () => [] } },
      access: { authorize: async (guildId: string) => { if (guildId !== localGuild) return forbidden();
        return { guildId, userId: localGuild, guildOwnerId: localGuild, roleIds: [] }; }, listAccessible: forbidden }, read: {},
      audit: { record: forbidden },
      retention: { status: async () => ({ policy: { enabled: false, ticketDays: 90, reportDays: 365, appealDays: 365,
        version: 0, confirmedBy: null, confirmedAt: null }, eligibleCounts: { ticket: 0, report: 0, appeal: 0 },
        holdCounts: { ticket: 0, report: 0, appeal: 0 }, activeHolds: [], recentReceipts: [] }),
        preview: forbidden, getPreview: forbidden, confirm: forbidden, disable: forbidden,
        setHold: forbidden, clearHold: forbidden },
      auth: {
        startOAuth: forbidden, completeOAuth: forbidden, clearStateCookie: forbidden,
        clearSessionCookie: () => ({ name: 'dashboard_session', value: '', options: { path: '/', httpOnly: true, sameSite: 'lax', secure: false, maxAge: 0 } }),
        getSession: async (raw: string) => raw === localSession ? { userId: localGuild, oauthGuildIds: [localGuild],
          expiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 60_000) } : null,
        revokeSession: forbidden, csrfToken: () => 'local-csrf', verifyCsrf: (raw: string, csrf: string) => raw === localSession && csrf === 'local-csrf',
      },
      baseUrl: 'http://127.0.0.1/', secureCookies: false, trustProxy: false,
    } as unknown as DashboardWebDeps;
    app = await createDashboardServer(deps);
    url = await app.listen({ host: '127.0.0.1', port: 0 });
    const activeApp = app;
    stopServer = setTimeout(() => { void activeApp.close(); }, 10_000);
    stopServer.unref();
    const paths = ['/healthz', '/login', '/assets/dashboard.css', '/', '/guilds'] as const;
    const responses = await Promise.all(paths.map(async path => {
      const response = await fetch(new URL(path, url), { signal: deadline, redirect: 'manual' });
      return { response, body: await response.text() };
    }));
    const health = responses[0]!; const login = responses[1]!; const css = responses[2]!;
    const root = responses[3]!; const guilds = responses[4]!;
    checks.healthz = health.response.status === 200 && health.body === '{"status":"ok"}';
    checks.login = login.response.status === 200 && login.body.includes('/assets/dashboard.css');
    checks.css = css.response.status === 200 && css.response.headers.get('content-type')?.includes('text/css') === true && css.body.length > 0;
    checks.rootRedirect = root.response.status === 302 && root.response.headers.get('location') === '/login';
    checks.guildsRedirect = guilds.response.status === 302 && guilds.response.headers.get('location') === '/login';
    checks.restrictiveHeaders = responses.every(({ response }) => {
      const csp = response.headers.get('content-security-policy') ?? '';
      return csp.includes("default-src 'none'") && csp.includes("script-src 'none'") &&
        response.headers.get('x-content-type-options') === 'nosniff' &&
        response.headers.get('x-frame-options') === 'SAMEORIGIN' &&
        response.headers.get('strict-transport-security') !== null;
    });
    const forbiddenValues = [process.env.DISCORD_TOKEN, process.env.DISCORD_CLIENT_SECRET, process.env.DASHBOARD_SESSION_SECRET,
      process.env.DATABASE_URL].filter((value): value is string => typeof value === 'string' && value.length > 0);
    checks.secretFree = responses.every(({ response, body }) => {
      const publicData = body + JSON.stringify([...response.headers]);
      return forbiddenValues.every(value => !publicData.includes(value));
    });
    const automationUrl = new URL(`/g/${localGuild}/automations`, url);
    const automationResponse = await fetch(automationUrl, { signal: deadline, headers: { cookie: `dashboard_session=${localSession}` } });
    const automationHtml = await automationResponse.text();
    checks.automationAdminPage = automationResponse.status === 200 && automationHtml.includes('Automation module: Disabled') &&
      automationHtml.includes('/action/automation-create') && automationHtml.includes('/action/automation-module-toggle');
    checks.automationCsp = (automationResponse.headers.get('content-security-policy') ?? '').includes("script-src 'none'") &&
      !automationHtml.includes('<script');
    checks.secretFree &&= forbiddenValues.every(value => !automationHtml.includes(value));
    const protectedAction = new URL(`/g/${localGuild}/action/automation-create`, url);
    const blocked = await Promise.all([
      fetch(protectedAction, { method: 'POST', signal: deadline, headers: { cookie: `dashboard_session=${localSession}`, origin: 'http://127.0.0.1', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrfToken=invalid' }),
      fetch(protectedAction, { method: 'POST', signal: deadline, headers: { cookie: `dashboard_session=${localSession}`, origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrfToken=local-csrf' }),
    ]);
    checks.automationOriginCsrf = blocked.every(response => response.status === 403);
    const retentionUrl = new URL(`/g/${localGuild}/data-retention`, url);
    const retentionResponse = await fetch(retentionUrl, { signal: deadline, headers: { cookie: `dashboard_session=${localSession}` } });
    const retentionHtml = await retentionResponse.text();
    checks.retentionPage = retentionResponse.status === 200 && retentionHtml.includes('DB-only retention') &&
      retentionHtml.includes('action/retention-preview') && retentionHtml.includes('Ticket days') &&
      !retentionHtml.includes('private transcript');
    checks.retentionCsp = (retentionResponse.headers.get('content-security-policy') ?? '').includes("script-src 'none'") &&
      !retentionHtml.includes('<script');
    checks.secretFree &&= forbiddenValues.every(value => !retentionHtml.includes(value));
    const retentionAction = new URL(`/g/${localGuild}/action/retention-preview`, url);
    const retentionBlocked = await Promise.all([
      fetch(retentionAction, { method: 'POST', signal: deadline, headers: { cookie: `dashboard_session=${localSession}`, origin: 'http://127.0.0.1', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrfToken=invalid&ticketDays=90&reportDays=365&appealDays=365' }),
      fetch(retentionAction, { method: 'POST', signal: deadline, headers: { cookie: `dashboard_session=${localSession}`, origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrfToken=local-csrf&ticketDays=90&reportDays=365&appealDays=365' }),
    ]);
    checks.retentionOriginCsrf = retentionBlocked.every(response => response.status === 403);
    console.log(JSON.stringify({ url, checks, redirects: { rootStatus: root.response.status, rootLocation: root.response.headers.get('location'), guildsStatus: guilds.response.status, guildsLocation: guilds.response.headers.get('location') }, passed: Object.values(checks).every(Boolean) }));
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ url: url ?? null, checks, passed: false, errorType: error instanceof Error ? error.name : 'unknown' }));
    process.exitCode = 1;
  } finally {
    if (stopServer) clearTimeout(stopServer);
    try { await app?.close(); } finally { await pool.end(); }
  }
}

void main().catch(error => {
  // Never print exception messages: connection errors can contain credentials.
  console.error(JSON.stringify({ passed: false, errorType: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
});
