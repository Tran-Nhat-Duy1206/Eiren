import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, inArray, lte, or } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { dashboardSessions } from '../../core/database/schema.js';

// __Host- cookies cannot be supplied by sibling subdomains (Secure, Path=/, no Domain).
const STATE_COOKIE = '__Host-dashboard_oauth_state';
const SESSION_COOKIE = '__Host-dashboard_session';
const STATE_MS = 10 * 60_000;
const IDLE_MS = 24 * 60 * 60_000;
const ABSOLUTE_MS = 30 * IDLE_MS;
const MAX_STATES = 10_000;
const OAUTH_URL = 'https://discord.com/api/oauth2/authorize';
const API_URL = 'https://discord.com/api/v10';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';

export interface DashboardAuthConfig {
  baseUrl: string;
  sessionSecret: string;
  discordClientId: string;
  discordClientSecret: string;
  secureCookies: boolean;
}
export interface AuthCookie { name: string; value: string; options: { path: '/'; httpOnly: true; secure: boolean; sameSite: 'lax'; maxAge: number }; }
export interface DashboardSession { userId: string; oauthGuildIds: string[]; displayName: string | null; createdAt: Date; lastSeenAt: Date; expiresAt: Date; absoluteExpiresAt: Date; }
export interface OAuthStart { authorizationUrl: string; stateCookie: AuthCookie; }
export interface OAuthCallback { session: DashboardSession; sessionCookie: AuthCookie; clearStateCookie: AuthCookie; }
export class DashboardAuthError extends Error {
  constructor() { super('Authentication failed'); this.name = 'DashboardAuthError'; }
}
function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function equals(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function validToken(token: unknown): token is string { return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token); }

