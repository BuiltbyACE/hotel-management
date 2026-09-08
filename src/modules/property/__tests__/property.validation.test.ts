/**
 * Unit test: property route-facing schemas (no DB required).
 */
import { describe, expect, it } from 'vitest';
import {
  changeConditionSchema,
  listRoomsQuerySchema,
  rateRuleCreateSchema,
  roomTypeCreateSchema,
  updateSettingsSchema,
} from '@/modules/property/validation';

describe('roomTypeCreateSchema', () => {
  it('uppercases the code and fills defaults', () => {
    const out = roomTypeCreateSchema.parse({ code: '  deluxe  ', name: 'Deluxe', baseRate: 12500 });
    expect(out.code).toBe('DELUXE');
    expect(out.maxOccupancy).toBe(2);
    expect(out.extraBedRate).toBe(0);
    expect(out.isActive).toBe(true);
  });

  it('rejects negative or over-precise money', () => {
    expect(roomTypeCreateSchema.safeParse({ code: 'A', name: 'A', baseRate: -1 }).success).toBe(false);
    expect(roomTypeCreateSchema.safeParse({ code: 'A', name: 'A', baseRate: 12.999 }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(roomTypeCreateSchema.safeParse({ code: 'A', name: '  ', baseRate: 100 }).success).toBe(false);
  });
});

describe('changeConditionSchema', () => {
  it('accepts a valid transition with a note', () => {
    const out = changeConditionSchema.parse({ condition: 'maintenance', note: 'flood' });
    expect(out.condition).toBe('maintenance');
    expect(out.note).toBe('flood');
  });

  it('rejects unknown conditions', () => {
    expect(changeConditionSchema.safeParse({ condition: 'haunted' }).success).toBe(false);
  });
});

describe('rateRuleCreateSchema', () => {
  it('accepts days within range and defaults to every day', () => {
    const out = rateRuleCreateSchema.parse({ name: 'Off-peak', validFrom: '2026-01-01', validTo: '2026-12-31', rate: 5000 });
    expect(out.daysOfWeek).toHaveLength(7);
    expect(out.minNights).toBe(1);
  });

  it('rejects validTo before validFrom', () => {
    const res = rateRuleCreateSchema.safeParse({ name: 'Broken', validFrom: '2026-06-01', validTo: '2026-05-01', rate: 5000 });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('validTo'))).toBe(true);
    }
  });
});

describe('listRoomsQuerySchema', () => {
  it('coerces page params', () => {
    const out = listRoomsQuerySchema.parse({ page: '2', pageSize: '50' });
    expect(out.page).toBe(2);
    expect(out.pageSize).toBe(50);
  });
});

describe('updateSettingsSchema', () => {
  it('requires at least one setting', () => {
    expect(updateSettingsSchema.safeParse({ settings: [] }).success).toBe(false);
  });
});