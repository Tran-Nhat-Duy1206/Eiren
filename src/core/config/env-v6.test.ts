import { afterEach, describe, expect, it, vi } from 'vitest';

// Never read the operator's real .env while testing conditional validation.
vi.mock('node:fs', () => ({ existsSync: () => false }));
import { loadEnv } from './env.js';

const before = { ...process.env };
afterEach(() => { process.env = { ...before }; });
function base() {
  process.env = {
    DISCORD_TOKEN: 'synthetic-bot-token',
    DISCORD_CLIENT_ID: '123456789012345678',
    DATABASE_URL: 'postgres://synthetic:synthetic@localhost:5432/synthetic',
    DASHBOARD_ENABLED: 'false',
  };
}

describe('V6 conditional dashboard environment', () => {
  it('starts disabled without OAuth/dashboard secrets', () => {
    base();
    const env = loadEnv();
    expect(env.DASHBOARD_ENABLED).toBe(false);
    expect(env.DASHBOARD).toBeNull();
  });
  it('rejects enabled dashboard missing secrets using names only', () => {
    base(); process.env.DASHBOARD_ENABLED = 'true';
    expect(() => loadEnv()).toThrow(/DASHBOARD_SESSION_SECRET/);
    expect(() => loadEnv()).toThrow(/DISCORD_CLIENT_SECRET/);
  });
  it('allows loopback HTTP and refuses network-exposed HTTP', () => {
    base(); Object.assign(process.env, {
      DASHBOARD_ENABLED: 'true', DASHBOARD_BASE_URL: 'http://localhost:3000',
      DASHBOARD_SESSION_SECRET: 'x'.repeat(40), DISCORD_CLIENT_SECRET: 'synthetic-client-secret',
    });
    expect(loadEnv().DASHBOARD?.DASHBOARD_HOST).toBe('127.0.0.1');
    process.env.DASHBOARD_HOST = '0.0.0.0';
    expect(() => loadEnv()).toThrow(/DASHBOARD_BASE_URL/);
    process.env.DASHBOARD_BASE_URL = 'http://example.com:3000';
    expect(() => loadEnv()).toThrow(/DASHBOARD_BASE_URL/);
  });
  it('rejects credential-bearing URL and invalid port without echoing values', () => {
    base(); Object.assign(process.env, {
      DASHBOARD_ENABLED: 'true', DASHBOARD_BASE_URL: 'https://user:private@example.com',
      DASHBOARD_SESSION_SECRET: 'x'.repeat(40), DISCORD_CLIENT_SECRET: 'synthetic-client-secret',
      DASHBOARD_PORT: '99999',
    });
    expect(() => loadEnv()).toThrow(/DASHBOARD_BASE_URL|DASHBOARD_PORT/);
    try { loadEnv(); } catch (error) { expect(String(error)).not.toContain('private'); }
  });
});
