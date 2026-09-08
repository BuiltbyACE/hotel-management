/**
 * Integration test: prove the Drizzle schema mirror maps camelCase keys to the
 * snake_case columns in drizzle/0001_full_schema.sql. Without this, a silent
 * key/dbname mismatch in any module schema would corrupt queries.
 *
 * Requires a running Postgres instance (docker-compose up -d).
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';

describe('drizzle schema mirror', () => {
  it('maps camelCase property columns to snake_case DDL (insert + select round-trip)', async () => {
    const created = await withDb((db) =>
      db
        .insert(schema.properties)
        .values({
          name: `mirror-probe-${Date.now()}`,
          country: 'KE',
          timezone: 'Africa/Nairobi',
          currency: 'KES',
          checkInTime: '14:00',
          checkOutTime: '10:00',
        })
        .returning({ id: schema.properties.id }),
    );

    expect(created).toHaveLength(1);

    const read = await withDb((db) =>
      db
        .select({
          id: schema.properties.id,
          checkInTime: schema.properties.checkInTime,
          currency: schema.properties.currency,
        })
        .from(schema.properties)
        .where(eq(schema.properties.id, created[0]!.id)),
    );

    expect(read[0]?.checkInTime).toBe('14:00:00'); // Postgres time serializes with seconds
    expect(read[0]?.currency).toBe('KES');
  });

  it('enforces the shared enums by name across re-declared modules', async () => {
    // activity_logs (audit) re-declares user_role; inserting through it proves
    // the name-collision-free schema construction. Activity logs are append-only
    // for the app role (INSERT allowed, DELETE revoked).
    const inserted = await withTx(async (tx) =>
      tx
        .insert(schema.activityLogs)
        .values({ actorName: 'mirror-probe', actorRole: 'admin', action: 'probe', entityType: 'probe', summary: 'probe' })
        .returning({ id: schema.activityLogs.id }),
    );

    expect(inserted).toHaveLength(1);

    // hms_app has DELETE revoked AND activity_logs carries DO INSTEAD NOTHING
    // rules — DELETE is a silent no-op (rowCount 0), never a real removal.
    const del = await withTx((tx) =>
      tx.delete(schema.activityLogs).where(eq(schema.activityLogs.id, inserted[0]!.id)),
    );
    expect(del.rowCount).toBe(0);

    const stillThere = await withDb((db) =>
      db
        .select({ id: schema.activityLogs.id })
        .from(schema.activityLogs)
        .where(eq(schema.activityLogs.id, inserted[0]!.id)),
    );
    expect(stillThere).toHaveLength(1);
  });
});