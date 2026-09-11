/**
 * Date helpers. All business dates run in the hotel timezone (Africa/Nairobi).
 * The backend sends ISO timestamps (timestamptz) and 'YYYY-MM-DD' calendar
 * dates. These helpers format both; no timezone math is done client-side.
 */
export const HOTEL_TIME_ZONE = 'Africa/Nairobi';

const dateFormatter = new Intl.DateTimeFormat('en-KE', {
  timeZone: HOTEL_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-KE', {
  timeZone: HOTEL_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateFormatter.format(typeof value === 'string' ? new Date(value) : value);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateTimeFormatter.format(typeof value === 'string' ? new Date(value) : value);
}

/** 'YYYY-MM-DD' → a Date pinned to midday UTC so day-value stays stable in the hotel timezone. */
export function parseCalendarDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, 12));
}

/** Date → 'YYYY-MM-DD'. Backend calendar dates are authoritative when available. */
export function toCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}