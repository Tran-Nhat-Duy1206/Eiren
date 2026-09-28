import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';
import type { AiServerConfig } from '../../modules/ai/contracts.js';
import { AI_DEFAULT_LIMITS } from '../../modules/ai/limits.js';

const snowflake = z.string().regex(/^\d{17,20}$/);
const dashboardSchema = z.object({
  DASHBOARD_HOST: z.string().min(1).default('127.0.0.1'),
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DASHBOARD_BASE_URL: z.url(),
  DASHBOARD_SESSION_SECRET: z.string().min(32),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DASHBOARD_TRUST_PROXY: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
}).superRefine((value, ctx) => {
  const url = new URL(value.DASHBOARD_BASE_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local &&
    ['localhost', '127.0.0.1', '::1'].includes(value.DASHBOARD_HOST)))
    ctx.addIssue({ code: 'custom', path: ['DASHBOARD_BASE_URL'], message: 'HTTPS required except loopback development' });
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    ctx.addIssue({ code: 'custom', path: ['DASHBOARD_BASE_URL'], message: 'Use an origin without credentials or path' });
});
export type DashboardEnv = z.infer<typeof dashboardSchema>;

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_DEV_GUILD_ID: snowflake.optional(),
  DATABASE_URL: z.string().url().refine(value => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), 'Expected a PostgreSQL URL'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  ENABLE_GUILD_MEMBERS_INTENT: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  DASHBOARD_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  AI_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
});

const positive = (maximum: number) => z.coerce.number().int().min(1).max(maximum);
const aiSchema = z.object({
  AI_PROVIDER_ID: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  AI_MODEL_ID: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/),
  AI_ENDPOINT: z.url(),
  AI_API_KEY: z.string().min(1),
  AI_MODEL_CATALOG: z.string().min(1),
  AI_TIMEOUT_MS: positive(AI_DEFAULT_LIMITS.timeoutMs).default(AI_DEFAULT_LIMITS.timeoutMs),
  AI_GUILD_CONCURRENCY: positive(AI_DEFAULT_LIMITS.guildConcurrency).default(AI_DEFAULT_LIMITS.guildConcurrency),
  AI_PROCESS_CONCURRENCY: positive(AI_DEFAULT_LIMITS.processConcurrency).default(AI_DEFAULT_LIMITS.processConcurrency),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().positive().max(AI_DEFAULT_LIMITS.monthlyBudgetUsd).default(AI_DEFAULT_LIMITS.monthlyBudgetUsd),
  AI_GLOBAL_DAILY_BUDGET_USD: z.coerce.number().positive().max(100).default(5),
  AI_GLOBAL_MONTHLY_BUDGET_USD: z.coerce.number().positive().max(1000).default(50),
});
const catalogSchema = z.array(z.object({
  providerId: z.string().regex(/^[a-z0-9_-]{1,64}$/), modelId: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/),
  inputUsdPerMillionTokens: z.number().finite().nonnegative().max(1000),
  outputUsdPerMillionTokens: z.number().finite().nonnegative().max(1000),
  maxInputTokens: positive(AI_DEFAULT_LIMITS.maxEstimatedInputTokens),
  maxOutputTokens: positive(AI_DEFAULT_LIMITS.maxOutputTokens),
}).strict()).min(1);

export type Env = z.infer<typeof schema> & { DASHBOARD: DashboardEnv | null; AI: AiServerConfig | null };
export function loadEnv(): Env {
  if (existsSync('.env')) loadEnvFile('.env');
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Only disclose invalid field names: validation inputs may contain credentials.
    throw new Error(`Invalid environment fields: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  let ai: AiServerConfig | null = null;
  if (result.data.AI_ENABLED) {
    const parsed = aiSchema.safeParse(process.env);
    if (!parsed.success) throw new Error(`Invalid AI environment fields: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
    const value = parsed.data;
    let catalogJson: unknown;
    try { catalogJson = JSON.parse(value.AI_MODEL_CATALOG); }
    catch { throw new Error('Invalid AI environment fields: AI_MODEL_CATALOG'); }
    const catalog = catalogSchema.safeParse(catalogJson);
    if (!catalog.success) throw new Error('Invalid AI environment fields: AI_MODEL_CATALOG');
    let endpoint: URL;
    try { endpoint = new URL(value.AI_ENDPOINT); }
    catch { throw new Error('Invalid AI environment fields: AI_ENDPOINT'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error('Invalid AI environment fields: AI_ENDPOINT');
    const model = catalog.data.find(item => item.providerId === value.AI_PROVIDER_ID && item.modelId === value.AI_MODEL_ID);
    if (!model || new Set(catalog.data.map(item => `${item.providerId}\0${item.modelId}`)).size !== catalog.data.length)
      throw new Error('Invalid AI environment fields: AI_MODEL_CATALOG, AI_MODEL_ID');
    ai = {
      providerId: value.AI_PROVIDER_ID, endpoint: endpoint.toString(), apiKey: value.AI_API_KEY,
      models: catalog.data, timeoutMs: value.AI_TIMEOUT_MS,
      globalDailyBudgetMicros: Math.floor(value.AI_GLOBAL_DAILY_BUDGET_USD * 1_000_000),
      globalMonthlyBudgetMicros: Math.floor(value.AI_GLOBAL_MONTHLY_BUDGET_USD * 1_000_000),
      policy: {
        providerId: value.AI_PROVIDER_ID, modelId: value.AI_MODEL_ID,
        maxInputCharacters: AI_DEFAULT_LIMITS.maxInputCharacters,
        maxEstimatedInputTokens: Math.min(model.maxInputTokens, AI_DEFAULT_LIMITS.maxEstimatedInputTokens),
        maxOutputTokens: Math.min(model.maxOutputTokens, AI_DEFAULT_LIMITS.maxOutputTokens),
        guildRequestsPerDay: AI_DEFAULT_LIMITS.guildRequestsPerDay,
        userRequestsPerDay: AI_DEFAULT_LIMITS.userRequestsPerDay,
        userCooldownSeconds: AI_DEFAULT_LIMITS.userCooldownSeconds,
        guildConcurrency: value.AI_GUILD_CONCURRENCY,
        processConcurrency: value.AI_PROCESS_CONCURRENCY,
        monthlyBudgetUsd: value.AI_MONTHLY_BUDGET_USD,
      },
    };
  }
  if (!result.data.DASHBOARD_ENABLED) return { ...result.data, DASHBOARD: null, AI: ai };
  const dashboard = dashboardSchema.safeParse(process.env);
  if (!dashboard.success) throw new Error(`Invalid dashboard environment fields: ${dashboard.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  return { ...result.data, DASHBOARD: dashboard.data, AI: ai };
}
