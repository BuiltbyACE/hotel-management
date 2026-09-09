/**
 * Integration test: gap-free number sequences under the advisory lock.
 * Requires a running Postgres (docker-compose up -d).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTx } from '@/core/db';
import { numberSequences } from '@/core/db/infra';
import { nextNumber } from '@/core/db/sequence';
import { schema } from '@/core/db';

const PERIOD = '2026-09';
const NAME = 'booking';
let propertyId = '';

beforeAll(async () => {
  const [p] = await withTx((tx) =>
    tx
      .insert(schema.properties)
      .values({
        name: `seq-probe-${Date.now()}`,
        country: 'KE',
        timezone: 'Africa/Nairobi',
        currency: 'KES',
      })
      .returning({ id: schema.properties.id }),
  );
  propertyId = p!.id;
});

afterAll(async () => {
  await withTx((tx) =>
    tx.delete(numberSequences).where(eq(numberSequences.propertyId, propertyId)),
  );
  await withTx((tx) => tx.delete(schema.properties).where(eq(schema.properties.id, propertyId)));
});

describe('nextNumber', () => {
  it('allocates 000001, 000002, 000003 gap-free across transactions', async () => {
    const a = await withTx((tx) => nextNumber(tx, propertyId, NAME, { prefix: 'BK-', period: PERIOD }));
    const b = await withTx((tx) => nextNumber(tx, propertyId, NAME, { prefix: 'BK-', period: PERIOD }));
    const c = await withTx((tx) => nextNumber(tx, propertyId, NAME, { prefix: 'BK-', period: PERIOD }));

    expect([a.value, b.value, c.value]).toEqual([1, 2, 3]);
    expect([a.reference, b.reference, c.reference]).toEqual([
      'BK-000001',
      'BK-000002',
      'BK-000003',
    ]);
  });

  it('keeps different periods on separate counters', async () => {
    const next = await withTx((tx) => nextNumber(tx, propertyId, NAME, { prefix: 'BK-', period: '2026-10' }));
    expect(next.value).toBe(1);
    expect(next.reference).toBe('BK-000001');
  });

  it('is independent per name (invoices vs bookings)', async () => {
    const invoice = await withTx((tx) => nextNumber(tx, propertyId, 'invoice', { prefix: 'INV-', period: PERIOD }));
    expect(invoice.value).toBe(1);
    expect(invoice.reference).toBe('INV-000001');
  });

  it('keeps different names on separate counters on the same period', async () => {
    // regression: the allocator must not clobber a sibling sequence when it
    // writes (booking + invoice share the property, not the counter).
    const a = await withTx((tx) => nextNumber(tx, propertyId, 'booking2', { prefix: 'BK2-', period: PERIOD }));
    const b = await withTx((tx) => nextNumber(tx, propertyId, 'invoice2', { prefix: 'INV2-', period: PERIOD }));
    const a2 = await withTx((tx) => nextNumber(tx, propertyId, 'booking2', { prefix: 'BK2-', period: PERIOD }));

    expect([a.value, b.value, a2.value]).toEqual([1, 1, 2]);
    expect(a2.reference).toBe('BK2-000002');
    expect(b.reference).toBe('INV2-000001');
  });

  it('serializes concurrent allocators without gaps (pseudo-concurrency)', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTx((tx) => nextNumber(tx, propertyId, 'concurrent', { prefix: 'CN-', period: PERIOD })),
      ),
    );
    const values = results.map((r) => r.value).sort((x, y) => x - y);
    expect(values).toEqual([1, 2, 3, 4, 5]);
  });
});