/**
 * Unit test: bookings route-facing schemas (no DB required).
 */
import { describe, expect, it } from 'vitest';
import {
  cancelBookingSchema,
  checkInBodySchema,
  checkoutBodySchema,
  createBookingSchema,
  listBookingsQuerySchema,
  recordPaymentSchema,
  reversePaymentSchema,
} from '@/modules/bookings/validation';

const UUID = '11111111-1111-4111-8111-111111111111';

const base = {
  guest: { fullName: 'Ada Lovelace', phone: '+254700000001' },
  rooms: [{ roomId: UUID, arrival: '2026-10-01', departure: '2026-10-03', adults: 1 }],
};

describe('createBookingSchema', () => {
  it('accepts a valid booking and defaults source', () => {
    const out = createBookingSchema.parse(base);
    expect(out.source).toBe('front_desk');
    expect(out.rooms[0]!.children).toBe(0);
  });

  it('rejects zero rooms and zero adults', () => {
    expect(createBookingSchema.safeParse({ ...base, rooms: [] }).success).toBe(false);
    expect(
      createBookingSchema.safeParse({
        ...base,
        rooms: [{ roomId: UUID, arrival: '2026-10-01', departure: '2026-10-03', adults: 0 }],
      }).success,
    ).toBe(false);
  });

  it('rejects departure on or before arrival', () => {
    expect(
      createBookingSchema.safeParse({
        ...base,
        rooms: [{ roomId: UUID, arrival: '2026-10-03', departure: '2026-10-01', adults: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects a bad room id and a malformed date', () => {
    expect(
      createBookingSchema.safeParse({
        ...base,
        rooms: [{ roomId: 'nope', arrival: '2026-10-01', departure: '2026-10-03', adults: 1 }],
      }).success,
    ).toBe(false);
    expect(
      createBookingSchema.safeParse({
        ...base,
        rooms: [{ roomId: UUID, arrival: '2026/10/01', departure: '2026-10-03', adults: 1 }],
      }).success,
    ).toBe(false);
  });

  it('rejects a non-positive payment amount', () => {
    expect(
      createBookingSchema.safeParse({ ...base, payment: { amount: '0.00', method: 'cash' } }).success,
    ).toBe(false);
  });

  it('accepts an overrideRate and special requests', () => {
    const out = createBookingSchema.safeParse({
      ...base,
      rooms: [{ roomId: UUID, arrival: '2026-10-01', departure: '2026-10-03', adults: 1, overrideRate: 4500 }],
      specialRequests: 'Quiet room please',
    });
    expect(out.success).toBe(true);
  });
});

describe('listBookingsQuerySchema', () => {
  it('parses page and pageSize', () => {
    const out = listBookingsQuerySchema.parse({ page: 2, pageSize: 10, status: 'confirmed' });
    expect(out.page).toBe(2);
    expect(out.status).toBe('confirmed');
  });

  it('rejects an unknown status', () => {
    expect(listBookingsQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
  });
});

describe('cancel / reverse / check-in / check-out schemas', () => {
  it('requires a reason of at least 5 characters', () => {
    expect(cancelBookingSchema.safeParse({ reason: 'nope' }).success).toBe(false);
    expect(reversePaymentSchema.safeParse({ reason: 'No' }).success).toBe(false);
    expect(cancelBookingSchema.parse({ reason: 'Guest changed their mind' }).reason).toBe('Guest changed their mind');
    expect(reversePaymentSchema.parse({ reason: 'Wrong amount charged' }).reason).toBe('Wrong amount charged');
  });

  it('allows an empty override reason and an optional early departure', () => {
    expect(checkInBodySchema.safeParse({}).success).toBe(true);
    expect(checkInBodySchema.parse({ overrideDepositReason: 'Wire transfer pending' }).overrideDepositReason).toBe(
      'Wire transfer pending',
    );
    expect(checkoutBodySchema.parse({ earlyDeparture: '2026-10-02' }).earlyDeparture).toBe('2026-10-02');
    expect(checkoutBodySchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    expect(cancelBookingSchema.safeParse({ reason: 'Guest changed their mind', extra: 1 }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ amount: '100.00', method: 'cash', surprise: true }).success).toBe(false);
  });
});