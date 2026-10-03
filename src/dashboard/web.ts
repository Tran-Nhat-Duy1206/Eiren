import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { PermissionFlagsBits, type Client } from 'discord.js';
import { assertAutomationTargets, eligibleAutomationChannels, parseAutomationDraft } from './automation-management.js';
import type { AutomationDashboardView } from './automation-ui.js';
import type { Services } from '../app/services.js';
import type { Actor, PermissionLevel } from '../core/permissions/permission-service.js';
import type { ModerationGateway } from '../modules/moderation/service.js';
import type { DashboardAuth } from './auth/dashboard-auth.js';
import type { DashboardAccess } from './access/dashboard-access.js';
import type { DashboardReadService } from './data/dashboard-read-service.js';
import { AppError } from '../core/errors/errors.js';
import { renderLogin, renderGuildPicker, renderPage, dashboardCss } from './ui.js';
import type { RetentionView, RetentionPreview } from './retention-ui.js';
import type { PrivacyDashboardView } from './privacy-ui.js';
import type { SubjectRequestService } from '../modules/subject-requests/service.js';
import { DENIAL_CODES, GOVERNANCE_ACTIONS, type GovernanceAction } from '../modules/subject-requests/contracts.js';

const snowflake = z.string().regex(/^\d{17,20}$/);
const numberId = z.coerce.number().int().positive().safe();
const ticketRetentionDays = z.coerce.number().int().min(30).max(365);
const privateRetentionDays = z.coerce.number().int().min(90).max(730);
const holdDomain = z.enum(['TICKET', 'REPORT', 'APPEAL']);
function retention(d: DashboardWebDeps): NonNullable<DashboardWebDeps['retention']> { if (!d.retention) throw new AppError('DISABLED', 'Retention unavailable'); return d.retention; }
const retentionActions = new Set(['retention-preview', 'retention-confirm', 'retention-disable', 'retention-hold-set', 'retention-hold-clear']);
const privacyId = z.string().uuid().transform(id => id.toLowerCase());
const privacyActions = new Set(['privacy-preview', 'privacy-confirm', 'privacy-execute', 'privacy-deny']);
const privacyOwnerActions = new Set(['privacy-confirm', 'privacy-execute', 'privacy-deny']);
const governanceActions = new Set<string>(GOVERNANCE_ACTIONS);
function subjectRequests(d: DashboardWebDeps): NonNullable<DashboardWebDeps['subjectRequests']> { if (!d.subjectRequests) throw new AppError('DISABLED', 'Privacy requests unavailable'); return d.subjectRequests; }
const pages = ['overview', 'moderation', 'members', 'roles', 'tickets', 'suggestions', 'levels', 'events', 'giveaways', 'analytics', 'automations', 'data-retention', 'privacy', 'settings'] as const;
type Page = typeof pages[number];
const pageLevel: Record<Page, PermissionLevel> = { overview: 'HELPER', moderation: 'MODERATOR', members: 'HELPER', roles: 'ADMIN', tickets: 'HELPER', suggestions: 'HELPER', levels: 'HELPER', events: 'HELPER', giveaways: 'HELPER', analytics: 'HELPER', automations: 'ADMIN', 'data-retention': 'ADMIN', privacy: 'ADMIN', settings: 'ADMIN' };
const pageModule: Partial<Record<Page, string>> = { moderation: 'moderation', tickets: 'tickets', suggestions: 'suggestions', levels: 'levels', events: 'events', giveaways: 'giveaways' };
type CookieValue = ReturnType<DashboardAuth['clearSessionCookie']>;
type Session = NonNullable<Awaited<ReturnType<DashboardAuth['getSession']>>>;
export interface DashboardWebDeps {
  client: Client;
  services: Services;
  auth: Pick<DashboardAuth, 'startOAuth' | 'completeOAuth' | 'clearStateCookie' | 'clearSessionCookie' | 'getSession' | 'revokeSession' | 'csrfToken' | 'verifyCsrf'>;
  access: Pick<DashboardAccess, 'authorize' | 'listAccessible'>;
  read: DashboardReadService;
  audit: { record(input: { guildId: string; actorUserId: string; action: string; targetType: string; targetId?: string; success: boolean; requestId: string }): Promise<unknown> };
  retention?: {
    status(guildId: string): Promise<RetentionView>;
    preview(actor: Actor, windows: { ticketDays: number; reportDays: number; appealDays: number }): Promise<RetentionPreview>;
    getPreview(actor: Actor, id: string): Promise<RetentionPreview | null>;
    confirm(actor: Actor, id: string): Promise<unknown>;
    disable(actor: Actor): Promise<unknown>;
    setHold(actor: Actor, domain: 'TICKET' | 'REPORT' | 'APPEAL', recordId: number): Promise<unknown>;
    clearHold(actor: Actor, domain: 'TICKET' | 'REPORT' | 'APPEAL', recordId: number): Promise<unknown>;
  };
  subjectRequests?: Pick<SubjectRequestService, 'list' | 'inspect' | 'recentReceipts' | 'preview' | 'confirm' | 'execute' | 'deny' | 'recordAuditGap'>;
  analytics?: { summary(guildId: string, range: '24h' | '7d' | '30d' | '90d', timezone?: string): Promise<unknown>; configure?(actor: Actor, days: number): Promise<unknown> };
  moderationGatewayForGuild?: (guildId: string) => Promise<ModerationGateway>;
  trustProxy?: boolean;
  secureCookies?: boolean;
  baseUrl?: string; // Canonical public dashboard URL; required to enforce Origin on mutations.
  logger?: { error(data: unknown, message?: string): void };
}
const bodySchema = z.record(z.string(), z.union([z.string().max(500), z.undefined()]));
// Only static Automation message fields need 1,000 characters; all other dashboard forms retain 500.
const automationBodySchema = z.record(z.string().max(40), z.union([z.string().max(1_000), z.undefined()]))
  .refine(value => Object.keys(value).length <= 20, 'Too many Automation fields');
