import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SubjectRequestService } from '../modules/subject-requests/service.js';
import { AppError } from '../core/errors/errors.js';
import type { AuditGapInput, ReceiptView, SubjectRequestView, PreviewView } from '../modules/subject-requests/contracts.js';
import { createDashboardServer } from './web.js';
import { DashboardAudit, type DashboardAuditEntry } from './access/dashboard-audit.js';
import { renderPrivacyDashboard, type PrivacyInspection } from './privacy-ui.js';
import { renderPage } from './ui.js';

const guildId = '123456789012345678';
const otherGuild = '999999999999999999';
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const previewId = '123e4567-e89b-42d3-a456-426614174001';
const owner = { guildId, userId: '234567890123456789', guildOwnerId: '234567890123456789', roleIds: [] as string[] };
const now = '2026-09-01T00:00:00.000Z';
const request: SubjectRequestView = { id: requestId, guildId, subjectUserId: '345678901234567890', status: 'PREVIEWED', version: 1, requestedAt: now, subjectVerifiedAt: now, verificationMethod: 'SELF_GUILD_MEMBER', previewedBy: owner.userId, previewedAt: now, confirmedBy: null, confirmedAt: null, confirmedPreviewId: null, executedAt: null, deniedBy: null, deniedAt: null, denialCode: null, terminalAt: null };
const inventory = { counts: [{ category: 'MEMBER_LEVEL_STATE' as const, disposition: 'ERASE' as const, count: 2 }, { category: 'MODERATION_ACCOUNTABILITY' as const, disposition: 'RETAIN' as const, count: 3 }], eligibleTotal: 2, retainedTotal: 3, hash: 'synthetic-inventory-hash' };
const preview: PreviewView = { ...inventory, id: previewId, requestId, guildId, subjectUserId: request.subjectUserId, reviewedBy: owner.userId, requestVersion: 1, createdAt: now, expiresAt: now, consumedAt: null };
const receipt: ReceiptView = { requestId, guildId, subjectUserId: request.subjectUserId, confirmedBy: owner.userId, executedBy: owner.userId, inventoryHash: inventory.hash, executedAt: now, outcome: 'PARTIAL', requestVersion: 2, deleted: { memberLevels: 2, memberReputation: 0, achievements: 0, eventParticipants: 0, eventAttendance: 0 }, retainedTotal: 3 };
const inspection: PrivacyInspection = { request, inventory, preview, receipt, workflowEvidence: 'Current request workflow evidence remains separately retained.', auditGaps: [] };
const headers = { cookie: 'dashboard_session=valid', origin: 'https://dashboard.example' };
const phrases = { 'privacy-confirm': 'CONFIRM PRIVACY REQUEST', 'privacy-execute': 'ERASE ELIGIBLE DATA', 'privacy-deny': 'DENY PRIVACY REQUEST' } as const;
const payload = (action: string) => ({ csrfToken: 'csrf', requestId, previewId, confirm: 'yes', phrase: phrases[action as keyof typeof phrases] ?? '', denialCode: 'POLICY_RETAINED', body: 'SYNTHETIC_PRIVATE_BODY' });
function setup() {
  let actor = owner; let rank = 'ADMIN';
  const access = { authorize: vi.fn(async () => actor), listAccessible: vi.fn(async () => []) };
  const subjectRequests = { list: vi.fn(async () => [request]), inspect: vi.fn(async () => inspection), recentReceipts: vi.fn(async () => [receipt]), preview: vi.fn(async () => preview), confirm: vi.fn(async () => request), execute: vi.fn(async () => ({ request, receipt })), deny: vi.fn(async () => request), recordAuditGap: vi.fn(async (_input: AuditGapInput): Promise<void> => undefined) };
  const retention = { status: vi.fn(async () => ({})), getPreview: vi.fn(async () => null), preview: vi.fn(async () => ({ id: previewId })), confirm: vi.fn(async () => ({})), disable: vi.fn(async () => ({})), setHold: vi.fn(async () => ({})), clearHold: vi.fn(async () => ({})) };
  const audit = { record: vi.fn(async (_input: DashboardAuditEntry): Promise<void> => undefined) };
  const logger = { error: vi.fn() };
  const auth = { clearSessionCookie: () => ({ name: 'dashboard_session', value: '', options: { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: true, maxAge: 0 } }), getSession: vi.fn(async () => ({ userId: actor.userId, expiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 60_000) })), csrfToken: () => 'csrf', verifyCsrf: (_raw: string, token: string) => token === 'csrf' };
  const deps = { client: { guilds: { fetch: async () => ({ id: guildId, name: '<Synthetic guild>', memberCount: 1 }) } }, services: { permissions: { resolve: async () => rank }, modules: { isEnabled: async () => true } }, auth, access, read: {}, audit, logger, retention, subjectRequests, baseUrl: 'https://dashboard.example' };
  return { deps: deps as never, subjectRequests, retention, audit, logger, access, setActor: (value: typeof owner, level = 'ADMIN') => { actor = value; rank = level; } };
}

