import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../core/errors/errors.js';
import { createDashboardServer } from './web.js';
import { brandMark } from './brand.js';

const guildId = '123456789012345678';
const foreignId = '999999999999999999';
const channelId = '234567890123456789';
const token = 'a'.repeat(64);
const origin = 'https://dashboard.example';
const headers = { cookie: `dashboard_session=${token}`, host: 'dashboard.example', origin };
const executionId = '12345678-1234-4234-8234-123456789abc';
const actor = { guildId, userId: guildId, guildOwnerId: guildId, roleIds: [] };
const date = new Date('2027-01-01T00:00:00.000Z');
const draft = { csrfToken: 'csrf', name: 'Morning', scheduleKind: 'daily', dailyTime: '09:00', timezone: 'UTC', cooldownSeconds: '0', enabled: 'true', action0Type: 'STATIC_MESSAGE', action0ChannelId: channelId, action0Message: 'Hello', action1Type: 'NONE' };
const rule = { id: 7, name: 'Morning', enabled: true, triggerKey: 'SCHEDULED', triggerVersion: 1, triggerConfig: { kind: 'daily', time: '09:00' }, timezone: 'UTC', nextRunAt: date, configVersion: 1, updatedAt: date, authorizedBy: guildId, cooldownSeconds: 0, actionKeys: ['STATIC_MESSAGE'], actions: [{ position: 0, actionKey: 'STATIC_MESSAGE', actionVersion: 1, config: { channelId, message: 'Hello' } }] };
const execution = { id: executionId, automationId: 7, automationName: 'Morning', triggerKey: 'SCHEDULED', status: 'UNCERTAIN', attempts: 1, createdAt: date, completedAt: null, safeErrorCode: 'SEND_UNKNOWN', configVersion: 1, moduleEpoch: 2, actions: [{ position: 0, actionKey: 'STATIC_MESSAGE', actionVersion: 1, status: 'UNCERTAIN', attempts: 1, discordMessageId: '345678901234567890', safeErrorCode: 'SEND_UNKNOWN', updatedAt: date, reconciliationResult: null, reconciledBy: null, reconciledAt: null }], reconciliation: [{ position: 0, allowSent: true, allowNotSent: false }] };
function fixture() {
  let level = 'ADMIN';
  const rank: Record<string, number> = { HELPER: 0, MODERATOR: 1, ADMIN: 2 };
  const authorize = vi.fn(async (id: string, _session: unknown, required: string) => {
    if (id !== guildId || rank[level]! < rank[required]!) throw new AppError('PERMISSION', 'Denied');
    return actor;
  });
  const channel = { id: channelId, name: 'announcements', guildId, type: ChannelType.GuildText, permissionsFor: vi.fn(() => ({ has: vi.fn((permission: bigint) => permission === PermissionFlagsBits.ViewChannel || permission === PermissionFlagsBits.SendMessages) })) };
  const guild = { id: guildId, name: 'Guild', channels: { fetch: vi.fn(async (id?: string) => id ? (id === channel.id ? channel : null) : new Map([[channel.id, channel]])) }, members: { fetch: vi.fn(async () => ({ id: guildId, guild: { id: guildId } })) } };
  const automation = { create: vi.fn(async (_currentActor: unknown, _ruleDraft: unknown) => ({ id: 7 })), update: vi.fn(async () => rule), setEnabled: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), list: vi.fn(async () => [rule]), inspect: vi.fn(async () => rule), listRecentExecutions: vi.fn(async () => [execution]), inspectExecution: vi.fn(async () => execution), reconcile: vi.fn(async () => undefined) };
  const modules = { isEnabled: vi.fn(async () => false), setEnabled: vi.fn(async () => undefined) };
  const audit = vi.fn(async () => undefined);
  const auth = { getSession: vi.fn(async (raw: string) => raw === token ? { userId: guildId, oauthGuildIds: [guildId], expiresAt: new Date(Date.now() + 86400000), absoluteExpiresAt: new Date(Date.now() + 86400000) } : null), csrfToken: vi.fn(() => 'csrf'), verifyCsrf: vi.fn((raw: string, value: string) => raw === token && value === 'csrf'), clearSessionCookie: () => ({ name: 'dashboard_session' }) };
  const deps = { client: { user: { id: guildId }, guilds: { fetch: vi.fn(async () => guild) } }, services: { automation, modules, permissions: { resolve: vi.fn(async () => level) } }, auth, access: { authorize }, read: { overview: vi.fn(async () => ({ items: [] })) }, audit: { record: audit }, secureCookies: true, baseUrl: origin };
  return { deps: deps as never, automation, modules, audit, authorize, auth, channel, guild, setLevel: (value: string) => { level = value; } };
}
async function setup() { const f = fixture(); return { ...f, app: await createDashboardServer(f.deps) }; }
const post = (app: Awaited<ReturnType<typeof createDashboardServer>>, action: string, payload: Record<string, string> = draft, id = guildId, h: { cookie?: string; host: string; origin: string } = headers) => app.inject({ method: 'POST', url: `/g/${id}/action/${action}`, headers: h, payload });

