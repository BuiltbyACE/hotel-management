/**
 * core/money/index.ts
 *
 * Money is a STRING in TypeScript ("1250.00").
 * Drizzle returns `numeric` as a string — keep it that way.
 * Parse to Decimal only inside this module for arithmetic.
 *
 * Rules:
 * - NUMERIC(14,2) in the database. Always.
 * - Money crossing a boundary is a string, never a JS number.
 * - Rounding is half-up to 2 dp, applied once at the line level, then summed.
 * - Never sum-then-round-then-sum.
 */
import Decimal from 'decimal.js-light';

// Configure decimal.js for consistent rounding
Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 20 });

export type Money = string;

/**
 * Create a Money value from a string or number.
 * Always rounds to 2 decimal places.
 */
export function of(v: string | number): Money {
  const d = new Decimal(v);
  return d.toDecimalPlaces(2).toString();
}

/**
 * Add multiple Money values together.
 */
export function add(...xs: Money[]): Money {
  return xs.reduce(
    (sum, x) => sum.add(new Decimal(x)),
    new Decimal(0),
  ).toDecimalPlaces(2).toString();
}

/**
 * Subtract b from a.
 */
export function sub(a: Money, b: Money): Money {
  return new Decimal(a).sub(new Decimal(b)).toDecimalPlaces(2).toString();
}

/**
 * Multiply a Money value by a number quantity.
 */
export function mul(a: Money, qty: number): Money {
  return new Decimal(a).mul(new Decimal(qty)).toDecimalPlaces(2).toString();
}

/**
 * Calculate percentage (e.g., tax). rate is a percentage like 16 for 16%.
 */
export function pct(a: Money, rate: number): Money {
  return new Decimal(a).mul(rate).div(100).toDecimalPlaces(2).toString();
}

/**
 * Compare two Money values.
 */
export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  const da = new Decimal(a);
  const db = new Decimal(b);
  return da.lessThan(db) ? -1 : da.greaterThan(db) ? 1 : 0;
}

/**
 * Check if a Money value is zero.
 */
export function isZero(a: Money): boolean {
  return new Decimal(a).isZero();
}

/**
 * Check if a Money value is positive.
 */
export function isPositive(a: Money): boolean {
  return new Decimal(a).isPositive();
}

/**
 * Check if a Money value is negative.
 */
export function isNegative(a: Money): boolean {
  return new Decimal(a).isNegative();
}

/**
 * Format a Money value with currency symbol.
 * e.g., format("1250.00", "KES") → "KES 1,250.00"
 */
export function format(a: Money, currency = 'KES'): string {
  const parts = new Decimal(a).toDecimalPlaces(2).toString().split('.');
  const intPart = parts[0]?.replace(/\B(?=(\d{3})+(?!\d))/g, ',') ?? '0';
  const decPart = parts[1] ?? '00';
  return `${currency} ${intPart}.${decPart}`;
}

/**
 * Parse a Money string back to Decimal (for internal calculations only).
 */
export function toDecimal(a: Money): Decimal {
  return new Decimal(a);
}

/**
 * The M namespace — shorthand for all money operations.
 * Usage: import { M } from '@/core/money';
 *        const total = M.add(charge1, charge2);
 */
export const M = {
  of,
  add,
  sub,
  mul,
  pct,
  cmp,
  isZero,
  isPositive,
  isNegative,
  format,
  toDecimal,
} as const;
