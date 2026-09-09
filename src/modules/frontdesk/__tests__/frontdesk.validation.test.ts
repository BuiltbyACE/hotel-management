/**
 * Validation schemas for the front desk (§16.3).
 */
import { describe, expect, it } from 'vitest';
import { dateQuerySchema, walkInSchema } from '../validation';

describe('dateQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(dateQuerySchema.parse({})).toEqual({});
  });

  it('accepts a valid date', () => {
    expect(dateQuerySchema.parse({ date: '2026-09-09' })).toEqual({ date: '2026-09-09' });
  });

  it('rejects a malformed date', () => {
    expect(() => dateQuerySchema.parse({ date: 'yesterday' })).toThrow();
  });
});

describe('walkInSchema', () => {
  const valid = {
    guest: { fullName: 'Jane Kamau', phone: '+254712345678' },
    rooms: [{ roomId: '00000000-0000-4000-8000-000000000001', arrival: '2026-09-09', departure: '2026-09-11', adults: 2 }],
  };

  it('accepts a valid walk-in', () => {
    const parsed = walkInSchema.parse(valid);
    expect(parsed.rooms[0]!.children).toBe(0);
  });

  it('accepts an optional payment', () => {
    const parsed = walkInSchema.parse({ ...valid, payment: { amount: '5000.00', method: 'cash' } });
    expect(parsed.payment).toEqual({ amount: '5000.00', method: 'cash', reference: undefined, notes: undefined });
  });

  it('rejects a non-positive payment', () => {
    expect(() => walkInSchema.parse({ ...valid, payment: { amount: '0', method: 'cash' } })).toThrow();
  });

  it('rejects an un-decimal payment amount', () => {
    expect(() => walkInSchema.parse({ ...valid, payment: { amount: '50.123', method: 'cash' } })).toThrow();
  });

  it('rejects empty rooms', () => {
    expect(() => walkInSchema.parse({ ...valid, rooms: [] })).toThrow();
  });

  it('rejects a departure before or equal to arrival', () => {
    expect(() =>
      walkInSchema.parse({
        ...valid,
        rooms: [{ roomId: '00000000-0000-4000-8000-000000000001', arrival: '2026-09-11', departure: '2026-09-11', adults: 1 }],
      }),
    ).toThrow();
  });
});