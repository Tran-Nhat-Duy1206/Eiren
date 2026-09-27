import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { createDashboardServer, type DashboardWebDeps } from '../dashboard/web.js';

/** Local, unauthenticated smoke check. Never opens a Discord OAuth route. */
async function main(): Promise<void> {
  const { pool } = createDatabase(loadEnv().DATABASE_URL);
  let app: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  const deadline = AbortSignal.timeout(10_000);
  let url: string | undefined;
  let stopServer: ReturnType<typeof setTimeout> | undefined;
  const checks: Record<string, boolean> = { database: false, healthz: false, login: false, css: false, rootRedirect: false, guildsRedirect: false, restrictiveHeaders: false, secretFree: false };
  try {
    const connected = await pool.query('SELECT 1 AS ready');
    checks.database = connected.rows[0]?.ready === 1;
    if (!checks.database) throw new Error('Database connectivity check failed');

    const forbidden = (): never => { throw new Error('Unexpected authenticated or OAuth operation'); };
    const deps = {
      client: {}, services: {}, access: { authorize: forbidden, listAccessible: forbidden }, read: {},
      audit: { record: forbidden },
      auth: {
        startOAuth: forbidden, completeOAuth: forbidden, clearStateCookie: forbidden,
        clearSessionCookie: () => ({ name: 'dashboard_session', value: '', options: { path: '/', httpOnly: true, sameSite: 'lax', secure: false, maxAge: 0 } }), getSession: async () => null,
        revokeSession: forbidden, csrfToken: forbidden, verifyCsrf: forbidden,
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