describe('automation dashboard HTTP boundary', () => {
  it('shows ADMIN navigation and management while automation module is disabled', async () => { const f = await setup(); const page = await f.app.inject({ url: `/g/${guildId}/automations`, headers }); expect(page.statusCode).toBe(200); expect(page.body).toContain('Automation module: Disabled'); expect(page.body).toContain('Create automation'); expect(f.automation.list).toHaveBeenCalledWith(actor); expect((await f.app.inject({ url: `/g/${guildId}/overview`, headers })).body).toContain('/automations'); await f.app.close(); });
  it('denies MODERATOR page and mutation', async () => { const f = await setup(); f.setLevel('MODERATOR'); expect((await f.app.inject({ url: `/g/${guildId}/automations`, headers })).statusCode).toBe(403); expect((await post(f.app, 'automation-create')).statusCode).toBe(403); expect(f.automation.create).not.toHaveBeenCalled(); await f.app.close(); });
  it('redirects unauthenticated reads and denies writes', async () => { const f = await setup(); expect((await f.app.inject(`/g/${guildId}/automations`)).statusCode).toBe(302); expect((await post(f.app, 'automation-create', draft, guildId, { host: 'dashboard.example', origin })).statusCode).toBe(401); await f.app.close(); });
  it('denies wrong guild on reads and writes', async () => { const f = await setup(); expect((await f.app.inject({ url: `/g/${foreignId}/automations`, headers })).statusCode).toBe(403); expect((await post(f.app, 'automation-create', draft, foreignId)).statusCode).toBe(403); expect(f.automation.create).not.toHaveBeenCalled(); await f.app.close(); });
  it('checks current permission again after revocation', async () => { const f = await setup(); expect((await f.app.inject({ url: `/g/${guildId}/automations`, headers })).statusCode).toBe(200); f.setLevel('MODERATOR'); expect((await post(f.app, 'automation-create')).statusCode).toBe(403); expect(f.automation.create).not.toHaveBeenCalled(); await f.app.close(); });
  it('creates daily rule through REST target preflight without sending', async () => {
    const f = await setup();
    const response = await post(f.app, 'automation-create');
    expect(response.statusCode).toBe(303);
    expect(f.automation.create.mock.calls[0]?.[1]).toMatchObject({
      config: { trigger: { id: 'SCHEDULED', version: 1, config: { kind: 'daily', time: '09:00', timezone: 'UTC' } } },
    });
    expect(f.guild.channels.fetch).toHaveBeenCalledWith(channelId, { force: true });
    expect(f.guild.members.fetch).toHaveBeenCalledWith({ user: guildId, force: true });
    await f.app.close();
  });
  it('creates once rule with two action types and exact 1000 mention-shaped characters', async () => { const f = await setup(); const message = '<@everyone>'.repeat(90) + 'x'.repeat(10); expect(message.length).toBe(1000); const response = await post(f.app, 'automation-create', { ...draft, scheduleKind: 'once', onceAt: '2027-01-02T09:00:00.000Z', action0Message: message, action1Type: 'STAFF_LOG', action1ChannelId: channelId, action1Message: '<@123456789012345678>' }); expect(response.statusCode).toBe(303); expect(f.automation.create.mock.calls[0]?.[1]).toMatchObject({ config: { trigger: { config: { kind: 'once', at: '2027-01-02T09:00:00.000Z' } }, actions: [{ config: { message } }, { id: 'STAFF_LOG', config: { message: '<@123456789012345678>' } }] } }); await f.app.close(); });
  it.each([{ action0Message: 'x'.repeat(1001) }, { action2Type: 'STATIC_MESSAGE' }, { action0Type: 'AI' }, { scheduleKind: 'weekly' }, { dailyTime: '25:99' }, { timezone: '' }])('rejects malformed draft %j without service mutation', async (change) => { const f = await setup(); expect((await post(f.app, 'automation-create', { ...draft, ...change } as Record<string, string>)).statusCode).toBe(400); expect(f.automation.create).not.toHaveBeenCalled(); await f.app.close(); });
  it.each(['foreign', 'non-text', 'no-send'])('rejects %s channel before invoking service', async (kind) => { const f = await setup(); if (kind === 'foreign') f.channel.guildId = foreignId; if (kind === 'non-text') f.channel.type = ChannelType.GuildVoice; if (kind === 'no-send') f.channel.permissionsFor.mockReturnValue({ has: vi.fn((bit: bigint) => bit !== PermissionFlagsBits.SendMessages) }); expect((await post(f.app, 'automation-create')).statusCode).toBe(400); expect(f.automation.create).not.toHaveBeenCalled(); await f.app.close(); });
  it('rejects missing CSRF and cross-origin request', async () => { const f = await setup(); expect((await post(f.app, 'automation-create', { ...draft, csrfToken: 'bad' })).statusCode).toBe(403); expect((await post(f.app, 'automation-create', draft, guildId, { ...headers, origin: 'https://evil.example' })).statusCode).toBe(403); expect(f.automation.create).not.toHaveBeenCalled(); await f.app.close(); });
  it('delegates IANA timezone rejection to AutomationService without leaking details', async () => {
    const f = await setup();
    f.automation.create.mockRejectedValueOnce(new AppError('VALIDATION', 'Invalid automation timezone'));
    const response = await post(f.app, 'automation-create', { ...draft, timezone: 'Mars/Phobos' });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('Mars/Phobos');
    expect(f.automation.create).toHaveBeenCalledTimes(1);
    await f.app.close();
  });
  it('updates selected guild-scoped rule exactly once', async () => { const f = await setup(); expect((await post(f.app, 'automation-update', { ...draft, automationId: '7' })).statusCode).toBe(303); expect(f.automation.inspect).toHaveBeenCalledExactlyOnceWith(actor, 7); expect(f.automation.update).toHaveBeenCalledExactlyOnceWith(actor, 7, expect.any(Object)); await f.app.close(); });
  it('escapes hostile rule, message, guild and channel labels', async () => { const f = await setup(); f.guild.name = '<svg onload=alert(1)>'; f.channel.name = '<img src=x>'; f.automation.list.mockResolvedValueOnce([{ ...rule, name: '<script>alert(1)</script>' }]); f.automation.inspect.mockResolvedValueOnce({ ...rule, name: '<script>alert(1)</script>', actions: [{ ...rule.actions[0]!, config: { channelId, message: '<img src=x onerror=alert(2)>' } }] }); const page = await f.app.inject({ url: `/g/${guildId}/automations?automationId=7`, headers }); expect(page.statusCode).toBe(200); for (const text of ['&lt;svg', '&lt;script&gt;', '&lt;img']) expect(page.body).toContain(text); expect(page.body.split(brandMark)).toHaveLength(2); expect(page.body.replaceAll(brandMark, '')).not.toMatch(/<svg|<script|<img src=x/i); await f.app.close(); });
  it.each([['automation-enable', 'setEnabled', true], ['automation-disable', 'setEnabled', false], ['automation-delete', 'delete', null]] as const)('%s requires confirmation and calls service once', async (action, method, enabled) => { const f = await setup(); const payload = { csrfToken: 'csrf', automationId: '7' }; expect((await post(f.app, action, payload)).statusCode).toBe(403); expect((await post(f.app, action, { ...payload, confirm: 'yes' })).statusCode).toBe(303); if (method === 'setEnabled') expect(f.automation.setEnabled).toHaveBeenCalledExactlyOnceWith(actor, 7, enabled); else expect(f.automation.delete).toHaveBeenCalledExactlyOnceWith(actor, 7); await f.app.close(); });
  it('toggles only the Automation module after CSRF, Origin, ADMIN and confirmation', async () => {
    const f = await setup();
    const payload = { csrfToken: 'csrf', enabled: 'true', module: 'analytics' };
    expect((await post(f.app, 'automation-module-toggle', payload)).statusCode).toBe(403);
    expect((await post(f.app, 'automation-module-toggle', { ...payload, confirm: 'yes' })).statusCode).toBe(303);
    expect(f.modules.setEnabled).toHaveBeenCalledExactlyOnceWith(guildId, 'automation', true, guildId);
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'automation', success: true }));
    await f.app.close();
  });
  it('renders status, execution ID, receipt and uncertainty warning without Retry', async () => { const f = await setup(); const page = await f.app.inject({ url: `/g/${guildId}/automations?executionId=${executionId}`, headers }); expect(page.statusCode).toBe(200); for (const text of [executionId, 'UNCERTAIN', '345678901234567890', 'will not resend automatically', 'SEND_UNKNOWN']) expect(page.body).toContain(text); expect(page.body).not.toMatch(/>Retry</i); expect(page.body).toContain('automation-reconcile-sent'); expect(page.body).not.toContain('automation-reconcile-not-sent'); await f.app.close(); });
  it.each([['automation-reconcile-sent', 'CONFIRMED_SENT'], ['automation-reconcile-not-sent', 'CONFIRMED_NOT_SENT']] as const)('%s requires confirmation and records only reconciliation', async (action, outcome) => { const f = await setup(); const payload = { csrfToken: 'csrf', executionId, automationId: '7', position: '0' }; expect((await post(f.app, action, payload)).statusCode).toBe(403); expect((await post(f.app, action, { ...payload, confirm: 'yes' })).statusCode).toBe(303); expect(f.automation.reconcile).toHaveBeenCalledExactlyOnceWith(actor, executionId, 0, outcome); expect(f.automation.create).not.toHaveBeenCalled(); await f.app.close(); });
  it('rejects mismatched execution automation and foreign guild reconciliation', async () => { const f = await setup(); const payload = { csrfToken: 'csrf', executionId, automationId: '8', position: '0', confirm: 'yes' }; expect((await post(f.app, 'automation-reconcile-sent', payload)).statusCode).toBe(404); expect((await post(f.app, 'automation-reconcile-sent', { ...payload, automationId: '7' }, foreignId)).statusCode).toBe(403); expect(f.automation.reconcile).not.toHaveBeenCalled(); await f.app.close(); });
  it('does not offer reconciliation for ineligible action and refuses stale POST', async () => {
    const f = await setup();
    f.automation.inspectExecution.mockResolvedValueOnce({ ...execution, reconciliation: [] });
    const page = await f.app.inject({ url: `/g/${guildId}/automations?executionId=${executionId}`, headers });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('/action/automation-reconcile-sent');
    f.automation.reconcile.mockRejectedValueOnce(new AppError('NOT_FOUND', 'Uncertain action not found'));
    const response = await post(f.app, 'automation-reconcile-sent', { csrfToken: 'csrf', executionId, automationId: '7', position: '0', confirm: 'yes' });
    expect(response.statusCode).toBe(404);
    expect(f.automation.reconcile).toHaveBeenCalledTimes(1);
    await f.app.close();
  });
  it('audits only safe metadata and excludes static message contents', async () => { const f = await setup(); const secret = 'private-message-<@everyone>'; expect((await post(f.app, 'automation-create', { ...draft, action0Message: secret })).statusCode).toBe(303); expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ guildId, actorUserId: guildId, action: 'automation-create', targetId: '7', success: true, requestId: expect.any(String) })); expect(JSON.stringify(f.audit.mock.calls)).not.toContain(secret); await f.app.close(); });
  it('does not repeat mutation if audit persistence fails or leak error details', async () => { const f = await setup(); f.audit.mockRejectedValueOnce(new Error('database password=secret')); const result = await post(f.app, 'automation-create'); expect(result.statusCode).toBe(303); expect(f.automation.create).toHaveBeenCalledTimes(1); expect(result.body).not.toContain('database password'); await f.app.close(); });
});
