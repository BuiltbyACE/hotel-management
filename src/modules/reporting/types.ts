/**
 * modules/reporting/types.ts
 *
 * Reporting read views (blueprint §18). The module owns no DDL except the
 * daily_stats read model; reports read daily_stats for anything frozen (§18.1)
 * and only "today's" numbers are computed live. Views here are the shapes the
 * /v1/reports/* and /v1/dashboard routes return.
 */

/** One room on an arrivals / departures list (structural mirror of frontdesk's). */
export interface LedgerRowView {
  bookingId: string;
  reference: string;
  status: string;
  guestName: string;
  roomId: string;
  roomNumber: string;
  date: string;
}

/** A trending period bucket from daily_stats (§18.2 Room occupancy). */
export interface OccupancyPeriodView {
  periodStart: string;
  label: string;
  roomsSold: number;
  roomsSellable: number;
  occupancyPct: string;
  adr: string;
  revpar: string;
  roomRevenue: string;
  totalRevenue: string;
  arrivals: number;
  departures: number;
}

export interface OccupancyReportView {
  from: string;
  to: string;
  groupBy: 'day' | 'week' | 'month';
  totals: {
    roomsSold: number;
    roomsSellable: number;
    occupancyPct: string;
    adr: string;
    revpar: string;
    roomRevenue: string;
    totalRevenue: string;
  };
  rows: OccupancyPeriodView[];
}

/** Revenue by dimension (§18.2 Revenue), from the price ledger or payments. */
export interface RevenueBreakdownRow {
  key: string;
  label: string;
  total: string;
}

export interface RevenueReportView {
  from: string;
  to: string;
  breakdown: 'day' | 'roomType' | 'source' | 'method';
  totals: { totalRevenue: string };
  rows: RevenueBreakdownRow[];
}

/** GET /v1/reports/arrivals-departures for one business date (operational). */
export interface ArrivalsDeparturesView {
  date: string;
  arrivals: LedgerRowView[];
  departures: LedgerRowView[];
}

/** One open/owing booking in the outstanding-balances report. */
export interface OutstandingRow {
  bookingId: string;
  reference: string;
  guestName: string;
  status: string;
  balance: string;
  departureDate: string;
  ageDays: number;
  bucket: string;
}

export interface OutstandingBalancesView {
  asOf: string;
  count: number;
  total: string;
  buckets: { bucket: string; count: number; total: string }[];
  rows: OutstandingRow[];
}

/** Expenses by category (or month), with MoM change against the prior period. */
export interface ExpenseGroupView {
  key: string;
  label: string;
  count: number;
  total: string;
  pctOfTotal: string;
  momChange: string | null;
}

export interface ExpenseReportView {
  from: string;
  to: string;
  groupBy: 'category' | 'month';
  count: number;
  total: string;
  rows: ExpenseGroupView[];
}

/** One maintenance issue with estimated vs actual cost (from the cost view). */
export interface MaintenanceCostRowView {
  issueId: string;
  reference: string;
  roomNumber: string | null;
  title: string;
  priority: string;
  reportedAt: string;
  estimatedCost: string;
  actualCost: string;
  expenseCount: number;
  variance: string;
}

export interface MaintenanceCostReportView {
  from: string;
  to: string;
  estimatedTotal: string;
  actualTotal: string;
  variance: string;
  rows: MaintenanceCostRowView[];
}

/** One month of revenue − expenses, from frozen daily_stats. */
export interface ProfitPeriodView {
  month: string;
  revenue: string;
  expenses: string;
  profit: string;
  marginPct: string;
}

export interface ProfitSummaryView {
  from: string;
  to: string;
  revenue: string;
  expenses: string;
  profit: string;
  marginPct: string;
  rows: ProfitPeriodView[];
}

/** One frozen day for the dashboard sparkline. */
export interface OccupancySparklinePoint {
  date: string;
  occupancyPct: string;
  adr: string;
  revpar: string;
  roomsSold: number;
}

/** Role-shaped dashboard payload (§18.4). */
export interface DashboardView {
  role: 'receptionist' | 'manager' | 'admin';
  date: string;
  today: {
    roomsTotal: number;
    roomsOccupied: number;
    roomsVacant: number;
    roomsReady: number;
    occupancyPct: number;
    arrivals: number;
    departures: number;
    inHouse: number;
  };
  sparkline: OccupancySparklinePoint[];
  financial?: {
    revenueToday: string;
    paymentsTodayByMethod: RevenueBreakdownRow[];
    outstandingBalance: string;
    openMaintenanceByPriority: { priority: string; count: number }[];
    revenueMtd: string;
    expensesMtd: string;
    profitMtd: string;
  };
  admin?: {
    activeUsers: number;
  };
}