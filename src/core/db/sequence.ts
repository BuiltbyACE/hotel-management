/**
 * core/db/sequence.ts
 *
 * Per-property reference numbering. Two allocation modes:
 *
 * nextNumber (advisory lock) — gap-free; for financial/legal references
 *   (RC- receipts, INV- invoices). Serialises all allocators for a given
 *   property+name+period under a transaction-scoped advisory lock.
 *
 * nextNumberFast (atomic upsert) — gaps allowed; for operational references
 *   (BK- bookings, EX- expenses, MT- maintenance). Lock held for the duration
 *   of one INSERT…ON CONFLICT row write only — microseconds, not the entire
 *   outer transaction. Numbers may have gaps when the caller's transaction
 *   rolls back after allocation.
 *
 * Mirrors blueprint §6.5.7 and drizzle/0001 §7.
 */
import { sql } from 'drizzle-orm';
import { numberSequences } from './infra';
import type { Tx } from './index';
import { withAdvisoryLock, withDb } from './index';

export interface NextNumberResult {
  value: number;
  prefix: string;
  reference: string;
}

/**
 * Allocate the next number in a sequence.
 * `period` is e.g. '2026' or '2026-09' — the reference is unique per
 * (property, name, period). Pass the current period from core/dates.
 */
export async function nextNumber(
  tx: Tx,
  propertyId: string,
  name: string,
  opts: { prefix: string; period: string; pad?: number },
): Promise<NextNumberResult> {
  const pad = opts.pad ?? 6;
  return withAdvisoryLock(tx, `seq:${propertyId}:${name}:${opts.period}`, async () => {
    const existing = await tx
      .select()
      .from(numberSequences)
      .where(
        sql`${numberSequences.propertyId} = ${propertyId}
            AND ${numberSequences.name} = ${name}
            AND ${numberSequences.period} = ${opts.period}`,
      );

    const nextValue = existing[0]?.nextValue ?? 1;

    const row = existing[0]
      ? await tx
          .update(numberSequences)
          .set({ nextValue: nextValue + 1 })
          .where(
            sql`${numberSequences.propertyId} = ${propertyId}
                AND ${numberSequences.name} = ${name}
                AND ${numberSequences.period} = ${opts.period}`,
          )
          .returning()
      : await tx
          .insert(numberSequences)
          .values({ propertyId, name, prefix: opts.prefix, period: opts.period })
          .onConflictDoNothing()
          .returning();

    const value = row[0]?.nextValue ?? nextValue;
    return {
      value,
      prefix: opts.prefix,
      reference: `${opts.prefix}${String(value).padStart(pad, '0')}`,
    };
  });
}

/**
 * Fast sequence allocation for operational references (BK-, EX-, MT-).
 * Atomic `INSERT … ON CONFLICT DO UPDATE RETURNING` in its own autocommit
 * connection — row-level lock held for microseconds, not the outer transaction.
 * Gaps are possible when the caller's outer transaction rolls back after
 * allocation. Acceptable for non-financial operational references.
 */
export async function nextNumberFast(
  propertyId: string,
  name: string,
  opts: { prefix: string; period: string; pad?: number },
): Promise<NextNumberResult> {
  const pad = opts.pad ?? 6;
  const result = await withDb((db) =>
    db.execute(sql`
      INSERT INTO number_sequences (property_id, name, prefix, period, next_value)
      VALUES (${propertyId}, ${name}, ${opts.prefix}, ${opts.period}, 1)
      ON CONFLICT (property_id, name, period)
      DO UPDATE SET next_value = number_sequences.next_value + 1
      RETURNING next_value AS value, prefix
    `),
  );
  const row = result.rows[0] as { value: string | number; prefix: string };
  const value = Number(row.value);
  return {
    value,
    prefix: row.prefix,
    reference: `${row.prefix}${String(value).padStart(pad, '0')}`,
  };
}