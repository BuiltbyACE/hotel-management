/**
 * core/db/index.ts
 *
 * The ONLY database surface the app may import.
 * Provides withDb, withTx, and withAdvisoryLock.
 * The pool itself is never exported.
 */
import { _db } from './client';
import { schema } from './schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres/session';
import type { PgTransaction } from 'drizzle-orm/pg-core';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = PgTransaction<NodePgQueryResultHKT, typeof schema>;

/**
 * Read-only / single-statement access.
 * Use this for queries that don't need transactional guarantees.
 */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return fn(_db);
}

/**
 * Transactional access. Everything that writes MUST use this.
 * If the callback throws, the transaction is rolled back automatically.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return _db.transaction(async (tx) => {
    return fn(tx as unknown as Tx);
  });
}

/**
 * Serialise a critical section by name using advisory locks.
 * Use this for number sequences and other contention-prone operations.
 */
export async function withAdvisoryLock<T>(
  tx: Tx,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = bigintHash(key);
  await tx.execute(`SELECT pg_advisory_xact_lock(${lockKey})`);
  return fn();
}

function bigintHash(str: string): bigint {
  let hash: bigint;
  hash = 0n;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5n) - hash) + BigInt(str.charCodeAt(i));
    hash = hash & 0xffffffffffffffffn;
  }
  return hash;
}

export { schema };