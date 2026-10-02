import { describe, expect, it, vi } from 'vitest';
import type { DashboardAuditEntry } from './access/dashboard-audit.js';
import { DashboardAudit } from './access/dashboard-audit.js';
import { createDashboardServer } from './web.js';
import { renderRetentionDashboard } from './retention-ui.js';

const guildId = '123456789012345678';
const owner = { guildId, userId: '234567890123456789', guildOwnerId: '234567890123456789', roleIds: [] };
const id = '123e4567-e89b-42d3-a456-426614174000';
const status = { policy: { enabled: false, ticketDays: 30, reportDays: 90, appealDays: 90, version: 0, confirmedBy: null, confirmedAt: null }, eligibleCounts: { ticket: 1, report: 2, appeal: 3 }, holdCounts: { ticket: 0, report: 0, appeal: 0 }, activeHolds: [{ domain: 'REPORT', recordId: 42, heldBy: '<held-by>', heldAt: new Date() }], recentReceipts: [{ guildId, domain: '<script>', recordId: 2, policyVersion: 1, redactedAt: new Date() }] };
const preview = { id, guildId, requestedBy: owner.userId, ticketDays: 30, reportDays: 90, appealDays: 90, eligibleCounts: status.eligibleCounts, baseVersion: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
const headers = { cookie: 'dashboard_session=valid', origin: 'https://dashboard.example' };
function setup() {
  let actor = owner;
  const access = { authorize: vi.fn(async () => actor), listAccessible: vi.fn(async () => []) };
  const retention = { status: vi.fn(async () => status), preview: vi.fn(async () => preview), getPreview: vi.fn(async () => preview), confirm: vi.fn(async () => status.policy), disable: vi.fn(async () => status.policy), setHold: vi.fn(async () => ({})), clearHold: vi.fn(async () => ({})) };
  const audit = { record: vi.fn(async (_entry: DashboardAuditEntry): Promise<void> => undefined) };
  const auth = { clearSessionCookie: () => ({ name: 'dashboard_session', value: '', options: { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: true, maxAge: 0 } }), getSession: vi.fn(async () => ({ userId: actor.userId, expiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 60_000) })), csrfToken: () => 'csrf', verifyCsrf: (_raw: string, token: string) => token === 'csrf' };
  const deps = { client: { guilds: { fetch: async () => ({ id: guildId, name: 'Test', memberCount: 1 }) } }, services: { permissions: { resolve: async () => 'BOT_OWNER' }, modules: { isEnabled: async () => true } }, auth, access, read: {}, audit, retention, baseUrl: 'https://dashboard.example' };
  return { deps: deps as never, retention, audit, access, setActor: (value: typeof owner) => { actor = value; } };
}
describe('private retention dashboard', () => {
  it('rejects direct confirmation POST without checkbox or phrase', async () => {
    const f = setup(); const app = await createDashboardServer(f.deps);
    const url = `/g/${guildId}/action/retention-confirm`;
    expect((await app.inject({ method: 'POST', url, headers, payload: { csrfToken: 'csrf', previewId: id } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers, payload: { csrfToken: 'csrf', previewId: id, confirm: 'yes' } })).statusCode).toBe(400);
    expect(f.retention.confirm).not.toHaveBeenCalled(); await app.close();
  });
  it('rejects cross-guild and cross-requester preview metadata', async () => {
    const f = setup(); const app = await createDashboardServer(f.deps);
    for (const mismatch of [{ guildId: '999999999999999999' }, { requestedBy: '999999999999999999' }]) {
      f.retention.getPreview.mockResolvedValueOnce({ ...preview, ...mismatch });
      expect((await app.inject({ url: `/g/${guildId}/data-retention?previewId=${id}`, headers })).statusCode).toBe(404);
    }
    expect(f.retention.status).not.toHaveBeenCalled(); await app.close();
  });
  it('persists hold audit through actual adapter validation without raw body', async () => {
    const f = setup(); const values = vi.fn(async () => undefined);
    const adapter = new DashboardAudit({ insert: vi.fn(() => ({ values })) } as never);
    f.audit.record.mockImplementation(entry => adapter.record(entry));
    const app = await createDashboardServer(f.deps);
    for (const domain of ['TICKET', 'REPORT', 'APPEAL']) {
      for (const name of ['retention-hold-set', 'retention-hold-clear']) {
        const result = await app.inject({ method: 'POST', url: `/g/${guildId}/action/${name}`, headers,
          payload: { csrfToken: 'csrf', confirm: 'yes', domain, recordId: '42', rawBody: 'PRIVATE_NARRATIVE' } });
        expect(result.statusCode).toBe(303);
        expect(values).toHaveBeenCalledWith(expect.objectContaining({ targetId: `${domain}-42`, success: true }));
      }
    }
    expect(values).toHaveBeenCalledTimes(6);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'REPORT-42', success: true }));
    expect(JSON.stringify(values.mock.calls)).not.toContain('PRIVATE_NARRATIVE');
    expect(JSON.stringify(values.mock.calls)).not.toContain('csrfToken'); await app.close();
  });
  it('renders only allowlisted escaped metadata, owner-only controls and bounded inputs', () => {
    const html = renderRetentionDashboard(guildId, 'csrf', { ...status, policy: { ...status.policy, secretNarrative: 'DO_NOT_RENDER' } } as never, null, false);
    expect(html).not.toContain('DO_NOT_RENDER'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('retention-preview');
    expect(html).toContain('Active holds (up to 50)'); expect(html).toContain('&lt;held-by&gt;');
    const bounded = renderRetentionDashboard(guildId, 'csrf', { ...status, activeHolds: Array.from({ length: 51 }, (_, i) => ({ domain: 'REPORT', recordId: i + 1, heldBy: i === 50 ? 'HIDDEN_51ST' : '<held-by>', heldAt: null, body: 'DO_NOT_RENDER' })) }, null, false);
    expect(bounded).not.toContain('HIDDEN_51ST'); expect(bounded).not.toContain('DO_NOT_RENDER');
    const own = renderRetentionDashboard(guildId, 'csrf', status, preview, true);
    expect(own).toContain('min="30" max="365"'); expect(own).toContain('min="90" max="730"'); expect(own).toContain('ENABLE RETENTION');
  });
  it('allows ADMIN metadata read but denies ADMIN and BOT_OWNER mutations even when rank resolves high', async () => {
    const f = setup(); f.setActor({ ...owner, userId: '345678901234567890' }); const app = await createDashboardServer(f.deps);
    const get = await app.inject({ url: `/g/${guildId}/data-retention`, headers });
    expect(get.statusCode).toBe(200); expect(get.body).not.toContain('action/retention-preview');
    expect(f.access.authorize).toHaveBeenCalledWith(guildId, expect.anything(), 'ADMIN');
    for (const name of ['retention-preview', 'retention-confirm', 'retention-disable', 'retention-hold-set', 'retention-hold-clear']) {
      const post = await app.inject({ method: 'POST', url: `/g/${guildId}/action/${name}`, headers,
        payload: { csrfToken: 'csrf', confirm: 'yes', phrase: 'ENABLE RETENTION', previewId: id,
          ticketDays: '30', reportDays: '90', appealDays: '90', domain: 'TICKET', recordId: '12' } });
      expect(post.statusCode).toBe(403);
    }
    for (const method of ['preview', 'confirm', 'disable', 'setHold', 'clearHold'] as const) expect(f.retention[method]).not.toHaveBeenCalled();
    await app.close();
  });
  it('gates owner mutations with Origin CSRF confirmations and audits safe identifiers', async () => {
    const f = setup(); const app = await createDashboardServer(f.deps);
    const url = `/g/${guildId}/action/retention-preview`;
    const payload = { csrfToken: 'csrf', ticketDays: '30', reportDays: '90', appealDays: '90' };
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://evil.example' }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, csrfToken: 'bad' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, ticketDays: '29' } })).statusCode).toBe(400);
    const result = await app.inject({ method: 'POST', url, headers, payload });
    expect(result.statusCode).toBe(303); expect(result.headers.location).toBe(`/g/${guildId}/data-retention?previewId=${id}`);
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'retention-preview-created', targetId: id }));
    const detail = await app.inject({ url: `/g/${guildId}/data-retention?previewId=${id}`, headers }); expect(detail.body).toContain('Pending preview');
    const confirm = `/g/${guildId}/action/retention-confirm`;

    expect((await app.inject({ method: 'POST', url: confirm, headers, payload: { csrfToken: 'csrf', previewId: id, confirm: 'yes', phrase: 'WRONG' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: confirm, headers, payload: { csrfToken: 'csrf', previewId: id, phrase: 'ENABLE RETENTION' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: confirm, headers, payload: { csrfToken: 'csrf', previewId: id, confirm: 'yes', phrase: 'ENABLE RETENTION' } })).statusCode).toBe(303);
    expect(f.retention.confirm).toHaveBeenCalledWith(owner, id);
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'retention-policy-enabled', targetId: id }));
    f.retention.confirm.mockResolvedValueOnce({ previousEnabled: true } as never);
    expect((await app.inject({ method: 'POST', url: confirm, headers, payload: { csrfToken: 'csrf', previewId: id, confirm: 'yes', phrase: 'ENABLE RETENTION' } })).statusCode).toBe(303);
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'retention-policy-changed', targetId: id }));
    for (const [name, fields] of [['retention-disable', {}], ['retention-hold-set', { domain: 'TICKET', recordId: '12' }], ['retention-hold-clear', { domain: 'APPEAL', recordId: '13' }]] as const) {
      const action = `/g/${guildId}/action/${name}`;
      expect((await app.inject({ method: 'POST', url: action, headers, payload: { csrfToken: 'csrf', ...fields } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: action, headers, payload: { csrfToken: 'csrf', confirm: 'yes', ...fields } })).statusCode).toBe(303);
    }
    expect(f.retention.setHold).toHaveBeenCalledWith(owner, 'TICKET', 12);
    expect(f.retention.clearHold).toHaveBeenCalledWith(owner, 'APPEAL', 13);
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'retention-hold-cleared', targetId: 'APPEAL-13' }));
    await app.close();
  });
});
