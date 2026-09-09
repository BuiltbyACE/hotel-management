/**
 * core/db/sequence.ts
 *
 * Gap-free per-property numbering via number_sequences under an advisory lock.
 * Used for booking references (BK-2026-000123) and invoice numbers (INV-…).
 * Mirrors blueprint §6.5.7 and drizzle/0001 §7.
 *
 * The advisory lock serialises allocators; the composite PK on
 * (property_id, name, period) makes concurrent first-allocations safe.
 */
import { sql } from 'drizzle-orm';
import { numberSequences } from './infra';
import type { Tx } from './index';
import { withAdvisoryLock } from './index';

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