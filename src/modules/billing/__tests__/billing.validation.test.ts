/**
 * Unit test: billing route-facing schemas (no DB required).
 */
import { describe, expect, it } from 'vitest';
import {
  issueInvoiceSchema,
  listInvoicesQuerySchema,
  postChargeSchema,
  voidChargeSchema,
  voidInvoiceSchema,
} from '@/modules/billing/validation';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('postChargeSchema', () => {
  it('accepts a valid taxed charge and defaults quantity', () => {
    const out = postChargeSchema.parse({
      chargeType: 'extra',
      description: 'Laundry',
      unitAmount: '500.00',
    });
    expect(out.quantity).toBe(1);
  });

  it('accepts negative unit amounts for discounts', () => {
    const out = postChargeSchema.parse({
      chargeType: 'discount',
      description: 'Goodwill',
      unitAmount: '-500.00',
    });
    expect(out.unitAmount).toBe('-500.00');
  });

  it('rejects a negative amount on a non-discount charge', () => {
    expect(
      postChargeSchema.safeParse({
        chargeType: 'extra',
        description: 'Laundry',
        unitAmount: '-100.00',
      }).success,
    ).toBe(false);
  });

  it('rejects a zero amount, bad money format and unknown keys', () => {
    expect(
      postChargeSchema.safeParse({
        chargeType: 'extra',
        description: 'Laundry',
        unitAmount: '0.00',
      }).success,
    ).toBe(false);
    expect(
      postChargeSchema.safeParse({
        chargeType: 'extra',
        description: 'Laundry',
        unitAmount: '1e5',
      }).success,
    ).toBe(false);
    expect(
      postChargeSchema.safeParse({
        chargeType: 'extra',
        description: 'Laundry',
        unitAmount: '100.00',
        sneaky: true,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid charge type and a blank description', () => {
    expect(
      postChargeSchema.safeParse({ chargeType: 'freebie', description: 'x', unitAmount: '1.00' }).success,
    ).toBe(false);
    expect(
      postChargeSchema.safeParse({ chargeType: 'extra', description: '  ', unitAmount: '1.00' }).success,
    ).toBe(false);
  });

  it('accepts a numeric quantity for multi-unit charges', () => {
    const out = postChargeSchema.parse({
      chargeType: 'service',
      description: 'Spa',
      quantity: '2',
      unitAmount: '1500.00',
    });
    expect(out.quantity).toBe(2);
  });
});

describe('voidChargeSchema', () => {
  it('requires a reason of at least 3 characters', () => {
    expect(voidChargeSchema.safeParse({ reason: 'No' }).success).toBe(false);
    expect(voidChargeSchema.safeParse({ reason: 'Wrong item posted' }).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(voidChargeSchema.safeParse({ reason: 'Wrong item', x: 1 }).success).toBe(false);
  });
});

describe('issueInvoiceSchema', () => {
  it('requires a booking id', () => {
    expect(issueInvoiceSchema.safeParse({ bookingId: 'nope' }).success).toBe(false);
    expect(issueInvoiceSchema.safeParse({ bookingId: UUID }).success).toBe(true);
    expect(issueInvoiceSchema.safeParse({}).success).toBe(false);
  });
});

describe('voidInvoiceSchema', () => {
  it('requires a reason', () => {
    expect(voidInvoiceSchema.safeParse({ reason: 'x' }).success).toBe(false);
    expect(voidInvoiceSchema.safeParse({ reason: 'Duplicate invoice' }).success).toBe(true);
  });
});

describe('listInvoicesQuerySchema', () => {
  it('defaults to page 1 and pageSize 25', () => {
    const out = listInvoicesQuerySchema.parse({});
    expect(out.page).toBe(1);
    expect(out.pageSize).toBe(25);
  });

  it('rejects bad status, dates and page sizes', () => {
    expect(listInvoicesQuerySchema.safeParse({ status: 'refunded' }).success).toBe(false);
    expect(listInvoicesQuerySchema.safeParse({ from: '10/01/2026' }).success).toBe(false);
    expect(listInvoicesQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
  });
});