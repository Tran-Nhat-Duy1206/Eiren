import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
export type Database = ReturnType<typeof createDatabase>['db'];
