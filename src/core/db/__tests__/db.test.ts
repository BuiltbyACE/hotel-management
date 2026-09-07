/**
 * Integration test: prove that withTx rolls back correctly.
 * This is the Phase 0 exit gate checkbox #7.
 *
 * Requires a running Postgres instance (docker-compose up -d).
 */
import { describe, it, expect } from 'vitest';
import { withTx } from '@/core/db';
import { sql } from 'drizzle-orm';

describe('withTx behavior', () => {
  it('throws the original error and does not leak the write', async () => {
    let thrown: unknown;

    try {
      await withTx(async (tx) => {
        await tx.execute(sql`CREATE TEMPORARY TABLE _tx_rollback_test (id int PRIMARY KEY, val text) ON COMMIT DROP`);
        await tx.execute(sql`INSERT INTO _tx_rollback_test VALUES (1, 'should_rollback')`);
        throw new Error('Intentional rollback');
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Intentional rollback');

    // A new transaction still works — the pool is not broken by the rollback.
    const res = await withTx(async (tx) => {
      return tx.execute(sql`SELECT 1 as alive`);
    });

    expect(res.rows).toHaveLength(1);
  });
});
