/**
 * GET /api/ready — readiness probe (§21). Succeeds only when the app role can
 * reach the DB AND the schema objects the app depends on are present. The
 * schema is bootstrap-SQL driven (no __drizzle_migrations table), so we probe
 * representative objects instead of a migrations ledger.
 */
import { sql } from 'drizzle-orm';
import { withDb } from '@/core/db';

export const GET = async () => {
  try {
    const ready = await withDb(async (db) => {
      await db.execute(sql`SELECT 1`);
      const res = await db.execute<{ present: boolean }>(sql`
        SELECT (
          to_regclass('public.properties') IS NOT NULL
          AND to_regclass('public.daily_stats') IS NOT NULL
          AND to_regclass('public.maintenance_cost_view') IS NOT NULL
        ) AS present
      `);
      return res.rows[0]?.present === true;
    });

    if (!ready) {
      return Response.json({ status: 'not_ready', db: 'ok', schema: 'incomplete' }, { status: 503 });
    }
    return Response.json({ status: 'ok', db: 'ok', schema: 'applied' });
  } catch {
    return Response.json({ status: 'not_ready', db: 'unreachable' }, { status: 503 });
  }
};

export const runtime = 'nodejs';