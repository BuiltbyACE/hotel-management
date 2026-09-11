/**
 * Display-only money helpers.
 *
 * The backend delivers money as opaque decimal strings (numeric(14,2)::text).
 * Rules: never parseFloat, never do arithmetic. This file only formats.
 */
export function formatMoney(value: string | null | undefined, currency = 'KES'): string {
  if (value === null || value === undefined || value === '') return `${currency} 0`;
  return `${currency} ${formatDecimal(value)}`;
}

function formatDecimal(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split('.');
  const wholeWithGroups = (whole || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative ? '-' : '';
  if (fraction === undefined) return `${sign}${wholeWithGroups}`;
  return `${sign}${wholeWithGroups}.${fraction}`;
}