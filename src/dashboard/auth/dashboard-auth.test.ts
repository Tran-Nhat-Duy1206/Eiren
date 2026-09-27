import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Database } from '../../core/database/connection.js';
import { DashboardAuth, DashboardAuthError } from './dashboard-auth.js';

const config = { baseUrl: 'https://example.com/dashboard/', sessionSecret: 'test-secret-that-is-long-enough', discordClientId: '123', discordClientSecret: 'private', secureCookies: true };
function fixture() {
  const records = new Map<string, any>();
  const db = {
    insert: () => ({ values: async (record: any) => { records.set(record.tokenHash, record); } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [...records.values()].slice(0, 1) }) }) }),
    update: () => ({ set: (value: any) => ({ where: () => ({ returning: async () => { const record = [...records.values()][0]; if (!record) return []; Object.assign(record, value); return [{ tokenHash: record.tokenHash }]; } }) }) }),
    delete: () => ({ where: async () => { records.clear(); } }),
  } as unknown as Database;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith('/token')) return Response.json({ access_token: 'sensitive-oauth-token', token_type: 'Bearer' });
    if (url.endsWith('/guilds')) return Response.json([{ id: '456', name: 'test' }]);
    return Response.json({ id: '123', username: 'Test User' });
  });
  return { auth: new DashboardAuth(db, config, fetcher), records, fetcher };
}
describe('DashboardAuth security', () => {
  it('limits scopes and signs a secure, short-lived OAuth state cookie', () => {
    const { auth } = fixture(); const start = auth.startOAuth(); const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get('scope')).toBe('identify guilds');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/dashboard/auth/callback');
    expect(start.stateCookie.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600 });
    expect(start.stateCookie.name).toBe('__Host-dashboard_oauth_state');
    expect(auth.clearSessionCookie().name).toBe('__Host-dashboard_session');
    expect(start.stateCookie.value).not.toContain(url.searchParams.get('state') + '.ignored');
  });
  it('rejects mismatch, tampering, stale and replayed callbacks without exchanging code', async () => {
    const { auth, fetcher } = fixture(); const start = auth.startOAuth(); const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    await expect(auth.completeOAuth('code', 'f'.repeat(64), start.stateCookie.value)).rejects.toBeInstanceOf(DashboardAuthError);
    await expect(auth.completeOAuth('code', state, start.stateCookie.value)).rejects.toBeInstanceOf(DashboardAuthError);
    const second = auth.startOAuth(); const next = new URL(second.authorizationUrl).searchParams.get('state')!;
    const signed = second.stateCookie.value;
    const tampered = signed.slice(0, -1) + (signed.endsWith('0') ? '1' : '0');
    await expect(auth.completeOAuth('code', next, tampered)).rejects.toBeInstanceOf(DashboardAuthError);
    const third = auth.startOAuth(); const last = new URL(third.authorizationUrl).searchParams.get('state')!;
    await expect(auth.completeOAuth('code', last, third.stateCookie.value, new Date(Date.now() + 601_000))).rejects.toBeInstanceOf(DashboardAuthError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('exchanges code server-side and stores only hashed session token and guild IDs', async () => {
    const { auth, records, fetcher } = fixture(); const start = auth.startOAuth(); const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const result = await auth.completeOAuth('code', state, start.stateCookie.value);
    const raw = result.sessionCookie.value;
    expect(result.sessionCookie.options).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax' });
    expect(result.clearStateCookie.options.maxAge).toBe(0);
    expect([...records.keys()]).toEqual([createHash('sha256').update(raw).digest('hex')]);
    expect(JSON.stringify([...records.values()])).not.toContain('sensitive-oauth-token');
    expect(result.session.oauthGuildIds).toEqual(['456']);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(auth.completeOAuth('code', state, start.stateCookie.value)).rejects.toBeInstanceOf(DashboardAuthError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects oversized OAuth guild snapshots rather than persisting unusable sessions', async () => {
    const { auth, records, fetcher } = fixture();
    fetcher.mockImplementation(async input => String(input).endsWith('/guilds')
      ? Response.json(Array.from({ length: 201 }, (_, id) => ({ id: String(id + 1) })))
      : String(input).endsWith('/token') ? Response.json({ access_token: 'synthetic', token_type: 'Bearer' })
        : Response.json({ id: '123', username: 'Test' }));
    const start = auth.startOAuth();
    await expect(auth.completeOAuth('code', new URL(start.authorizationUrl).searchParams.get('state'), start.stateCookie.value))
      .rejects.toBeInstanceOf(DashboardAuthError);
    expect(records.size).toBe(0);
  });
  it('rejects invalid bearer token and hides upstream errors', async () => {
    const { auth, fetcher } = fixture(); fetcher.mockRejectedValueOnce(new Error('token=SECRET'));
    const start = auth.startOAuth(); const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    await expect(auth.completeOAuth('code', state, start.stateCookie.value)).rejects.toThrow('Authentication failed');
  });
  it('expires idle and absolute sessions, supports logout, and verifies CSRF safely', async () => {
    const { auth, records } = fixture(); const now = new Date('2026-01-01T00:00:00Z');
    const { sessionCookie } = await auth.createSession('123', ['456'], null, now); const raw = sessionCookie.value;
    expect(await auth.getSession(raw, new Date(now.getTime() + 1000))).toMatchObject({ userId: '123' });
    const csrf = auth.csrfToken(raw)!;
    expect(auth.verifyCsrf(raw, csrf)).toBe(true);
    expect(auth.verifyCsrf(raw, csrf.slice(1))).toBe(false);
    expect(auth.verifyCsrf(raw, 'f'.repeat(64))).toBe(false);
    expect(auth.verifyCsrf('malformed', csrf)).toBe(false);
    expect(auth.clearSessionCookie().options.maxAge).toBe(0);
    await auth.revokeSession(raw); expect(records.size).toBe(0);
    const idle = await auth.createSession('123', [], null, now);
    expect(await auth.getSession(idle.sessionCookie.value, new Date(now.getTime() + 24 * 3600_000))).toBeNull();
    const absolute = await auth.createSession('123', [], null, now);
    expect(await auth.getSession(absolute.sessionCookie.value, new Date(now.getTime() + 30 * 24 * 3600_000))).toBeNull();
  });
});
