/**
 * core/db/client.ts
 *
 * The database pool. NOT exported.
 * The only way to reach the database is through withDb/withTx in index.ts.
 * This is the structural guarantee that prevents the ERP's critical finding:
 * an unscoped `db` export that bypassed row-level security.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '@/core/config/env';
import { schema } from './schema';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
});

export const _db = drizzle(pool, { schema });

// NOT EXPORTED. The only way to reach the database is through the wrappers.
// ESLint rule hms/no-raw-db prevents importing this file from outside core/db.
