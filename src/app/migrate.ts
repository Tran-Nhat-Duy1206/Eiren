import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnv } from '../core/config/env.js';
import { createDatabase } from '../core/database/connection.js';
import { createLogger } from '../core/logger/logger.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const { db, pool } = createDatabase(env.DATABASE_URL);
pool.on('error', () => { logger.error('Unexpected PostgreSQL pool error during migration'); process.exitCode = 1; });
try {
  await migrate(db, { migrationsFolder: './drizzle' });
  logger.info('Database migrations complete');
} catch (error) {
  // DB driver errors may carry connection strings; do not emit raw error details.
  logger.fatal({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Database migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
