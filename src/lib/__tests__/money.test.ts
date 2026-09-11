import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/money';

describe('formatMoney', () => {
  it('formats positive decimal strings with thousands separators', () => {
    expect(formatMoney('7500.00')).toBe('KES 7,500.00');
    expect(formatMoney('1234567.89')).toBe('KES 1,234,567.89');
  });

  it('preserves sign without numeric coercion', () => {
    expect(formatMoney('-250.50')).toBe('KES -250.50');
  });

  it('handles integers and zero', () => {
    expect(formatMoney('0')).toBe('KES 0');
    expect(formatMoney('12')).toBe('KES 12');
  });

  it('defaults nullish and empty to zero', () => {
    expect(formatMoney(null)).toBe('KES 0');
    expect(formatMoney(undefined)).toBe('KES 0');
    expect(formatMoney('')).toBe('KES 0');
  });
});