const automationMutation = new Set(['automation-create', 'automation-update']);
const privacyBodySchema = z.record(z.string().max(40), z.union([z.string().max(500), z.undefined()]))
  .refine(value => Object.keys(value).length <= 20, 'Too many privacy fields');
const actions: Record<string, { level: PermissionLevel; page: Page; module?: string; execute: (d: DashboardWebDeps, guildId: string, actor: Actor, b: Record<string, string>) => Promise<unknown>; target?: string }> = {
  'module-toggle': { level: 'ADMIN', page: 'settings', execute: (d, g, a, b) => d.services.modules.setEnabled(g, z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).parse(b.module), z.enum(['true', 'false']).parse(b.enabled) === 'true', a.userId), target: 'module' },
  'guild-timezone': { level: 'ADMIN', page: 'settings', execute: (d, g, _a, b) => d.services.guildConfig.update(g, 'timezone', z.string().min(1).max(64).parse(b.timezone)) },
  'moderation-warn': { level: 'MODERATOR', page: 'moderation', module: 'moderation', execute: async (d, g, a, b) => { if (!d.moderationGatewayForGuild) throw new Error('Moderation gateway unavailable'); return d.services.moderation.perform({ actor: a, action: 'WARN', targetId: snowflake.parse(b.targetId), reason: z.string().trim().min(1).max(400).parse(b.reason) }, await d.moderationGatewayForGuild(g)); }, target: 'targetId' },
  'ticket-close': { level: 'MODERATOR', page: 'tickets', module: 'tickets', execute: (d, _g, a, b) => d.services.tickets.close(a, numberId.parse(b.id), z.string().trim().min(1).max(400).parse(b.reason)), target: 'id' },
  'suggestion-status': { level: 'MODERATOR', page: 'suggestions', module: 'suggestions', execute: (d, _g, a, b) => d.services.suggestions.status(a, numberId.parse(b.id), z.enum(['PENDING', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'IMPLEMENTED']).parse(b.status)), target: 'id' },
  'levels-config': { level: 'ADMIN', page: 'levels', module: 'levels', execute: (d, g, _a, b) => d.services.levels.configure(g, { minLength: z.coerce.number().int().min(0).max(2000).parse(b.minLength) }) },
  'event-cancel': { level: 'MODERATOR', page: 'events', module: 'events', execute: (d, _g, a, b) => d.services.events.transition(a, numberId.parse(b.id), 'cancel'), target: 'id' },
  'giveaway-end': { level: 'MODERATOR', page: 'giveaways', module: 'giveaways', execute: (d, _g, a, b) => d.services.giveaways.end(a, numberId.parse(b.id)), target: 'id' },
  'analytics-toggle': { level: 'ADMIN', page: 'analytics', execute: (d, g, a, b) => d.services.modules.setEnabled(g, 'analytics', z.enum(['true', 'false']).parse(b.enabled) === 'true', a.userId) },
  'analytics-retention': { level: 'ADMIN', page: 'analytics', execute: (d, g, _a, b) => { if (!d.analytics?.configure) throw new Error('Analytics retention unavailable'); return d.analytics.configure(_a, z.coerce.number().int().min(30).max(730).parse(b.days)); } },
  'automation-create': { level: 'ADMIN', page: 'automations', execute: async (d, g, a, b) => {
    const draft = parseAutomationDraft(b);
    await assertAutomationTargets(d.client, g, draft);
    return d.services.automation.create(a, draft);
  } },
  'automation-update': { level: 'ADMIN', page: 'automations', execute: async (d, g, a, b) => {
    const id = numberId.parse(b.automationId);
    await d.services.automation.inspect(a, id);
    const draft = parseAutomationDraft(b);
    await assertAutomationTargets(d.client, g, draft);
    return d.services.automation.update(a, id, draft);
  }, target: 'automationId' },
  'automation-enable': { level: 'ADMIN', page: 'automations', execute: (d, _g, a, b) => d.services.automation.setEnabled(a, numberId.parse(b.automationId), true), target: 'automationId' },
  'automation-disable': { level: 'ADMIN', page: 'automations', execute: (d, _g, a, b) => d.services.automation.setEnabled(a, numberId.parse(b.automationId), false), target: 'automationId' },
  'automation-delete': { level: 'ADMIN', page: 'automations', execute: (d, _g, a, b) => d.services.automation.delete(a, numberId.parse(b.automationId)), target: 'automationId' },
  'automation-module-toggle': { level: 'ADMIN', page: 'automations', execute: (d, g, a, b) => d.services.modules.setEnabled(g, 'automation', z.enum(['true', 'false']).parse(b.enabled) === 'true', a.userId) },
  'automation-reconcile-sent': { level: 'ADMIN', page: 'automations', execute: async (d, _g, a, b) => {
    const id = z.string().uuid().parse(b.executionId);
    if ((await d.services.automation.inspectExecution(a, id)).automationId !== numberId.parse(b.automationId))
      throw new AppError('NOT_FOUND', 'Automation execution not found');
    return d.services.automation.reconcile(a, id, z.coerce.number().int().min(0).max(1).parse(b.position), 'CONFIRMED_SENT');
  }, target: 'executionId' },
  'automation-reconcile-not-sent': { level: 'ADMIN', page: 'automations', execute: async (d, _g, a, b) => {
    const id = z.string().uuid().parse(b.executionId);
    if ((await d.services.automation.inspectExecution(a, id)).automationId !== numberId.parse(b.automationId))
      throw new AppError('NOT_FOUND', 'Automation execution not found');
    return d.services.automation.reconcile(a, id, z.coerce.number().int().min(0).max(1).parse(b.position), 'CONFIRMED_NOT_SENT');
  }, target: 'executionId' },
  'privacy-preview': { level: 'ADMIN', page: 'privacy', target: 'requestId', execute: (d, _g, a, b) => subjectRequests(d).preview(a, privacyId.parse(b.requestId)) },
  'privacy-confirm': { level: 'ADMIN', page: 'privacy', target: 'requestId', execute: (d, _g, a, b) => { if (b.phrase !== 'CONFIRM PRIVACY REQUEST') throw new AppError('VALIDATION', 'Confirmation phrase does not match'); return subjectRequests(d).confirm(a, privacyId.parse(b.requestId), privacyId.parse(b.previewId)); } },
  'privacy-execute': { level: 'ADMIN', page: 'privacy', target: 'requestId', execute: (d, _g, a, b) => { if (b.phrase !== 'ERASE ELIGIBLE DATA') throw new AppError('VALIDATION', 'Confirmation phrase does not match'); return subjectRequests(d).execute(a, privacyId.parse(b.requestId), privacyId.parse(b.previewId)); } },
  'privacy-deny': { level: 'ADMIN', page: 'privacy', target: 'requestId', execute: (d, _g, a, b) => { if (b.phrase !== 'DENY PRIVACY REQUEST') throw new AppError('VALIDATION', 'Confirmation phrase does not match'); return subjectRequests(d).deny(a, privacyId.parse(b.requestId), z.enum(DENIAL_CODES).parse(b.denialCode)); } },
  'retention-preview': { level: 'ADMIN', page: 'data-retention', execute: (d, _g, a, b) => retention(d).preview(a, { ticketDays: ticketRetentionDays.parse(b.ticketDays), reportDays: privateRetentionDays.parse(b.reportDays), appealDays: privateRetentionDays.parse(b.appealDays) }) },
  'retention-confirm': { level: 'ADMIN', page: 'data-retention', target: 'previewId', execute: (d, _g, a, b) => { if (b.phrase !== 'ENABLE RETENTION') throw new AppError('VALIDATION', 'Confirmation phrase does not match'); return retention(d).confirm(a, z.string().uuid().parse(b.previewId)); } },
  'retention-disable': { level: 'ADMIN', page: 'data-retention', execute: (d, _g, a) => retention(d).disable(a) },
  'retention-hold-set': { level: 'ADMIN', page: 'data-retention', target: 'recordId', execute: (d, _g, a, b) => retention(d).setHold(a, holdDomain.parse(b.domain), numberId.parse(b.recordId)) },
  'retention-hold-clear': { level: 'ADMIN', page: 'data-retention', target: 'recordId', execute: (d, _g, a, b) => retention(d).clearHold(a, holdDomain.parse(b.domain), numberId.parse(b.recordId)) },
  'role-set': { level: 'GUILD_OWNER', page: 'roles', execute: async (d, g, a, b) => {
    const roleId = snowflake.parse(b.roleId);
    const guild = await d.client.guilds.fetch({ guild: g, force: true });
    const role = await guild.roles.fetch(roleId);
    const unsafe = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles |
      PermissionFlagsBits.MentionEveryone | PermissionFlagsBits.ManageWebhooks;
    if (!role || role.id === g || role.managed || !role.editable || role.permissions.any(unsafe))
      throw new AppError('VALIDATION', 'Choose a non-managed, hierarchy-safe staff role without dangerous permissions.');
    return d.services.permissions.setRole(a, roleId, z.enum(['HELPER', 'MODERATOR', 'SENIOR_MODERATOR', 'ADMIN']).parse(b.level), d.services.repository);
  }, target: 'roleId' },
  'role-remove': { level: 'GUILD_OWNER', page: 'roles', execute: (d, _g, a, b) => d.services.permissions.removeRole(a, snowflake.parse(b.roleId), d.services.repository), target: 'roleId' },
};
const confirmedActions = new Set(['module-toggle', 'moderation-warn', 'ticket-close', 'event-cancel', 'giveaway-end', 'analytics-toggle', 'role-set', 'role-remove',
  'automation-enable', 'automation-disable', 'automation-delete', 'automation-module-toggle', 'automation-reconcile-sent', 'automation-reconcile-not-sent',
  'retention-confirm', 'retention-disable', 'retention-hold-set', 'retention-hold-clear', 'privacy-confirm', 'privacy-execute', 'privacy-deny']);
