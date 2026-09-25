import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { guilds, guildSettings, guildModules, guildPermissionRoles } from '../core/database/schema.js';
import { createLogger } from '../core/logger/logger.js';

// An opt-in integration check against the configured real PostgreSQL instance.
// All inserted records are rolled back, including on success.
const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const { db, pool } = createDatabase(env.DATABASE_URL);
pool.on('error', () => { logger.error('PostgreSQL pool error during smoke test'); process.exitCode = 1; });
const guildId = `${Date.now()}${randomInt(1000, 9999)}`;
const rollback = new Error('intentional smoke-test rollback');
try {
  try {
    await db.transaction(async tx => {
      await tx.insert(guilds).values({ id: guildId });
      await tx.insert(guildSettings).values({ guildId, setupCompletedAt: new Date(), timezone: 'UTC' });
      await tx.insert(guildModules).values({ guildId, moduleKey: '__smoke_fixture__', enabled: false, updatedBy: guildId });
      await tx.insert(guildPermissionRoles).values({ guildId, roleId: guildId, level: 'ADMIN' });
      const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
      const [module] = await tx.select().from(guildModules).where(eq(guildModules.guildId, guildId));
      const [role] = await tx.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.guildId, guildId));
      if (!settings || module?.enabled !== false || role?.level !== 'ADMIN') throw new Error('Smoke-test records were not readable');
      throw rollback;
    });
    throw new Error('Smoke-test transaction did not roll back');
  } catch (error) {
    if (error !== rollback) throw error;
  }
  const [persisted] = await db.select().from(guilds).where(eq(guilds.id, guildId));
  if (persisted) throw new Error('Smoke-test transaction persisted unexpectedly');
  logger.info('PostgreSQL V0 schema and rollback smoke test passed');
} catch (error) {
  // Database driver exceptions can contain credentials; only emit the error class.
  logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'PostgreSQL smoke test failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
