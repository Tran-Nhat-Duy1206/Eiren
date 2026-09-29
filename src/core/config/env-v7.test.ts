import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', () => ({ existsSync: () => false }));
import { loadEnv } from './env.js';
const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const base = () => { process.env = { DISCORD_TOKEN: 'test', DISCORD_CLIENT_ID: '123456789012345678', DATABASE_URL: 'postgres://localhost/test' }; };
const enabled = () => {
  base(); Object.assign(process.env, { AI_ENABLED: 'true', AI_PROVIDER_ID: 'operator-provider', AI_MODEL_ID: 'approved',
    AI_ENDPOINT: 'https://example.org/v1', AI_API_KEY: 'synthetic-secret',
    AI_MODEL_CATALOG: JSON.stringify([{ providerId: 'operator-provider', modelId: 'approved',
      inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, maxInputTokens: 2048, maxOutputTokens: 512 }]) });
};

describe('V7 optional server AI configuration', () => {
  it('does not need credentials when disabled', () => { base(); expect(loadEnv().AI).toBeNull(); });
  it('requires all server-only fields by name without echoing values', () => {
    base(); process.env.AI_ENABLED = 'true';
    expect(() => loadEnv()).toThrow(/AI_PROVIDER_ID/);
    expect(() => loadEnv()).toThrow(/AI_MODEL_CATALOG/);
    enabled(); process.env.AI_ENDPOINT = 'http://private-host.example/secret';
    expect(() => loadEnv()).toThrow('AI_ENDPOINT');
    try { loadEnv(); } catch (error) { expect(String(error)).not.toContain('private-host'); }
  });
  it('loads approved catalog pricing and bounded defaults', () => {
    enabled(); const ai = loadEnv().AI!;
    expect(ai.policy).toMatchObject({ providerId: 'operator-provider', modelId: 'approved',
      maxInputCharacters: 4000, maxEstimatedInputTokens: 2048, maxOutputTokens: 512,
      guildRequestsPerDay: 25, userRequestsPerDay: 10, userCooldownSeconds: 30,
      guildConcurrency: 1, processConcurrency: 4, monthlyBudgetUsd: 5 });
    expect(ai.timeoutMs).toBe(15_000);
    expect(ai.globalDailyBudgetMicros).toBe(5_000_000);
    expect(ai.globalMonthlyBudgetMicros).toBe(50_000_000);
    expect(ai.models[0]?.outputUsdPerMillionTokens).toBe(2);
  });
  it('rejects unapproved models, invalid pricing, endpoint credentials and oversized caps', () => {
    enabled(); process.env.AI_MODEL_ID = 'unapproved'; expect(() => loadEnv()).toThrow(/AI_MODEL_ID/);
    enabled(); process.env.AI_MODEL_CATALOG = '[{"providerId":"operator-provider","modelId":"approved","inputUsdPerMillionTokens":-1}]';
    expect(() => loadEnv()).toThrow(/AI_MODEL_CATALOG/);
    enabled(); process.env.AI_MODEL_CATALOG = JSON.stringify([{ providerId: 'operator-provider', modelId: 'approved',
      inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0, maxInputTokens: 2048, maxOutputTokens: 512 }]);
    expect(() => loadEnv()).toThrow(/AI_MODEL_CATALOG/);
    enabled(); process.env.AI_ENDPOINT = 'https://user:secret@example.org/v1'; expect(() => loadEnv()).toThrow(/AI_ENDPOINT/);
    enabled(); process.env.AI_TIMEOUT_MS = '15001'; expect(() => loadEnv()).toThrow(/AI_TIMEOUT_MS/);
    enabled(); process.env.AI_PROCESS_CONCURRENCY = '5'; expect(() => loadEnv()).toThrow(/AI_PROCESS_CONCURRENCY/);
    enabled(); process.env.AI_MONTHLY_BUDGET_USD = '5.01'; expect(() => loadEnv()).toThrow(/AI_MONTHLY_BUDGET_USD/);
    enabled(); process.env.AI_GLOBAL_DAILY_BUDGET_USD = '101'; expect(() => loadEnv()).toThrow(/AI_GLOBAL_DAILY_BUDGET_USD/);
    enabled(); process.env.AI_GLOBAL_MONTHLY_BUDGET_USD = '1001'; expect(() => loadEnv()).toThrow(/AI_GLOBAL_MONTHLY_BUDGET_USD/);
  });
});