const params = z.object({ guildId: snowflake, page: z.string().optional(), action: z.string().optional() });
function cookieHeader(raw: string | undefined, name: string): string | undefined { const part = raw?.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`)); return part?.slice(name.length + 1); }
function setCookie(reply: { setCookie(name: string, value: string, options: CookieValue['options']): unknown }, value: CookieValue) { reply.setCookie(value.name, value.value, value.options); }

/** Audit is written after the domain operation; if audit persistence fails the operation may already have committed. Never automatically retry that mutation. */
export async function createDashboardServer(deps: DashboardWebDeps): Promise<FastifyInstance> {
  if (!deps.baseUrl) throw new Error('Dashboard canonical baseUrl is required');
  const canonical = new URL(deps.baseUrl);
  if (!['http:', 'https:'].includes(canonical.protocol) || canonical.username || canonical.password || canonical.search || canonical.hash || canonical.pathname !== '/') throw new Error('Invalid dashboard baseUrl');
  const app = Fastify({ trustProxy: deps.trustProxy === true, bodyLimit: 32 * 1024, logger: false, requestIdHeader: false });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], styleSrc: ["'self'"], imgSrc: ["'self'"], baseUri: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"], scriptSrc: ["'none'"] } } });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request, reply) => { reply.header('cache-control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    const code = 'statusCode' in Object(error) ? (error as { statusCode?: number }).statusCode : undefined;
    const status = code === 413 || (error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 413 : code === 429 ? 429 : code === 415 ? 415 : error instanceof z.ZodError ? 400 : error instanceof AppError
      ? ({ PERMISSION: 403, NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409, DISABLED: 409, DATABASE: 500 } as const)[error.code] : 500;
    deps.logger?.error({ requestId: request.id, errorType: error instanceof Error ? error.name : 'unknown' }, 'Dashboard request failed');
    reply.code(status).type('text/plain; charset=utf-8').send(`${status === 403 ? 'Permission denied' : status === 404 ? 'Not found' : 'Request failed'} (${request.id})`);
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/assets/dashboard.css', async (_request, reply) => reply.header('cache-control', 'public, max-age=3600').type('text/css').send(dashboardCss()));
  app.get('/login', async (_request, reply) => reply.type('text/html').send(renderLogin()));
  app.get('/auth/discord', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_request, reply) => { const result = await deps.auth.startOAuth(); setCookie(reply, result.stateCookie); return reply.redirect(result.authorizationUrl); });
  app.get('/auth/callback', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const query = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(2048) }).parse(request.query);
      const state = deps.auth.clearStateCookie().name;
      const result = await deps.auth.completeOAuth(query.code, query.state, request.cookies[state]);
      await deps.auth.revokeSession(request.cookies[deps.auth.clearSessionCookie().name]);
      setCookie(reply, result.clearStateCookie); setCookie(reply, result.sessionCookie);
      return reply.redirect('/guilds');
    } catch { setCookie(reply, deps.auth.clearStateCookie()); return reply.code(400).type('text/html').send(renderLogin('Sign-in failed. Please try again.')); }
  });
  const sessionFor = async (request: { headers: { cookie?: string }; sessionCookie?: CookieValue }, reply?: { setCookie(name: string, value: string, options: CookieValue['options']): unknown }): Promise<Session | null> => {
    const raw = cookieHeader(request.headers.cookie, deps.auth.clearSessionCookie().name);
    const session = await deps.auth.getSession(raw);
    if (session && raw && reply) { const seconds = Math.max(0, Math.floor((Math.min(session.expiresAt.getTime(), session.absoluteExpiresAt.getTime()) - Date.now()) / 1000)); if (seconds > 0) reply.setCookie(deps.auth.clearSessionCookie().name, raw, { path: '/', httpOnly: true, sameSite: 'lax', secure: deps.secureCookies !== false, maxAge: seconds }); }
    return session;
  };
  const originValid = (request: { headers: { origin?: string } }): boolean => { try { const value = request.headers.origin; return !!value && new URL(value).origin === canonical.origin && value === canonical.origin; } catch { return false; } };
  app.post('/logout', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const raw = request.headers.cookie; const session = await sessionFor(request, reply);
    if (!session) return reply.code(401).send('Unauthorized');
    const body = bodySchema.parse(request.body);
    if (!originValid(request) || !deps.auth.verifyCsrf(cookieHeader(raw, deps.auth.clearSessionCookie().name), body.csrfToken ?? '')) return reply.code(403).send('Forbidden');
    await deps.auth.revokeSession(cookieHeader(raw, deps.auth.clearSessionCookie().name)); setCookie(reply, deps.auth.clearSessionCookie()); return reply.redirect('/login', 303);
  });
  app.get('/', async (request, reply) => reply.redirect(await sessionFor(request) ? '/guilds' : '/login'));
  app.get('/guilds', async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return reply.redirect('/login');
    const csrf = deps.auth.csrfToken(cookieHeader(request.headers.cookie, deps.auth.clearSessionCookie().name)) ?? '';
    return reply.type('text/html').send(renderGuildPicker(await deps.access.listAccessible(session), csrf));
  });
  app.get('/g/:guildId/:page', async (request, reply) => {
    const { guildId, page: rawPage } = params.parse(request.params);
    if (!pages.includes(rawPage as Page)) return reply.code(404).send('Not found');
    const page = rawPage as Page;
    const session = await sessionFor(request, reply); if (!session) return reply.redirect('/login');
    const actor = await deps.access.authorize(guildId, session, pageLevel[page]);
    const disabledModule = pageModule[page] && !await deps.services.modules.isEnabled(guildId, pageModule[page]) ? pageModule[page] : undefined;
    const currentGuild = await deps.client.guilds.fetch({ guild: guildId, force: true });
    if (!currentGuild || currentGuild.id !== guildId) return reply.code(403).send('Guild unavailable');
    const guildName = currentGuild.name;
    if (disabledModule) return reply.type('text/html').send(renderPage({ page, guildId, guildName,
      csrfToken: deps.auth.csrfToken(cookieHeader(request.headers.cookie, deps.auth.clearSessionCookie().name)) ?? '',
      actorLevel: await deps.services.permissions.resolve(actor), disabledModule }));
    let data: unknown;
    let retentionPreview: RetentionPreview | null = null;
    if (page === 'automations') {
      const query = z.object({ automationId: numberId.optional(), executionId: z.string().uuid().optional() }).strict().parse(request.query);
      const [moduleEnabled, rules, executions] = await Promise.all([
        deps.services.modules.isEnabled(guildId, 'automation'),
        deps.services.automation.list(actor),
        deps.services.automation.listRecentExecutions(actor, query.automationId, 50),
      ]);
      const selected = query.automationId ? await deps.services.automation.inspect(actor, query.automationId) : null;
      const selectedExecution = query.executionId ? await deps.services.automation.inspectExecution(actor, query.executionId) : null;
      if (selectedExecution && query.automationId && selectedExecution.automationId !== query.automationId)
        return reply.code(404).send('Not found');
      let channels: { id: string; name: string }[] = [];
      try { channels = await eligibleAutomationChannels(deps.client, guildId); }
      catch (error) { deps.logger?.error({ requestId: request.id, errorType: error instanceof Error ? error.name : 'unknown' },
        'Automation channel selection unavailable'); }
      data = { moduleEnabled, channels, rules, selected, executions, selectedExecution } satisfies AutomationDashboardView;
    }
    else if (page === 'data-retention') {
      if (!deps.retention) return reply.code(404).send('Not found');
      const query = z.object({ previewId: z.string().uuid().optional() }).strict().parse(request.query);
      const isGuildOwner = actor.userId === actor.guildOwnerId;
      const preview = query.previewId && isGuildOwner ? await deps.retention.getPreview(actor, query.previewId) : null;
      if (query.previewId && (!isGuildOwner || !preview || preview.guildId !== guildId || preview.requestedBy !== actor.userId)) return reply.code(404).send('Not found');
      data = await deps.retention.status(guildId);
      retentionPreview = preview;
    }
    else if (page === 'privacy') {
      if (!deps.subjectRequests) return reply.code(404).send('Not found');
      const parsedQuery = z.object({ requestId: privacyId.optional() }).strict().safeParse(request.query);
      if (!parsedQuery.success) return reply.code(404).send('Not found');
      const selectedId = parsedQuery.data.requestId;
      const selected = selectedId ? await deps.subjectRequests.inspect(actor, selectedId) : null;
      if (selectedId && !selected) return reply.code(404).send('Not found');
      if (selected && (selected.request.guildId !== guildId || selected.request.id !== selectedId ||
        selected.preview && (selected.preview.guildId !== guildId || selected.preview.requestId !== selectedId || selected.preview.subjectUserId !== selected.request.subjectUserId) ||
        selected.receipt && (selected.receipt.guildId !== guildId || selected.receipt.requestId !== selectedId || selected.receipt.subjectUserId !== selected.request.subjectUserId))) return reply.code(404).send('Not found');
      const [requests, receipts] = await Promise.all([deps.subjectRequests.list(actor), deps.subjectRequests.recentReceipts(actor)]);
      data = { requests: requests.filter(r => r.guildId === guildId).slice(0, 50), receipts: receipts.filter(r => r.guildId === guildId).slice(0, 50), selected } satisfies PrivacyDashboardView;
    }
    else if (page === 'analytics') {
      const { range } = z.object({ range: z.enum(['24h', '7d', '30d', '90d']).default('7d') }).parse(request.query);
      if (await deps.services.modules.isEnabled(guildId, 'analytics')) {
        const timezone = (await deps.services.guildConfig.get(guildId))?.timezone ?? 'UTC';
        data = { ...(await (deps.analytics ?? deps.services.analytics).summary(guildId, range, timezone) as object),
          currentMemberCount: currentGuild.memberCount };
      }
    }
    else if (page === 'members') {
      const query = z.object({ userId: snowflake.optional() }).parse(request.query);
      if (query.userId) {
        try {
          const guild = await deps.client.guilds.fetch({ guild: guildId, force: true });
          const member = await guild.members.fetch({ user: query.userId, force: true });
          if (!member || member.id !== query.userId || member.guild.id !== guildId) return reply.code(404).send('Not found');
          data = {
            member: { userId: member.id, username: member.user.username, joinedAt: member.joinedAt,
              permission: await deps.services.permissions.resolve({ userId: member.id, guildId,
                guildOwnerId: guild.ownerId, roleIds: [...member.roles.cache.keys()] }) },
            levels: await deps.read.memberLookup(guildId, [query.userId]),
            reputation: await deps.services.reputation.score(guildId, member.id),
            achievements: await deps.services.achievements.listMember(guildId, member.id),
          };
        } catch { return reply.code(403).send('Member lookup unavailable'); }
      } else data = [];
    }
    else if (page === 'overview') data = { identity: { id: guildId, name: guildName, memberCount: currentGuild.memberCount }, ...await deps.read.overview(guildId), analyticsEnabled: await deps.services.modules.isEnabled(guildId, 'analytics') };
    else if (page === 'moderation') {
      const query = z.object({ caseId: numberId.optional() }).parse(request.query);
      data = query.caseId ? { case: await deps.services.moderation.getCase(actor, query.caseId), reports: await deps.read.listReports(guildId) }
        : { cases: await deps.read.listCases(guildId), reports: await deps.read.listReports(guildId) };
    }
    else if (page === 'roles') data = await deps.read.roles(guildId);
    else if (page === 'tickets') data = await deps.read.tickets(guildId);
    else if (page === 'suggestions') data = await deps.read.suggestions(guildId);
    else if (page === 'levels') data = await deps.read.levels(guildId);
    else if (page === 'events') data = await deps.read.events(guildId);
    else if (page === 'giveaways') data = await deps.read.giveaways(guildId);
    else data = await deps.read.botSettings(guildId);
    const query = request.query as { range?: string; userId?: string };
    return reply.type('text/html').send(renderPage({ page, guildId, guildName,
      csrfToken: deps.auth.csrfToken(cookieHeader(request.headers.cookie, deps.auth.clearSessionCookie().name)) ?? '', data,
      analyticsEnabled: page !== 'analytics' || await deps.services.modules.isEnabled(guildId, 'analytics'),
      actorLevel: await deps.services.permissions.resolve(actor),
      range: page === 'analytics' && ['24h', '7d', '30d', '90d'].includes(query.range ?? '') ? query.range : undefined,
      userId: page === 'members' && snowflake.safeParse(query.userId).success ? query.userId : undefined,
      retentionPreview,
      isGuildOwner: (page === 'data-retention' || page === 'privacy') && actor.userId === actor.guildOwnerId,
    }));
  });
  app.post('/g/:guildId/action/:action', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = params.safeParse(request.params); if (!parsed.success) return reply.code(404).send('Not found');
    const { guildId, action: name } = parsed.data; const action = actions[name ?? '']; if (!action) return reply.code(404).send('Not found');
    const raw = request.headers.cookie; const session = await sessionFor(request, reply); if (!session) return reply.code(401).send('Unauthorized');
    let actor: Actor | undefined; let succeeded = false; let attempted = false; let privacyAuditTarget: string | undefined;
    try {
      const body = (automationMutation.has(name!) ? automationBodySchema : privacyActions.has(name!) ? privacyBodySchema : bodySchema).parse(request.body) as Record<string, string>;
      if (!originValid(request) || !deps.auth.verifyCsrf(cookieHeader(raw, deps.auth.clearSessionCookie().name), body.csrfToken ?? '') ||
        (confirmedActions.has(name!) && body.confirm !== 'yes')) return reply.code(403).send('Forbidden');
      actor = await deps.access.authorize(guildId, session, action.level);
      if ((retentionActions.has(name!) || privacyOwnerActions.has(name!)) && actor.userId !== actor.guildOwnerId) return reply.code(403).send('Forbidden');
      if (action.module && !await deps.services.modules.isEnabled(guildId, action.module)) return reply.code(404).send('Not found');
      if (privacyActions.has(name!)) privacyAuditTarget = privacyId.parse(body.requestId);
      attempted = true;
      const outcome = await action.execute(deps, guildId, actor, body); succeeded = true;
      const targetId = privacyActions.has(name!) ? privacyId.parse(body.requestId) : name === 'retention-preview' ? z.string().uuid().parse((outcome as RetentionPreview).id) :
        name === 'retention-confirm' ? z.string().uuid().parse(body.previewId) :
        name === 'retention-hold-set' || name === 'retention-hold-clear' ? `${holdDomain.parse(body.domain)}-${numberId.parse(body.recordId)}` :
        name === 'automation-create' && outcome && typeof outcome === 'object' && 'id' in outcome &&
        numberId.safeParse(outcome.id).success ? String(outcome.id) :
        name === 'automation-module-toggle' ? 'automation' :
        name?.startsWith('automation-reconcile-') ? `${body.executionId}:${body.position}` : action.target ? body[action.target] : undefined;
      const auditAction = name === 'retention-preview' ? 'retention-preview-created' : name === 'retention-confirm' ?
        (outcome as { previousEnabled?: boolean }).previousEnabled === true ? 'retention-policy-changed' : 'retention-policy-enabled' :
        name === 'retention-disable' ? 'retention-policy-disabled' : name === 'retention-hold-set' ? 'retention-hold-set' :
          name === 'retention-hold-clear' ? 'retention-hold-cleared' : name!;
      try { await deps.audit.record({ guildId, actorUserId: actor.userId, action: auditAction, targetType: name!, targetId, success: true, requestId: request.id }); }
      catch (auditError) {
        deps.logger?.error({ requestId: request.id, ...(governanceActions.has(name!) ? { action: name } : {}), errorType: auditError instanceof Error ? auditError.name : 'unknown' }, 'Dashboard success audit persistence failed');
        if (governanceActions.has(name!)) {
          if (deps.subjectRequests?.recordAuditGap) {
            try { await deps.subjectRequests.recordAuditGap({ guildId, actorUserId: actor.userId, action: name as GovernanceAction, targetType: name!, targetId, requestId: request.id }); }
            catch (gapError) { deps.logger?.error({ requestId: request.id, action: name, errorType: gapError instanceof Error ? gapError.name : 'unknown' }, 'Dashboard audit gap persistence failed'); }
          } else deps.logger?.error({ requestId: request.id, action: name, errorType: 'AuditGapUnavailable' }, 'Dashboard audit gap persistence unavailable');
        }
      }
      return reply.redirect(`/g/${guildId}/${action.page}${privacyActions.has(name!) ? `?requestId=${encodeURIComponent(privacyId.parse(body.requestId))}` : name === 'retention-preview' ? `?previewId=${encodeURIComponent((outcome as RetentionPreview).id)}` : ''}`, 303);
    } catch (error) {
      if (attempted && !succeeded && actor) {
        try { await deps.audit.record({ guildId, actorUserId: actor.userId, action: name!, targetType: name!, ...(privacyAuditTarget ? { targetId: privacyAuditTarget } : {}), success: false, requestId: request.id }); }
        catch (auditError) { deps.logger?.error({ requestId: request.id, errorType: auditError instanceof Error ? auditError.name : 'unknown' }, 'Dashboard failure audit persistence failed'); }
      }
      deps.logger?.error({ requestId: request.id, errorType: error instanceof Error ? error.name : 'unknown', postMutationAuditFailure: succeeded }, 'Dashboard mutation failed');
      const status = error instanceof z.ZodError || error instanceof AppError && error.code === 'VALIDATION' ? 400 :
        error instanceof AppError && error.code === 'PERMISSION' ? 403 :
        error instanceof AppError && error.code === 'NOT_FOUND' ? 404 :
        error instanceof AppError && ['DISABLED', 'CONFLICT'].includes(error.code) ? 409 : 500;
      return reply.code(status).type('text/plain').send(`Action failed (${request.id})${succeeded ? '; action may have completed, check status before retrying' : ''}`);
    }
  });
  return app;
}
