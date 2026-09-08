/**
 * core/db/asMigrator.ts
 *
 * Test-only escape hatch: run a raw statement as the hms_migrator role.
 * Needed because the app role (hms_app) is deliberately DELETE-revoked on the
 * financial/append-only tables — tests that seed those tables must clean up
 * with the schema owner.
 *
 * The existence of this file does NOT loosen the boundary rule: pg remains
 * banned outside core/db, and this is inside core/db.
 */
import { Pool } from 'pg';

const MIGRATION_URL = process.env.MIGRATION_DATABASE_URL;
if (!MIGRATION_URL) throw new Error('MIGRATION_DATABASE_URL is required to use runAsMigrator');

const pool = new Pool({ connectionString: MIGRATION_URL, max: 2 });

/**
 * Execute a statement as the migration (schema-owner) role. Return rows.
 */
export async function runAsMigrator(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const res = await pool.query(query, params);
  return res.rows as Record<string, unknown>[];
}

let ended = false;
export async function closeMigratorPool(): Promise<void> {
  if (ended) return;
  ended = true;
  await pool.end();
}