/**
 * modules/frontdesk/types.ts
 *
 * Front-desk read views (blueprint §16.3) — the today board, the arrivals /
 * departures / in-house lists, and the walk-in result. The module owns no DDL;
 * it composes read projections over the bookings + availability services and
 * orchestrates the walk-in through the booking engine.
 */

/** One room on the arrivals / departures / in-house lists. */
export interface LedgerRowView {
  bookingId: string;
  reference: string;
  status: string;
  guestName: string;
  roomId: string;
  roomNumber: string;
  date: string;
}

/** The GET /v1/frontdesk/today collapse for a business date. */
export interface TodaySummaryView {
  date: string;
  roomsTotal: number;
  roomsOccupied: number;
  roomsVacant: number;
  occupancyPct: number;
  arrivals: LedgerRowView[];
  departures: LedgerRowView[];
  inHouse: LedgerRowView[];
}