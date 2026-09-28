import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

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
});

export type Env = z.infer<typeof schema> & { DASHBOARD: DashboardEnv | null };
export function loadEnv(): Env {
  if (existsSync('.env')) loadEnvFile('.env');
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Only disclose invalid field names: validation inputs may contain credentials.
    throw new Error(`Invalid environment fields: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  if (!result.data.DASHBOARD_ENABLED) return { ...result.data, DASHBOARD: null };
  const dashboard = dashboardSchema.safeParse(process.env);
  if (!dashboard.success) throw new Error(`Invalid dashboard environment fields: ${dashboard.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  return { ...result.data, DASHBOARD: dashboard.data };
}
