import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { createDashboardServer, type DashboardWebDeps } from '../dashboard/web.js';
import { ReadinessService } from '../core/operations/readiness.js';
import { operationsFixture } from './v84-operations-fixtures.js';

/** Local HTTP smoke plus synthetic ADMIN page/CSRF checks; never opens Discord OAuth. */
async function main(): Promise<void> {
  const { pool } = createDatabase(loadEnv().DATABASE_URL);
  let app: Awaited<ReturnType<typeof createDashboardServer>> | undefined;
  const deadline = AbortSignal.timeout(10_000);
  let url: string | undefined;
  let stopServer: ReturnType<typeof setTimeout> | undefined;
  const checks: Record<string, boolean> = { database: false, healthz: false, login: false, css: false, rootRedirect: false, guildsRedirect: false, restrictiveHeaders: false, secretFree: false,
    automationAdminPage: false, automationOriginCsrf: false, automationCsp: false,
    retentionPage: false, retentionOriginCsrf: false, retentionCsp: false,
    privacyPage: false, privacyOriginCsrf: false, privacyCsp: false,
    healthzLiveness: false, readyzReady: false, readyzDegraded: false, operationsAdminPage: false,
    operationsPrivateFree: false, operationsUncertainLink: false, operationsSinceRestart: false,
    operationsMigration: false, operationsNoMutations: false,
    designTokens: false, groupedNavigation: false, currentNavigation: false, responsiveStructure: false,
    canonicalBadges: false, accessibleLandmarks: false, formLabelsHelp: false, destructivePresentation: false,
    noticeAllowlist: false, noticeUnknownIgnored: false, contextualEmpty: false, guildPickerEscaped: false,
    retentionSafetyCopy: false, privacySafetyCopy: false, operationsNoActionControls: false, presentationNoJs: false };
  try {
    const connected = await pool.query('SELECT 1 AS ready');
    checks.database = connected.rows[0]?.ready === 1;
    if (!checks.database) throw new Error('Database connectivity check failed');

    const forbidden = (): never => { throw new Error('Unexpected OAuth or domain mutation'); };
    const localGuild = '123456789012345678';
    const localSession = 'v75-local-test-session';
    let gatewayReady = true;
    const readiness = new ReadinessService(async () => ({ database: 'ready', migrations: 'ready', observedCount: 21 }),
      () => gatewayReady, () => 'RUNNING', () => ({ v5: 'HEALTHY', moderation: 'HEALTHY' }));
    const deps = {
      readiness, operations: { inspect: async (guildId: string) => { if (guildId !== localGuild) return forbidden(); return operationsFixture(); } },
      client: { guilds: { fetch: async () => ({ id: localGuild, name: 'Local dashboard fixture' }) } },
      services: { modules: { isEnabled: async (_guild: string, module: string) => !['automation', 'analytics'].includes(module) }, permissions: { resolve: async () => 'GUILD_OWNER' },
        automation: { list: async () => [], listRecentExecutions: async () => [] } },
      access: { authorize: async (guildId: string) => { if (guildId !== localGuild) return forbidden();
        return { guildId, userId: localGuild, guildOwnerId: localGuild, roleIds: [] }; }, listAccessible: async () => [{ id: localGuild, name: '<img src=x> Synthetic server' }] },
      read: { overview: async () => ({ settings: { timezone: 'UTC' }, modules: [{ moduleKey: 'core', enabled: true }], counts: { activeCases: 1, openReports: 2, openTickets: 3, pendingSuggestions: 4, scheduledEvents: 5, activeGiveaways: 6 } }), botSettings: async () => ({ modules: [{ moduleKey: 'core', enabled: true }] }), tickets: async () => [] },
      audit: { record: forbidden },
      retention: { status: async () => ({ policy: { enabled: false, ticketDays: 90, reportDays: 365, appealDays: 365,
        version: 0, confirmedBy: null, confirmedAt: null }, eligibleCounts: { ticket: 0, report: 0, appeal: 0 },
        holdCounts: { ticket: 0, report: 0, appeal: 0 }, activeHolds: [], recentReceipts: [] }),
        preview: forbidden, getPreview: forbidden, confirm: forbidden, disable: forbidden,
        setHold: forbidden, clearHold: forbidden },
      subjectRequests: { list: async () => [], recentReceipts: async () => [], inspect: forbidden,
        preview: forbidden, confirm: forbidden, execute: forbidden, deny: forbidden, recordAuditGap: forbidden },
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
    const privacyResponse = await fetch(new URL(`/g/${localGuild}/privacy`, url), { signal: deadline, headers: { cookie: `dashboard_session=${localSession}` } });
    const privacyHtml = await privacyResponse.text();
    checks.privacyPage = privacyResponse.status === 200 && privacyHtml.includes('Privacy requests') &&
      privacyHtml.includes('Requests (up to 50)') && privacyHtml.includes('Recent metadata receipts (up to 50)') &&
      privacyHtml.includes('Eiren-controlled PostgreSQL data for this guild only') && !privacyHtml.includes('name="subjectUserId"') && !privacyHtml.includes('privacy-create');
    checks.privacyCsp = (privacyResponse.headers.get('content-security-policy') ?? '').includes("script-src 'none'") && !privacyHtml.includes('<script');
    checks.secretFree &&= forbiddenValues.every(value => !privacyHtml.includes(value));
    const privacyAction = new URL(`/g/${localGuild}/action/privacy-preview`, url);
    const privacyBlocked = await Promise.all([
      fetch(privacyAction, { method: 'POST', signal: deadline, headers: { cookie: `dashboard_session=${localSession}`, origin: 'http://127.0.0.1', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrfToken=invalid&requestId=123e4567-e89b-42d3-a456-426614174000' }),
      fetch(privacyAction, { method: 'POST', signal: deadline, headers: { cookie: `dashboard_session=${localSession}`, origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrfToken=local-csrf&requestId=123e4567-e89b-42d3-a456-426614174000' }),
    ]);
    checks.privacyOriginCsrf = privacyBlocked.every(response => response.status === 403);
    const readyResponse = await fetch(new URL('/readyz', url), { signal: deadline });
    const readyBody = await readyResponse.text();
    checks.readyzReady = readyResponse.status === 200 && readyBody === '{"status":"ready","checks":{"database":"ready","migrations":"ready","gateway":"ready","scheduler":"ready"}}' && readyResponse.headers.get('cache-control') === 'no-store';
    gatewayReady = false;
    const degradedResponse = await fetch(new URL('/readyz', url), { signal: deadline });
    const degradedBody = await degradedResponse.text();
    checks.readyzDegraded = degradedResponse.status === 503 && degradedBody.includes('"gateway":"not_ready"') && !/hash|guild|checkedAt|observedCount/.test(degradedBody);
    const stillAlive = await fetch(new URL('/healthz', url), { signal: deadline });
    checks.healthzLiveness = stillAlive.status === 200 && await stillAlive.text() === '{"status":"ok"}';
    gatewayReady = true;
    const operationsResponse = await fetch(new URL(`/g/${localGuild}/operations`, url), { signal: deadline, headers: { cookie: `dashboard_session=${localSession}` } });
    const operationsHtml = await operationsResponse.text();
    checks.operationsAdminPage = operationsResponse.status === 200 && operationsHtml.includes('Guild operational backlog') && operationsResponse.headers.get('cache-control') === 'no-store';
    checks.operationsPrivateFree = forbiddenValues.every(value => !operationsHtml.includes(value)) && !/transcript|report description|appeal reason|static message|migration hash/i.test(operationsHtml);
    checks.operationsUncertainLink = operationsHtml.includes('Do not blindly retry; inspect and reconcile') && operationsHtml.includes(`/g/${localGuild}/automations`) && operationsHtml.includes('normal dashboard audit write was not confirmed');
    checks.operationsSinceRestart = operationsHtml.includes('Runtime telemetry since process restart') && operationsHtml.includes('moderation-expiry') && operationsHtml.includes('DEGRADED');
    checks.operationsMigration = operationsHtml.includes('0020_subject_request_governance') && operationsHtml.includes('Observed migration count') && operationsHtml.includes('NOT_TRACKED');
    checks.operationsNoMutations = !operationsHtml.includes('/action/') && !operationsHtml.includes('<script') && (operationsResponse.headers.get('content-security-policy') ?? '').includes("script-src 'none'");
    checks.secretFree &&= forbiddenValues.every(value => !readyBody.includes(value) && !degradedBody.includes(value) && !operationsHtml.includes(value));
    const fixtureHeaders = { cookie: `dashboard_session=${localSession}` };
    const page = async (name: string): Promise<string> => { const response = await fetch(new URL(`/g/${localGuild}/${name}`, url), { signal: deadline, headers: fixtureHeaders }); if (response.status !== 200) throw new Error('Synthetic presentation page failed'); return response.text(); };
    const overviewHtml = await page('overview'), settingsHtml = await page('settings'), ticketsHtml = await page('tickets');
    const noticeHtml = await page('settings?notice=module-updated'), unknownHtml = await page('settings?notice=NOT_A_NOTICE_PRIVATE_SENTINEL');
    const pickerResponse = await fetch(new URL('/guilds', url), { signal: deadline, headers: fixtureHeaders }); const pickerHtml = await pickerResponse.text();
    checks.designTokens = ['bg','surface-raised','surface-muted','text-muted','border-strong','accent','focus','success','warning','danger','info','neutral','space-8'].every(token => css.body.includes(`--${token}:`));
    checks.groupedNavigation = ['General','Moderation','Community','Automation','Governance','System'].every(group => overviewHtml.includes(`<h2>${group}</h2>`));
    checks.currentNavigation = overviewHtml.includes(`href="/g/${localGuild}/overview" aria-current="page"`);
    checks.responsiveStructure = ['@media(max-width:64rem)','@media(max-width:48rem)','@media(max-width:27rem)','overflow-x:auto','min-height:44px','.action-group'].every(rule => css.body.includes(rule));
    checks.canonicalBadges = overviewHtml.includes('status-success') && overviewHtml.includes('>Enabled</span>') && operationsHtml.includes('>NOT_TRACKED</span>');
    checks.accessibleLandmarks = [login.body,pickerHtml,overviewHtml,automationHtml,retentionHtml,privacyHtml,operationsHtml,settingsHtml].every(html => (html.match(/<main\b/g) ?? []).length === 1 && html.includes('href="#main"') && html.includes('id="main"'));
    checks.formLabelsHelp = settingsHtml.includes('aria-describedby="field-module-toggle-module-help"') && settingsHtml.includes('id="field-module-toggle-module-help"') && settingsHtml.includes('<label>Module key');
    checks.destructivePresentation = ticketsHtml.includes('destructive-warning') && ticketsHtml.includes('btn-danger') && ticketsHtml.includes('name="confirm" value="yes" required');
    checks.noticeAllowlist = noticeHtml.includes('Module availability updated. Historical data is not deleted.') && noticeHtml.includes('role="status"');
    checks.noticeUnknownIgnored = !unknownHtml.includes('NOT_A_NOTICE_PRIVATE_SENTINEL');
    checks.contextualEmpty = ticketsHtml.includes('No tickets to display.') && automationHtml.includes('No automation rules yet.');
    checks.guildPickerEscaped = pickerResponse.status === 200 && pickerHtml.includes('&lt;img src=x&gt;') && !pickerHtml.includes('<img');
    checks.retentionSafetyCopy = /DB-only|database-only/i.test(retentionHtml) && /Discord copies/i.test(retentionHtml) && /screenshots/i.test(retentionHtml) && /backups/i.test(retentionHtml);
    checks.privacySafetyCopy = /point-in-time/i.test(privacyHtml) && /external copies/i.test(privacyHtml) && /future activity/i.test(privacyHtml) && /accountability/i.test(privacyHtml);
    const operationsMain = operationsHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? '';
    checks.operationsNoActionControls = !/<form\b|<button\b|\/action\//i.test(operationsMain);
    checks.presentationNoJs = [login.body,pickerHtml,overviewHtml,automationHtml,retentionHtml,privacyHtml,operationsHtml,settingsHtml].every(html => !/<script\b|\son(?:click|change)=|javascript:/i.test(html)) && !/url\(|@import/i.test(css.body);
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
