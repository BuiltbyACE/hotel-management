/**
 * Validation schemas for the housekeeping board (§13.4).
 */
import { describe, expect, it } from 'vitest';
import { boardQuerySchema, updateHousekeepingSchema } from '../validation';

describe('boardQuerySchema', () => {
  it('accepts an empty query (defaults to today)', () => {
    expect(boardQuerySchema.parse({})).toEqual({});
  });

  it('accepts a valid date', () => {
    expect(boardQuerySchema.parse({ date: '2026-09-09' })).toEqual({ date: '2026-09-09' });
  });

  it('rejects a malformed date', () => {
    expect(() => boardQuerySchema.parse({ date: '09/09/2026' })).toThrow();
  });
});

describe('updateHousekeepingSchema', () => {
  it('accepts a housekeeping-only flip', () => {
    expect(updateHousekeepingSchema.parse({ housekeeping: 'dirty' })).toEqual({ housekeeping: 'dirty' });
  });

  it('accepts a condition-only flip', () => {
    expect(updateHousekeepingSchema.parse({ condition: 'cleaning' })).toEqual({ condition: 'cleaning' });
  });

  it('accepts both fields', () => {
    expect(updateHousekeepingSchema.parse({ housekeeping: 'inspected', condition: 'available' })).toEqual({
      housekeeping: 'inspected',
      condition: 'available',
    });
  });

  it('rejects an empty body', () => {
    expect(() => updateHousekeepingSchema.parse({})).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => updateHousekeepingSchema.parse({ housekeeping: 'clean', note: 'x' })).toThrow();
  });

  it('rejects invalid enum values', () => {
    expect(() => updateHousekeepingSchema.parse({ housekeeping: 'sparkly' })).toThrow();
    expect(() => updateHousekeepingSchema.parse({ condition: 'sold' })).toThrow();
  });
});