export class DashboardAuth {
  private readonly callbackUrl: string;
  private readonly states = new Map<string, number>();
  private readonly fetcher: typeof fetch;
  constructor(private readonly db: Database, private readonly config: DashboardAuthConfig, fetcher: typeof fetch = fetch) {
    const base = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !config.sessionSecret || !config.discordClientId || !config.discordClientSecret || (base.protocol === 'https:' && !config.secureCookies)) throw new Error('Invalid dashboard auth configuration');
    this.callbackUrl = new URL('auth/callback', base.href.endsWith('/') ? base : `${base.href}/`).href;
    this.fetcher = fetcher;
  }
  private cookie(name: string, value: string, maxAge: number): AuthCookie {
    return { name, value, options: { path: '/', httpOnly: true, sameSite: 'lax', secure: this.config.secureCookies, maxAge } };
  }
  private stateCookieName() { return this.config.secureCookies ? STATE_COOKIE : 'dashboard_oauth_state'; }
  private sessionCookieName() { return this.config.secureCookies ? SESSION_COOKIE : 'dashboard_session'; }
  clearStateCookie() { return this.cookie(this.stateCookieName(), '', 0); }
  clearSessionCookie() { return this.cookie(this.sessionCookieName(), '', 0); }
  private signature(value: string) { return createHmac('sha256', this.config.sessionSecret).update(`oauth-state:${value}`).digest('hex'); }
  startOAuth(now = new Date()): OAuthStart {
    for (const [nonce, deadline] of this.states) if (deadline <= now.getTime()) this.states.delete(nonce);
    if (this.states.size >= MAX_STATES) throw new DashboardAuthError();
    const nonce = randomBytes(32).toString('hex');
    this.states.set(digest(nonce), now.getTime() + STATE_MS);
    const url = new URL(OAUTH_URL);
    url.searchParams.set('client_id', this.config.discordClientId);
    url.searchParams.set('redirect_uri', this.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', nonce);
    return { authorizationUrl: url.href, stateCookie: this.cookie(this.stateCookieName(), `${nonce}.${this.signature(nonce)}`, STATE_MS / 1000) };
  }
  async completeOAuth(code: unknown, state: unknown, stateCookie: unknown, now = new Date()): Promise<OAuthCallback> {
    // The caller MUST send clearStateCookie() on both successful and failed callbacks.
    if (typeof state !== 'string' || !validToken(state) || typeof stateCookie !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(stateCookie)) throw new DashboardAuthError();
    const [nonce, signature] = stateCookie.split('.') as [string, string];
    const key = digest(nonce);
    const deadline = this.states.get(key);
    this.states.delete(key); // consume before any network or database work, even on mismatch
    if (!deadline || deadline <= now.getTime() || !equals(nonce, state) || !equals(signature, this.signature(nonce)) || typeof code !== 'string' || !code || code.length > 2048) throw new DashboardAuthError();
    try {
      const tokenResponse = await this.fetcher(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.config.discordClientId, client_secret: this.config.discordClientSecret, grant_type: 'authorization_code', code, redirect_uri: this.callbackUrl }), signal: AbortSignal.timeout(10_000) });
      if (!tokenResponse.ok) throw new DashboardAuthError();
      const credentials: unknown = await tokenResponse.json();
      if (!credentials || typeof credentials !== 'object' || !('access_token' in credentials) || typeof credentials.access_token !== 'string' || !credentials.access_token || !('token_type' in credentials) || credentials.token_type !== 'Bearer') throw new DashboardAuthError();
      const headers = { authorization: `Bearer ${credentials.access_token}` };
      const [userResponse, guildResponse] = await Promise.all([
        this.fetcher(`${API_URL}/users/@me`, { headers, signal: AbortSignal.timeout(10_000) }),
        this.fetcher(`${API_URL}/users/@me/guilds`, { headers, signal: AbortSignal.timeout(10_000) }),
      ]);
      if (!userResponse.ok || !guildResponse.ok) throw new DashboardAuthError();
      const user: unknown = await userResponse.json(); const guilds: unknown = await guildResponse.json();
      if (!user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string' || !/^\d{1,25}$/.test(user.id) || !Array.isArray(guilds) || guilds.length > 200 || !guilds.every(g => g && typeof g === 'object' && 'id' in g && typeof g.id === 'string' && /^\d{1,25}$/.test(g.id))) throw new DashboardAuthError();
      const displayName = 'global_name' in user && typeof user.global_name === 'string' ? user.global_name : 'username' in user && typeof user.username === 'string' ? user.username : null;
      return this.createSession(user.id, guilds.map(g => g.id as string), displayName?.slice(0, 128) ?? null, now);
    } catch { throw new DashboardAuthError(); }
  }
  async createSession(userId: string, oauthGuildIds: string[], displayName: string | null = null, now = new Date()): Promise<OAuthCallback> {
    if (!/^\d{1,25}$/.test(userId) || !Array.isArray(oauthGuildIds) || !oauthGuildIds.every(id => /^\d{1,25}$/.test(id))) throw new DashboardAuthError();
    const raw = randomBytes(32).toString('hex');
    const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_MS);
    const session: DashboardSession = { userId, oauthGuildIds: [...new Set(oauthGuildIds)], displayName, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + IDLE_MS), absoluteExpiresAt };
    await this.db.insert(dashboardSessions).values({ tokenHash: digest(raw), ...session });
    return { session, sessionCookie: this.cookie(this.sessionCookieName(), raw, Math.floor(IDLE_MS / 1000)), clearStateCookie: this.clearStateCookie() };
  }
  async getSession(raw: unknown, now = new Date()): Promise<DashboardSession | null> {
    if (!validToken(raw)) return null;
    const tokenHash = digest(raw);
    const rows = await this.db.select().from(dashboardSessions).where(eq(dashboardSessions.tokenHash, tokenHash)).limit(1);
    const session = rows[0];
    if (!session) return null;
    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) { await this.revokeSession(raw); return null; }
    const expiresAt = new Date(Math.min(now.getTime() + IDLE_MS, session.absoluteExpiresAt.getTime()));
    const updated = await this.db.update(dashboardSessions).set({ lastSeenAt: now, expiresAt }).where(and(eq(dashboardSessions.tokenHash, tokenHash), gt(dashboardSessions.expiresAt, now), gt(dashboardSessions.absoluteExpiresAt, now))).returning({ tokenHash: dashboardSessions.tokenHash });
    if (!updated.length) return null;
    return { userId: session.userId, oauthGuildIds: session.oauthGuildIds, displayName: session.displayName, createdAt: session.createdAt, lastSeenAt: now, expiresAt, absoluteExpiresAt: session.absoluteExpiresAt };
  }
  async revokeSession(raw: unknown): Promise<void> { if (validToken(raw)) await this.db.delete(dashboardSessions).where(eq(dashboardSessions.tokenHash, digest(raw))); }
  async cleanupExpired(now = new Date()): Promise<void> {
    const expired = or(lte(dashboardSessions.expiresAt, now), lte(dashboardSessions.absoluteExpiresAt, now));
    const rows = await this.db.select({ tokenHash: dashboardSessions.tokenHash }).from(dashboardSessions)
      .where(expired).orderBy(dashboardSessions.expiresAt).limit(200);
    if (rows.length) await this.db.delete(dashboardSessions).where(and(
      inArray(dashboardSessions.tokenHash, rows.map(row => row.tokenHash)), expired));
  }
  csrfToken(raw: unknown): string | null { return validToken(raw) ? createHmac('sha256', this.config.sessionSecret).update(`csrf:${raw}`).digest('hex') : null; }
  verifyCsrf(raw: unknown, submitted: unknown): boolean { const expected = this.csrfToken(raw); return expected !== null && typeof submitted === 'string' && /^[a-f0-9]{64}$/.test(submitted) && equals(expected, submitted); }
}
