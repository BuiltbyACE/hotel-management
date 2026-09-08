/**
 * Unit test: availability route-facing schemas (no DB required).
 */
import { describe, expect, it } from 'vitest';
import {
  calendarQuerySchema,
  findRoomsQuerySchema,
  quoteBodySchema,
  tapeQuerySchema,
} from '@/modules/availability/validation';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('findRoomsQuerySchema', () => {
  it('accepts a valid range', () => {
    const out = findRoomsQuerySchema.parse({ arrival: '2026-10-01', departure: '2026-10-03' });
    expect(out.arrival).toBe('2026-10-01');
  });

  it('rejects departure on or before arrival', () => {
    expect(findRoomsQuerySchema.safeParse({ arrival: '2026-10-03', departure: '2026-10-01' }).success).toBe(false);
    expect(findRoomsQuerySchema.safeParse({ arrival: '2026-10-01', departure: '2026-10-01' }).success).toBe(false);
  });

  it('allows a full-year window but rejects longer', () => {
    // 366 nights (2026-01-01 → 2027-01-02) is allowed
    expect(
      findRoomsQuerySchema.safeParse({ arrival: '2026-01-01', departure: '2027-01-02' }).success,
    ).toBe(true);
    // 367 nights is not
    expect(
      findRoomsQuerySchema.safeParse({ arrival: '2026-01-01', departure: '2027-01-03' }).success,
    ).toBe(false);
  });

  it('rejects a malformed date', () => {
    expect(findRoomsQuerySchema.safeParse({ arrival: '2026/10/01', departure: '2026-10-03' }).success).toBe(false);
  });
});

describe('calendarQuerySchema / tapeQuerySchema', () => {
  it('parse from/to', () => {
    expect(calendarQuerySchema.parse({ from: '2026-10-01', to: '2026-10-05', roomTypeId: UUID }).roomTypeId).toBe(UUID);
    expect(tapeQuerySchema.parse({ from: '2026-10-01', to: '2026-10-05' }).to).toBe('2026-10-05');
  });
});

describe('quoteBodySchema', () => {
  it('defaults adults and children', () => {
    const out = quoteBodySchema.parse({ roomTypeId: UUID, arrival: '2026-10-01', departure: '2026-10-02' });
    expect(out.adults).toBe(1);
    expect(out.children).toBe(0);
  });

  it('rejects an invalid room type and zero adults', () => {
    expect(quoteBodySchema.safeParse({ roomTypeId: 'nope', arrival: '2026-10-01', departure: '2026-10-02' }).success).toBe(false);
    expect(
      quoteBodySchema.safeParse({ roomTypeId: UUID, arrival: '2026-10-01', departure: '2026-10-02', adults: 0 }).success,
    ).toBe(false);
  });
});