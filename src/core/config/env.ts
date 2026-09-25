import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);
const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_DEV_GUILD_ID: snowflake.optional(),
  DATABASE_URL: z.string().url().refine(value => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), 'Expected a PostgreSQL URL'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  ENABLE_GUILD_MEMBERS_INTENT: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
});

export type Env = z.infer<typeof schema>;
export function loadEnv(): Env {
  if (existsSync('.env')) loadEnvFile('.env');
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Only disclose invalid field names: validation inputs may contain credentials.
    throw new Error(`Invalid environment fields: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  return result.data;
}
