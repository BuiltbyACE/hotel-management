/**
 * core/dates/index.ts
 *
 * DateOnly is a branded string type: '2026-09-14'.
 * Calendar facts (arrival_date, stay_date, etc.) are DateOnly.
 * Instants (checked_in_at, created_at) are timestamptz stored as Date objects.
 *
 * Rules:
 * - arrival_date, departure_date, stay_date, expense_date, charge_date, business_date
 *   are DateOnly strings. They are never Date objects with a time component.
 * - A stay of arrival D1 to departure D2 occupies nights D1 … D2-1.
 *   nights = D2 - D1. A one-night stay has D2 = D1 + 1.
 * - Nothing uses new Date().toISOString().slice(0,10) on the server.
 *   That is UTC and is wrong for 3 hours a day in Nairobi.
 * - The business day rolls at the night audit, not at midnight.
 */
import { format as dfFormat, parseISO, differenceInCalendarDays } from 'date-fns';
import { TZDate } from '@date-fns/tz';

export type DateOnly = `${string}-${string}-${string}` & { readonly __brand: 'DateOnly' };

const HOTEL_TZ = 'Africa/Nairobi';

/**
 * Create a DateOnly from today or a specific date.
 * Uses the hotel's timezone, not UTC.
 */
export function businessDate(at: Date = new Date(), tz: string = HOTEL_TZ): DateOnly {
  const tzDate = new TZDate(at, tz);
  return dfFormat(tzDate, 'yyyy-MM-dd') as DateOnly;
}

/**
 * Parse a DateOnly string into a Date object set to midnight in the hotel timezone.
 */
export function parseDateOnly(d: DateOnly): Date {
  return parseISO(`${d}T00:00:00`);
}

/**
 * Calculate the number of nights between arrival and departure.
 * A stay of D1 to D2 has nights D1 … D2-1, so nights = D2 - D1.
 */
export function nightCount(arrival: DateOnly, departure: DateOnly): number {
  return differenceInCalendarDays(parseDateOnly(departure), parseDateOnly(arrival));
}

/**
 * Generate an array of DateOnly strings for each night of a stay.
 * A stay from "2026-09-10" to "2026-09-13" returns:
 * ["2026-09-10", "2026-09-11", "2026-09-12"]
 */
export function nightsBetween(arrival: DateOnly, departure: DateOnly): DateOnly[] {
  const nights: DateOnly[] = [];
  const count = nightCount(arrival, departure);
  for (let i = 0; i < count; i++) {
    const d = new Date(parseDateOnly(arrival));
    d.setDate(d.getDate() + i);
    nights.push(dfFormat(d, 'yyyy-MM-dd') as DateOnly);
  }
  return nights;
}

/**
 * Add days to a DateOnly.
 */
export function addDays(d: DateOnly, days: number): DateOnly {
  const date = parseDateOnly(d);
  date.setDate(date.getDate() + days);
  return dfFormat(date, 'yyyy-MM-dd') as DateOnly;
}

/**
 * Format a DateOnly for display.
 */
export function formatDateOnly(d: DateOnly, fmt: string = 'dd MMM yyyy'): string {
  return dfFormat(parseDateOnly(d), fmt);
}

/**
 * Check if a date is before another DateOnly.
 */
export function isBefore(a: DateOnly, b: DateOnly): boolean {
  return a < b;
}

/**
 * Check if a date is after another DateOnly.
 */
export function isAfter(a: DateOnly, b: DateOnly): boolean {
  return a > b;
}

/**
 * Check if two date ranges overlap.
 * Both ranges are [start, end) — exclusive end.
 */
export function rangesOverlap(
  aStart: DateOnly,
  aEnd: DateOnly,
  bStart: DateOnly,
  bEnd: DateOnly,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Get today as a DateOnly in the hotel timezone.
 */
export function today(): DateOnly {
  return businessDate();
}
