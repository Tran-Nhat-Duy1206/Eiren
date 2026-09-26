import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { guilds, guildSettings, guildModules, guildPermissionRoles, moderationCases, moderatorNotes,
  verificationSettings, memberVerifications, antiraidSettings, joinHistory } from '../core/database/schema.js';
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
      const [caseRecord] = await tx.insert(moderationCases).values({ guildId, targetId: guildId, moderatorId: guildId,
        action: 'WARN', reason: 'V1 smoke test', status: 'COMPLETED' }).returning();
      const [note] = await tx.insert(moderatorNotes).values({ guildId, targetId: guildId, moderatorId: guildId,
        content: 'V1 private note smoke test' }).returning();
      const [verificationConfig] = await tx.insert(verificationSettings).values({ guildId, mode: 'BUTTON' }).returning();
      const [memberVerification] = await tx.insert(memberVerifications).values({ guildId, userId: guildId }).returning();
      const [antiRaidConfig] = await tx.insert(antiraidSettings).values({ guildId }).returning();
      const [join] = await tx.insert(joinHistory).values({ guildId, userId: guildId, joinedAt: new Date(),
        riskScore: 0, signals: ['smoke'] }).returning();
      if (!settings || module?.enabled !== false || role?.level !== 'ADMIN' || !caseRecord || !note
        || !verificationConfig || !memberVerification || !antiRaidConfig || !join)
        throw new Error('Smoke-test records were not readable');
      // Constraint checks run in savepoints so both invalid writes can be attempted in one transaction.
      const rejected = async (work: (inner: typeof tx) => Promise<unknown>) => {
        try { await tx.transaction(work); return false; }
        catch { return true; }
      };
      if (!await rejected(inner => inner.insert(moderationCases).values({ guildId, targetId: guildId, moderatorId: guildId,
        action: 'WARN', reason: 'invalid', status: 'INVALID' })))
        throw new Error('Moderation case status constraint failed');
      if (!await rejected(inner => inner.insert(memberVerifications).values({ guildId, userId: `${guildId}9`, status: 'INVALID' })))
        throw new Error('Member verification status constraint failed');
      throw rollback;
    });
    throw new Error('Smoke-test transaction did not roll back');
  } catch (error) {
    if (error !== rollback) throw error;
  }
  const [persisted] = await db.select().from(guilds).where(eq(guilds.id, guildId));
  if (persisted) throw new Error('Smoke-test transaction persisted unexpectedly');
  logger.info('PostgreSQL V0/V1/V2 schema, constraints and rollback smoke test passed');
} catch (error) {
  // Database driver exceptions can contain credentials; only emit the error class.
  logger.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'PostgreSQL smoke test failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