// Bounded source fallback: real service/repository code, with a deliberately narrow
// transaction adapter. Any unexpected query fails, rather than simulating success.
function rejectedStateService(status: SubjectRequestView['status']) {
  const row = { id: requestId, guild_id: guildId, subject_user_id: request.subjectUserId, status, version: 1, requested_at: now, subject_verified_at: now, previewed_by: null, previewed_at: null, confirmed_by: null, confirmed_at: null, confirmed_preview_id: null, executed_at: null, denied_by: status === 'DENIED' ? owner.userId : null, denied_at: status === 'DENIED' ? now : null, denial_code: status === 'DENIED' ? 'POLICY_RETAINED' : null, terminal_at: status === 'DENIED' ? now : null };
  const dialect = new PgDialect();
  const queries: string[] = [];
  const execute = vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const compiled = dialect.sqlToQuery(query); queries.push(compiled.sql);
    if (compiled.sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
    if (compiled.sql.includes('FROM subject_requests WHERE') && compiled.sql.trimEnd().endsWith('FOR UPDATE')) {
      expect(compiled.params).toEqual([guildId, requestId]);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    throw new Error('Unexpected query in rejected-state transaction');
  });
  const transaction = vi.fn(async (action: (tx: { execute: typeof execute }) => Promise<unknown>) => action({ execute }));
  const require = vi.fn(async () => undefined);
  return { service: new SubjectRequestService({ execute, transaction } as never, { require } as never), queries, row, transaction, require };
}

