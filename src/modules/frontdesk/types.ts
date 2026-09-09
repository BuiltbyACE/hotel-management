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

/** Audit identity for the night audit — structurally matches audit/system actors. */
export interface NightAuditActor {
  id: string | null;
  name: string;
  role: 'admin' | 'manager' | 'receptionist' | null;
}

/** One property's frozen day (§13.3 → daily_stats, §18 freeze row). */
export interface DailyStatsView {
  propertyId: string;
  businessDate: string;
  roomsTotal: number;
  roomsSellable: number;
  roomsSold: number;
  occupancyPct: string;
  roomRevenue: string;
  otherRevenue: string;
  totalRevenue: string;
  adr: string;
  revpar: string;
  arrivals: number;
  departures: number;
  inHouse: number;
  noShows: number;
  cancellations: number;
  expensesTotal: string;
  paymentsTotal: string;
  computedAt: string;
}

/** The outcome of one property's night-audit pass (§13.3). */
export interface NightAuditResultView {
  propertyId: string;
  targetDate: string;
  noShowsMarked: number;
  noShowReferences: string[];
  stayoversFlagged: string[];
  nightsPosted: number;
  roomRevenue: string;
  totalRevenue: string;
  reconcileMismatchCount: number;
  stats: DailyStatsView;
}