describe('reviewed privacy dashboard', () => {
  it.each(['PENDING', 'PREVIEWED', 'CONFIRMED', 'EXECUTING', 'COMPLETED', 'PARTIAL', 'DENIED'] as const)('gates SSR controls by %s and actual owner identity, not rank', async status => {
    for (const isOwner of [false, true]) {
      for (const rank of ['ADMIN', 'BOT_OWNER', 'GUILD_OWNER']) {
        const f = setup(); f.setActor(isOwner ? owner : { ...owner, userId: '456789012345678901' }, rank);
        f.subjectRequests.inspect.mockResolvedValue({ ...inspection, request: { ...request, status } });
        const app = await createDashboardServer(f.deps);
        const result = await app.inject({ url: `/g/${guildId}/privacy?requestId=${requestId}`, headers });
        expect(result.statusCode).toBe(200);
        const allowed = new Set<string>();
        if (status === 'PENDING' || status === 'PREVIEWED') allowed.add('privacy-preview');
        if (isOwner && status === 'PREVIEWED') allowed.add('privacy-confirm');
        if (isOwner && status === 'CONFIRMED') allowed.add('privacy-execute');
        if (isOwner && ['PENDING', 'PREVIEWED', 'CONFIRMED'].includes(status)) allowed.add('privacy-deny');
        for (const action of ['privacy-preview', ...Object.keys(phrases)]) expect(result.body.includes(`action/${action}`)).toBe(allowed.has(action));
        if (status === 'PREVIEWED') expect(result.body).toContain('Refresh preview');
        expect(f.subjectRequests.execute).not.toHaveBeenCalled();
        await app.close();
      }
    }
  });
  it.each([
    ['DENIED', 'privacy-execute'], ['PENDING', 'privacy-execute'],
    ['PREVIEWED', 'privacy-execute'], ['CONFIRMED', 'privacy-preview'],
  ] as const)('crafted owner %s %s fails through the real service with accurate failure audit', async (status, action) => {
    const f = setup(); const real = rejectedStateService(status);
    const before = { ...real.row };
    const operation = action === 'privacy-preview' ? 'preview' : 'execute';
    const spy = vi.spyOn(real.service, operation);
    const gap = vi.spyOn(real.service, 'recordAuditGap');
    (f.deps as { subjectRequests: unknown }).subjectRequests = real.service;
    const app = await createDashboardServer(f.deps);
    const result = await app.inject({ method: 'POST', url: `/g/${guildId}/action/${action}`, headers, payload: payload(action) });
    expect(result.statusCode).toBe(409); expect(result.headers.location).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1); expect(real.transaction).toHaveBeenCalledTimes(1);
    expect(f.audit.record).toHaveBeenCalledTimes(1);
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ guildId, actorUserId: owner.userId, action, targetType: action, targetId: requestId, success: false }));
    expect(gap).not.toHaveBeenCalled(); expect(real.row).toEqual(before);
    expect(real.queries).toHaveLength(3);
    expect(real.queries.join('\n')).not.toMatch(/INSERT|UPDATE subject_requests SET|DELETE|subject_execution_receipts/);
    await app.close();
  });
  it.each(['ADMIN', 'BOT_OWNER', 'GUILD_OWNER'])('denies crafted destructive POSTs from nonowner even with %s rank', async rank => {
    const f = setup(); f.setActor({ ...owner, userId: '456789012345678901', roleIds: ['567890123456789012'] }, rank);
    const app = await createDashboardServer(f.deps);
    for (const action of Object.keys(phrases)) {
      expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/${action}`, headers, payload: payload(action) })).statusCode).toBe(403);
    }
    for (const name of ['confirm', 'execute', 'deny'] as const) expect(f.subjectRequests[name]).not.toHaveBeenCalled();
    expect(f.access.authorize).toHaveBeenCalledTimes(3);
    expect(f.access.authorize).toHaveBeenCalledWith(guildId, expect.anything(), 'ADMIN');
    await app.close();
  });
  it('rechecks fresh owner identity after a prior owner page view', async () => {
    const f = setup(); const app = await createDashboardServer(f.deps);
    f.subjectRequests.inspect.mockResolvedValue({ ...inspection, request: { ...request, status: 'CONFIRMED' } });
    expect((await app.inject({ url: `/g/${guildId}/privacy?requestId=${requestId}`, headers })).body).toContain('action/privacy-execute');
    f.setActor({ ...owner, guildOwnerId: '456789012345678901' }, 'BOT_OWNER');
    expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/privacy-execute`, headers, payload: payload('privacy-execute') })).statusCode).toBe(403);
    expect(f.subjectRequests.execute).not.toHaveBeenCalled(); await app.close();
  });
  it('allows ADMIN metadata reads and preview without owner-only controls or automatic erasure', async () => {
    const f = setup(); f.setActor({ ...owner, userId: '456789012345678901' }); const app = await createDashboardServer(f.deps);
    const result = await app.inject({ url: `/g/${guildId}/privacy?requestId=${requestId}`, headers });
    expect(result.statusCode).toBe(200); expect(result.body).toContain('SELF_GUILD_MEMBER'); expect(result.body).toContain('action/privacy-preview');
    for (const action of Object.keys(phrases)) expect(result.body).not.toContain(`action/${action}`);
    const post = await app.inject({ method: 'POST', url: `/g/${guildId}/action/privacy-preview`, headers, payload: payload('privacy-preview') });
    expect(post.statusCode).toBe(303); expect(post.headers.location).toBe(`/g/${guildId}/privacy?requestId=${requestId}`);
    expect(f.subjectRequests.preview).toHaveBeenCalledWith(expect.objectContaining({ userId: '456789012345678901' }), requestId);
    expect(f.subjectRequests.execute).not.toHaveBeenCalled(); await app.close();
  });
  it('fresh authorization fails closed and does not call a domain operation', async () => {
    const f = setup(); f.access.authorize.mockRejectedValueOnce(new AppError('PERMISSION', 'Discord Administrator alone is insufficient'));
    const app = await createDashboardServer(f.deps);
    expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/privacy-preview`, headers, payload: payload('privacy-preview') })).statusCode).toBe(403);
    expect(f.subjectRequests.preview).not.toHaveBeenCalled(); await app.close();
  });
  it('requires same Origin, CSRF, bounded fields and valid request UUID', async () => {
    const f = setup(); const app = await createDashboardServer(f.deps); const url = `/g/${guildId}/action/privacy-preview`;
    for (const origin of ['', 'https://evil.example', 'https://dashboard.example/path']) expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin }, payload: payload('privacy-preview') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload('privacy-preview'), csrfToken: 'bad' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload('privacy-preview'), requestId: 'bad' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload('privacy-preview'), body: 'x'.repeat(501) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload('privacy-preview'), ...Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`extra${i}`, 'x'])) } })).statusCode).toBe(400);
    expect(f.subjectRequests.preview).not.toHaveBeenCalled(); await app.close();
  });
  it.each(Object.entries(phrases))('requires checkbox plus exact phrase for %s and validates fixed denial code', async (action, phrase) => {
    const f = setup(); const app = await createDashboardServer(f.deps); const url = `/g/${guildId}/action/${action}`;
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload(action), confirm: '' } })).statusCode).toBe(403);
    for (const value of ['', phrase.toLowerCase(), `${phrase} `]) expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload(action), phrase: value } })).statusCode).toBe(400);
    if (action === 'privacy-deny') expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload(action), denialCode: 'free text' } })).statusCode).toBe(400);
    const method = action.replace('privacy-', '') as 'confirm' | 'execute' | 'deny';
    expect(f.subjectRequests[method]).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url, headers, payload: payload(action) })).statusCode).toBe(303);
    expect(f.subjectRequests[method]).toHaveBeenCalledTimes(1);
    expect(f.audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action, targetType: action, targetId: requestId, success: true }));
    await app.close();
  });
  it('normalizes UUID audit correlation and records real adapter allowlisted data only', async () => {
    const f = setup(); const values = vi.fn(async () => undefined); const adapter = new DashboardAudit({ insert: () => ({ values }) } as never);
    f.audit.record.mockImplementation(input => adapter.record(input)); const app = await createDashboardServer(f.deps);
    for (const action of ['privacy-preview', ...Object.keys(phrases)]) {
      expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/${action}`, headers, payload: { ...payload(action), requestId: requestId.toUpperCase(), previewId: previewId.toUpperCase() } })).statusCode).toBe(303);
      expect(values).toHaveBeenLastCalledWith(expect.objectContaining({ action, targetType: action, targetId: requestId }));
    }
    expect(values).toHaveBeenCalledTimes(4); expect(JSON.stringify(values.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_BODY'); expect(JSON.stringify(values.mock.calls)).not.toContain('csrfToken'); await app.close();
  });
  it('rejects malformed/unknown/cross-guild selected requests or artifacts before metadata listing', async () => {
    const f = setup(); const app = await createDashboardServer(f.deps);
    for (const query of ['requestId=bad', `requestId=${requestId}&userId=${owner.userId}`]) expect((await app.inject({ url: `/g/${guildId}/privacy?${query}`, headers })).statusCode).toBe(404);
    expect(f.subjectRequests.inspect).not.toHaveBeenCalled();
    for (const detail of [{ ...inspection, request: { ...request, guildId: otherGuild } }, { ...inspection, preview: { ...preview, guildId: otherGuild } }, { ...inspection, receipt: { ...receipt, guildId: otherGuild } }]) {
      f.subjectRequests.inspect.mockResolvedValueOnce(detail);
      expect((await app.inject({ url: `/g/${guildId}/privacy?requestId=${requestId}`, headers })).statusCode).toBe(404);
    }
    f.subjectRequests.inspect.mockRejectedValueOnce(new AppError('NOT_FOUND', 'Unknown request'));
    expect((await app.inject({ url: `/g/${guildId}/privacy?requestId=${requestId}`, headers })).statusCode).toBe(404);
    expect(f.subjectRequests.list).not.toHaveBeenCalled(); expect(f.subjectRequests.recentReceipts).not.toHaveBeenCalled(); await app.close();
  });
  it('renders bounded escaped whitelisted metadata, verification inventory warnings preview receipt and owner controls', () => {
    const requests = Array.from({ length: 51 }, (_, i) => ({ ...request, subjectUserId: i === 50 ? 'HIDDEN_51ST' : '<subject>', body: 'SYNTHETIC_PRIVATE_BODY' }));
    const receipts = Array.from({ length: 51 }, (_, i) => ({ ...receipt, inventoryHash: i === 50 ? 'HIDDEN_RECEIPT_51ST' : '<hash>', transcript: 'SYNTHETIC_PRIVATE_BODY' }));
    const detail = { ...inspection, workflowEvidence: '<current evidence>', auditGaps: [{ id: requestId, actorUserId: '<actor>', action: 'privacy-execute' as const, targetType: 'privacy-execute', targetId: requestId, committedAt: now, detectedAt: now }] };
    const html = renderPrivacyDashboard(guildId, '<csrf>', { requests, receipts, selected: detail }, true);
    for (const hidden of ['HIDDEN_51ST', 'HIDDEN_RECEIPT_51ST', 'SYNTHETIC_PRIVATE_BODY', 'name="userId"', 'name="subjectUserId"', 'privacy-create']) expect(html).not.toContain(hidden);
    for (const expected of ['&lt;subject&gt;', '&lt;hash&gt;', '&lt;actor&gt;', '&lt;current evidence&gt;', 'MODERATION_ACCOUNTABILITY', 'SELF_GUILD_MEMBER', 'Verification method', 'Eligible total', 'Retained total', 'PARTIAL', 'historical backups may remain', 'excluded only', 'CONFIRM PRIVACY REQUEST', 'DENY PRIVACY REQUEST']) expect(html).toContain(expected);
    expect(renderPage({ page: 'overview', guildId, guildName: 'Guild', csrfToken: '', actorLevel: 'MODERATOR' })).not.toContain(`/g/${guildId}/privacy`);
    expect(renderPage({ page: 'privacy', guildId, guildName: 'Guild', csrfToken: '', actorLevel: 'ADMIN', data: { requests: [], receipts: [], selected: null } })).toContain(`/g/${guildId}/privacy`);
  });
  it('writes one correlated gap after committed privacy/retention mutation when real audit adapter fails; never retries domain operation', async () => {
    const f = setup(); const values = vi.fn(async () => { throw new Error('SYNTHETIC_PRIVATE_AUDIT_ERROR'); }); const adapter = new DashboardAudit({ insert: () => ({ values }) } as never);
    f.audit.record.mockImplementation(input => adapter.record(input)); const app = await createDashboardServer(f.deps);
    const mutations = [
      ['privacy-preview', f.subjectRequests.preview, payload('privacy-preview')], ['privacy-confirm', f.subjectRequests.confirm, payload('privacy-confirm')],
      ['privacy-execute', f.subjectRequests.execute, payload('privacy-execute')], ['privacy-deny', f.subjectRequests.deny, payload('privacy-deny')],
      ['retention-confirm', f.retention.confirm, { csrfToken: 'csrf', confirm: 'yes', phrase: 'ENABLE RETENTION', previewId }],
      ['retention-disable', f.retention.disable, { csrfToken: 'csrf', confirm: 'yes' }],
      ['retention-hold-set', f.retention.setHold, { csrfToken: 'csrf', confirm: 'yes', domain: 'REPORT', recordId: '42' }],
      ['retention-hold-clear', f.retention.clearHold, { csrfToken: 'csrf', confirm: 'yes', domain: 'APPEAL', recordId: '43' }],
    ] as const;
    for (const [action, mutate, body] of mutations) {
      expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/${action}`, headers, payload: body })).statusCode).toBe(303);
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(f.subjectRequests.recordAuditGap).toHaveBeenLastCalledWith(expect.objectContaining({ guildId, actorUserId: owner.userId, action, targetType: action, requestId: expect.any(String), ...(action.startsWith('privacy-') ? { targetId: requestId } : {}) }));
    }
    expect(f.subjectRequests.recordAuditGap).toHaveBeenCalledTimes(8);
    const serialized = JSON.stringify([f.subjectRequests.recordAuditGap.mock.calls, f.logger.error.mock.calls]);
    expect(serialized).not.toContain('SYNTHETIC_PRIVATE_BODY'); expect(serialized).not.toContain('SYNTHETIC_PRIVATE_AUDIT_ERROR'); expect(serialized).not.toContain('csrfToken');
    await app.close();
  });
  it('audit and gap double failure logs safe metadata and preserves single committed execute', async () => {
    const f = setup(); let committed = 0;
    f.subjectRequests.execute.mockImplementation(async () => { committed++; return { request, receipt }; });
    f.audit.record.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_AUDIT_ERROR'));
    f.subjectRequests.recordAuditGap.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_GAP_ERROR'));
    const app = await createDashboardServer(f.deps);
    expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/privacy-execute`, headers, payload: payload('privacy-execute') })).statusCode).toBe(303);
    expect(committed).toBe(1); expect(f.subjectRequests.execute).toHaveBeenCalledTimes(1); expect(f.subjectRequests.recordAuditGap).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledTimes(2);
    for (const [metadata] of f.logger.error.mock.calls) expect(Object.keys(metadata).sort()).toEqual(['action', 'errorType', 'requestId']);
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_'); await app.close();
  });
  it('failed domain mutation records correlated failure audit but no committed-state gap', async () => {
    const f = setup(); f.subjectRequests.execute.mockRejectedValue(new AppError('CONFLICT', 'Synthetic stale preview')); const app = await createDashboardServer(f.deps);
    expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/privacy-execute`, headers, payload: payload('privacy-execute') })).statusCode).toBe(409);
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'privacy-execute', targetType: 'privacy-execute', targetId: requestId, success: false }));
    expect(f.subjectRequests.recordAuditGap).not.toHaveBeenCalled(); await app.close();
  });
  it('retention without gap service logs safe fallback; retention-preview audit failure has no governance gap', async () => {
    const f = setup(); delete (f.deps as { subjectRequests?: unknown }).subjectRequests; f.audit.record.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_AUDIT_ERROR'));
    const app = await createDashboardServer(f.deps);
    expect((await app.inject({ method: 'POST', url: `/g/${guildId}/action/retention-disable`, headers, payload: { csrfToken: 'csrf', confirm: 'yes' } })).statusCode).toBe(303);
    expect(f.retention.disable).toHaveBeenCalledTimes(1); expect(f.logger.error).toHaveBeenCalledWith(expect.objectContaining({ action: 'retention-disable', errorType: 'AuditGapUnavailable' }), expect.any(String));
    await app.close();
    const g = setup(); g.audit.record.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_AUDIT_ERROR')); const second = await createDashboardServer(g.deps);
    expect((await second.inject({ method: 'POST', url: `/g/${guildId}/action/retention-preview`, headers, payload: { csrfToken: 'csrf', ticketDays: '30', reportDays: '90', appealDays: '90' } })).statusCode).toBe(303);
    expect(g.subjectRequests.recordAuditGap).not.toHaveBeenCalled(); await second.close();
  });
});
