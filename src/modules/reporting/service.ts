/**
 * modules/reporting/service.ts
 *
 * Report and dashboard orchestration (blueprint §18). Every trend report
 * (occupancy, profit, revenue-by-day) reads the frozen `daily_stats` rows the
 * night audit wrote — never the live ledgers (§18.1). "Today" and the
 * breakdown probes (revenue, payments, outstanding balances) hit the live
 * tables, bounded by the actor's property.
 *
 * The module wrote nothing in Chunk 2-4; reporting is the read-across layer.
 */
import { format as dfFormat, parseISO } from 'date-fns';
import { z } from 'zod';
import { AppError } from '@/core/api';
import { withDb } from '@/core/db';
import { addDays, today, type DateOnly } from '@/core/dates';
import { M } from '@/core/money';
import { type Actor } from '@/modules/identity/auth-guard';
import { expectedArrivals, expectedDepartures, inHouseRooms } from '@/modules/bookings/service';
import { listRoomsForBoard } from '@/modules/property/service';
import {
  activeUsersCount,
  availabilityByRoomType,
  bookingSummaries,
  dailyRows,
  expenseGroups,
  folioRevenueByDimension,
  maintenanceCostRecords,
  maintenanceIssueRecords,
  openMaintenanceByPriority,
  outstandingRows,
  paymentsByMethodOn,
  resolvePropertyId,
  revenueOnDay,
} from './repository';
import type {
  ArrivalsDeparturesView,
  AvailabilitySnapshotView,
  BookingsPeriodView,
  BookingsReportView,
  DashboardView,
  ExpenseGroupView,
  ExpenseReportView,
  LedgerRowView,
  MaintenanceCostReportView,
  MaintenanceCostRowView,
  MaintenanceIssueRowView,
  MaintenanceIssuesReportView,
  OccupancyPeriodView,
  OccupancyReportView,
  OutstandingBalancesView,
  OutstandingRow,
  ProfitPeriodView,
  ProfitSummaryView,
  RevenueBreakdownRow,
  RevenueReportView,
  RoomAvailabilityRowView,
} from './types';
import type {
  AvailabilityQuery,
  BookingsQuery,
  ExpensesQuery,
  MaintenanceCostsQuery,
  MaintenanceIssuesQuery,
  OccupancyQuery,
  ProfitSummaryQuery,
  RevenueQuery,
} from './validation';
import {
  availabilityQuerySchema,
  bookingsQuerySchema,
  dateQuerySchema,
  expensesQuerySchema,
  maintenanceCostsQuerySchema,
  maintenanceIssuesQuerySchema,
  occupancyQuerySchema,
  profitSummaryQuerySchema,
  revenueQuerySchema,
} from './validation';

type GroupBy = 'day' | 'week' | 'month';
async function scopeProperty(actor: Actor): Promise<string> {
  const propertyId = await withDb((db) => resolvePropertyId(db, actor.propertyId));
  if (!propertyId) throw AppError.notFound('No active property is configured');
  return propertyId;
}

/** Report names a user may export (§18.3). Kept here so routes only touch service + validation. */
export const EXPORT_REPORT_NAMES = [
  'occupancy',
  'revenue',
  'arrivals-departures',
  'outstanding-balances',
  'expenses',
  'maintenance-costs',
  'profit-summary',
  'bookings',
  'available-rooms',
  'maintenance-issues',
] as const;
export type ExportReportName = (typeof EXPORT_REPORT_NAMES)[number];

const EXPORT_SCHEMAS: Record<ExportReportName, z.ZodType> = {
  occupancy: occupancyQuerySchema,
  revenue: revenueQuerySchema,
  'arrivals-departures': dateQuerySchema,
  'outstanding-balances': dateQuerySchema,
  expenses: expensesQuerySchema,
  'maintenance-costs': maintenanceCostsQuerySchema,
  'profit-summary': profitSummaryQuerySchema,
  bookings: bookingsQuerySchema,
  'available-rooms': availabilityQuerySchema,
  'maintenance-issues': maintenanceIssuesQuerySchema,
};

export function validateExportName(name: string): ExportReportName {
  if (!(EXPORT_REPORT_NAMES as readonly string[]).includes(name)) {
    throw AppError.notFound('Unknown report');
  }
  return name as ExportReportName;
}

/** The validated query schema for a report export (feeds the route validation). */
export function schemaForExport(name: ExportReportName): z.ZodType {
  return EXPORT_SCHEMAS[name];
}

/**
 * Resolve the property an export runs for: the actor's own property, or the
 * single active property when the actor is property-less (system admin).
 * Fails fast at request time so a bad export requests 404s immediately
 * instead of dead-lettering in the job queue.
 */
export async function exportPropertyId(actor: Actor): Promise<string> {
  return scopeProperty(actor);
}

function assertRange(from: string, to: string): void {
  if (from > to) throw AppError.badRequest('VALIDATION_ERROR', 'from must not be after to');
}

/** Bucket a date into a day / ISO-week-start / month-start key. */
function bucketKey(d: string, groupBy: GroupBy): string {
  if (groupBy === 'day') return d;
  if (groupBy === 'month') return `${d.slice(0, 7)}-01`;
  const dt = parseISO(`${d}T00:00:00`);
  const diffToMonday = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - diffToMonday);
  return dfFormat(dt, 'yyyy-MM-dd');
}

function labelFor(key: string, groupBy: GroupBy): string {
  if (groupBy === 'week') return `Week of ${key}`;
  if (groupBy === 'month') return key.slice(0, 7);
  return key;
}

/** Whole days from b (earlier) to a (later); negative when a precedes b. */
function daysBetween(a: string, b: string): number {
  return Math.round((parseISO(`${a}T00:00:00`).getTime() - parseISO(`${b}T00:00:00`).getTime()) / 86_400_000);
}

/** Normalize money from the DB (`'7500'` → `'7500.00'`) for stable output. */
function money(value: string): string {
  return M.toDecimal(value).toFixed(2);
}

function rate(num: string, den: number): string {
  return den > 0 ? M.toDecimal(num).dividedBy(den).toFixed(2) : '0.00';
}

function share(num: string, den: string): string {
  return !M.isZero(den) ? M.toDecimal(num).dividedBy(den).mul(100).toFixed(2) : '0.00';
}

function occupancyPct(sold: number, sellable: number): string {
  return sellable > 0 ? M.toDecimal(M.of(sold)).dividedBy(sellable).mul(100).toFixed(2) : '0.00';
}

interface BucketAcc {
  key: string;
  sold: number;
  sellable: number;
  roomRev: string;
  totalRev: string;
  arrivals: number;
  departures: number;
}

function foldBuckets(rows: readonly { businessDate: string; roomsSold: number; roomsSellable: number; roomRevenue: string; totalRevenue: string; arrivals: number; departures: number }[], groupBy: GroupBy): BucketAcc[] {
  const map = new Map<string, BucketAcc>();
  for (const r of rows) {
    const key = bucketKey(r.businessDate, groupBy);
    const acc = map.get(key) ?? {
      key,
      sold: 0,
      sellable: 0,
      roomRev: M.of(0),
      totalRev: M.of(0),
      arrivals: 0,
      departures: 0,
    };
    acc.sold += r.roomsSold;
    acc.sellable += r.roomsSellable;
    acc.roomRev = M.add(acc.roomRev, r.roomRevenue);
    acc.totalRev = M.add(acc.totalRev, r.totalRevenue);
    acc.arrivals += r.arrivals;
    acc.departures += r.departures;
    map.set(key, acc);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Occupancy / ADR / RevPAR trend from daily_stats (§18.2). */
export async function occupancyReport(
  input: Omit<OccupancyQuery, 'groupBy'> & { groupBy?: GroupBy },
  actor: Actor,
): Promise<OccupancyReportView> {
  const propertyId = await scopeProperty(actor);
  const from = input.from ?? addDays(today(), -29);
  const to = input.to ?? today();
  assertRange(from, to);
  const groupBy: GroupBy = input.groupBy ?? 'day';

  const rows = await withDb((db) => dailyRows(db, propertyId, from, to));
  const buckets = foldBuckets(rows, groupBy);

  const sold = buckets.reduce((n, b) => n + b.sold, 0);
  const sellable = buckets.reduce((n, b) => n + b.sellable, 0);
  const roomRev = M.add(...buckets.map((b) => b.roomRev));
  const totalRev = M.add(...buckets.map((b) => b.totalRev));

  return {
    from,
    to,
    groupBy,
    totals: {
      roomsSold: sold,
      roomsSellable: sellable,
      occupancyPct: occupancyPct(sold, sellable),
      adr: rate(roomRev, sold),
      revpar: rate(totalRev, sellable),
      roomRevenue: money(roomRev),
      totalRevenue: money(totalRev),
    },
    rows: buckets.map<OccupancyPeriodView>((b) => ({
      periodStart: b.key,
      label: labelFor(b.key, groupBy),
      roomsSold: b.sold,
      roomsSellable: b.sellable,
      occupancyPct: occupancyPct(b.sold, b.sellable),
      adr: rate(b.roomRev, b.sold),
      revpar: rate(b.totalRev, b.sellable),
      roomRevenue: money(b.roomRev),
      totalRevenue: money(b.totalRev),
      arrivals: b.arrivals,
      departures: b.departures,
    })),
  };
}

/** Revenue by day (daily_stats) or by room type / source / payment method. */
export async function revenueReport(input: RevenueQuery, actor: Actor): Promise<RevenueReportView> {
  const propertyId = await scopeProperty(actor);
  const from = input.from ?? addDays(today(), -29);
  const to = input.to ?? today();
  assertRange(from, to);
  const breakdown = input.breakdown ?? 'day';

  let rows: RevenueBreakdownRow[];
  if (breakdown === 'day') {
    const days = await withDb((db) => dailyRows(db, propertyId, from, to));
    rows = days.map<RevenueBreakdownRow>((d) => ({
      key: d.businessDate,
      label: d.businessDate,
      total: money(d.totalRevenue),
    }));
  } else {
    const summed = await withDb((db) => folioRevenueByDimension(db, propertyId, from, to, breakdown));
    rows = summed.map<RevenueBreakdownRow>((r) => ({ key: r.key, label: r.key, total: r.total }));
  }

  return {
    from,
    to,
    breakdown,
    totals: { totalRevenue: money(M.add(...rows.map((r) => r.total))) },
    rows,
  };
}

function toLedgerRow(r: {
  bookingId: string;
  reference: string;
  status: string;
  guestName: string;
  roomId: string;
  roomNumber: string;
  date: string;
}): LedgerRowView {
  return { ...r };
}

/** Arrivals & departures for one business date (operational report). */
export async function arrivalsDeparturesReport(date: string, actor: Actor): Promise<ArrivalsDeparturesView> {
  const [arrivals, departures] = await Promise.all([expectedArrivals(date, actor), expectedDepartures(date, actor)]);
  return {
    date,
    arrivals: arrivals.map(toLedgerRow),
    departures: departures.map(toLedgerRow),
  };
}

/** Aging of every booking that still owes money (§18.2 Payments & balances). */
export async function outstandingBalancesReport(actor: Actor): Promise<OutstandingBalancesView> {
  const propertyId = await scopeProperty(actor);
  const asOf = today();
  const records = await withDb((db) => outstandingRows(db, propertyId));

  const rows: OutstandingRow[] = records.map((r) => {
    const ageDays = daysBetween(asOf, r.departureDate);
    return {
      bookingId: r.bookingId,
      reference: r.reference,
      guestName: r.guestName,
      status: r.status,
      balance: r.balance,
      departureDate: r.departureDate,
      ageDays,
      bucket: ageDays <= 0 ? 'current' : ageDays <= 30 ? '1-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '90+',
    };
  });

  const total = money(M.add(...rows.map((r) => r.balance)));
  const buckets = ['current', '1-30', '31-60', '61-90', '90+'].map((bucket) => {
    const inBucket = rows.filter((r) => r.bucket === bucket);
    return { bucket, count: inBucket.length, total: money(M.add(...inBucket.map((r) => r.balance))) };
  });

  return { asOf, count: rows.length, total, buckets, rows };
}

/** The previous equal-length window before [from, to] for MoM comparisons. */
function prevWindow(from: string, to: string): { from: string; to: string } {
  const span = daysBetween(to, from) + 1;
  const prevTo = addDays(from as DateOnly, -1);
  return { from: addDays(prevTo as DateOnly, -(span - 1)), to: prevTo };
}

function momChange(current: string, previous: string | undefined): string | null {
  if (!previous || M.isZero(previous)) return null;
  const delta = M.sub(current, previous);
  return M.toDecimal(delta).dividedBy(previous).mul(100).toDecimalPlaces(1).toFixed(1);
}

/** Expenses by category (or month) with MoM change against the prior window. */
export async function expensesReport(
  input: Omit<ExpensesQuery, 'groupBy'> & { groupBy?: 'category' | 'month' },
  actor: Actor,
): Promise<ExpenseReportView> {
  const propertyId = await scopeProperty(actor);
  const from = input.from ?? addDays(today(), -29);
  const to = input.to ?? today();
  assertRange(from, to);
  const groupBy = input.groupBy ?? 'category';

  const [groups, prev] = await Promise.all([
    withDb((db) => expenseGroups(db, propertyId, from, to, groupBy)),
    withDb(async (db) => {
      const w = prevWindow(from, to);
      const rows = await expenseGroups(db, propertyId, w.from, w.to, groupBy);
      const byKey = new Map(rows.map((r) => [r.key, r.total]));
      return { byKey };
    }),
  ]);

  const total = money(M.add(...groups.map((g) => g.total)));
  const count = groups.reduce((n, g) => n + g.count, 0);

  const rows: ExpenseGroupView[] = groups.map((g) => ({
    key: g.key,
    label: groupBy === 'month' ? g.key : g.key,
    count: g.count,
    total: g.total,
    pctOfTotal: share(g.total, total),
    momChange: momChange(g.total, prev.byKey.get(g.key)),
  }));

  return { from, to, groupBy, count, total, rows };
}

/** Estimated vs actual maintenance cost per issue (§18.2 Maintenance costs). */
export async function maintenanceCostsReport(input: MaintenanceCostsQuery, actor: Actor): Promise<MaintenanceCostReportView> {
  const propertyId = await scopeProperty(actor);
  const from = input.from ?? addDays(today(), -29);
  const to = input.to ?? today();
  assertRange(from, to);

  const records = await withDb((db) => maintenanceCostRecords(db, propertyId, from, to));
  const rows: MaintenanceCostRowView[] = records.map((r) => ({
    issueId: r.issueId,
    reference: r.reference,
    roomNumber: r.roomNumber,
    title: r.title,
    priority: r.priority,
    reportedAt: new Date(r.reportedAt).toISOString(),
    estimatedCost: r.estimatedCost,
    actualCost: r.actualCost,
    expenseCount: r.expenseCount,
    variance: M.sub(r.actualCost, r.estimatedCost),
  }));
  const estimatedTotal = M.add(...rows.map((r) => r.estimatedCost));
  const actualTotal = M.add(...rows.map((r) => r.actualCost));

  return { from, to, estimatedTotal, actualTotal, variance: M.sub(actualTotal, estimatedTotal), rows };
}

/** Revenue − expenses, from frozen daily_stats (§18.2 Estimated profit). */
export async function profitSummaryReport(input: ProfitSummaryQuery, actor: Actor): Promise<ProfitSummaryView> {
  const propertyId = await scopeProperty(actor);
  const from = input.from ?? addDays(today(), -29);
  const to = input.to ?? today();
  assertRange(from, to);

  const rows = await withDb((db) => dailyRows(db, propertyId, from, to));

  const revenue = M.add(...rows.map((r) => r.totalRevenue));
  const expenses = M.add(...rows.map((r) => r.expensesTotal));
  const profit = M.sub(revenue, expenses);

  const byMonth = new Map<string, { revenue: string; expenses: string }>();
  for (const r of rows) {
    const key = `${r.businessDate.slice(0, 7)}-01`;
    const acc = byMonth.get(key) ?? { revenue: M.of(0), expenses: M.of(0) };
    acc.revenue = M.add(acc.revenue, r.totalRevenue);
    acc.expenses = M.add(acc.expenses, r.expensesTotal);
    byMonth.set(key, acc);
  }
  const periods: ProfitPeriodView[] = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, acc]) => {
      const p = M.sub(acc.revenue, acc.expenses);
      return { month: month.slice(0, 7), revenue: money(acc.revenue), expenses: money(acc.expenses), profit: money(p), marginPct: share(p, acc.revenue) };
    });

  return {
    from,
    to,
    revenue: money(revenue),
    expenses: money(expenses),
    profit: money(profit),
    marginPct: share(profit, revenue),
    rows: periods,
  };
}

/** Role-shaped dashboard (§17.3, §18.4). Financial KPIs only for manager/admin. */
export async function dashboard(actor: Actor): Promise<DashboardView> {
  const propertyId = await scopeProperty(actor);
  const date = today();

  const [arrivals, departures, inHouse, rooms, frozen] = await Promise.all([
    expectedArrivals(date, actor),
    expectedDepartures(date, actor),
    inHouseRooms(actor),
    listRoomsForBoard(actor),
    withDb((db) => dailyRows(db, propertyId, addDays(date, -7), addDays(date, -1))),
  ]);

  const roomsTotal = rooms.length;
  const roomsOccupied = inHouse.length;
  const roomsReady = rooms.filter((r) => r.condition === 'available' && r.housekeeping === 'clean').length;

  const view: DashboardView = {
    role: actor.role,
    date,
    today: {
      roomsTotal,
      roomsOccupied,
      roomsVacant: roomsTotal - roomsOccupied,
      roomsReady,
      occupancyPct: roomsTotal > 0 ? Math.round((roomsOccupied / roomsTotal) * 100) : 0,
      arrivals: arrivals.length,
      departures: departures.length,
      inHouse: inHouse.length,
    },
    sparkline: frozen.map((r) => ({
      date: r.businessDate,
      occupancyPct: r.occupancyPct,
      adr: r.adr,
      revpar: r.revpar,
      roomsSold: r.roomsSold,
    })),
  };

  if (actor.role !== 'receptionist') {
    const monthStart = `${date.slice(0, 7)}-01`;
    const [revenueToday, paymentsToday, outstanding, openMaint, mtdRows] = await Promise.all([
      withDb((db) => revenueOnDay(db, propertyId, date)),
      withDb((db) => paymentsByMethodOn(db, propertyId, date)),
      outstandingBalancesReport(actor),
      withDb((db) => openMaintenanceByPriority(db, propertyId)),
      withDb((db) => dailyRows(db, propertyId, monthStart, addDays(date, -1))),
    ]);
    const mtdRevenue = M.add(...mtdRows.map((r) => r.totalRevenue));
    const mtdExpenses = M.add(...mtdRows.map((r) => r.expensesTotal));
    view.financial = {
      revenueToday,
      paymentsTodayByMethod: paymentsToday.map((p) => ({ key: p.key, label: p.key, total: p.total })),
      outstandingBalance: outstanding.total,
      openMaintenanceByPriority: openMaint.map((p) => ({ priority: p.key, count: p.count })),
      revenueMtd: money(mtdRevenue),
      expensesMtd: money(mtdExpenses),
      profitMtd: money(M.sub(mtdRevenue, mtdExpenses)),
    };
  }

  if (actor.role === 'admin') {
    view.admin = { activeUsers: await withDb((db) => activeUsersCount(db)) };
  }

  return view;
}

/** Realized bookings by arrival period or source (§18.2 row 1). */
export async function bookingsReport(
  input: Omit<BookingsQuery, 'groupBy'> & { groupBy?: 'day' | 'week' | 'month' | 'source' },
  actor: Actor,
): Promise<BookingsReportView> {
  const propertyId = await scopeProperty(actor);
  const from = input.from ?? addDays(today(), -29);
  const to = input.to ?? today();
  assertRange(from, to);
  const groupBy = input.groupBy ?? 'day';

  const records = await withDb((db) => bookingSummaries(db, propertyId, from, to, groupBy));
  const rows: BookingsPeriodView[] = records.map((r) => ({
    key: r.key,
    label: groupBy === 'source' ? r.key : labelFor(r.key, groupBy as GroupBy),
    count: r.count,
    nights: r.nights,
    value: money(r.value),
  }));

  return {
    from,
    to,
    groupBy,
    totals: {
      count: rows.reduce((n, r) => n + r.count, 0),
      nights: rows.reduce((n, r) => n + r.nights, 0),
      value: money(M.add(...rows.map((r) => r.value))),
    },
    rows,
  };
}

/** As-of available/occupied snapshot (§18.2 row 3). */
export async function availableRoomsSnapshot(input: AvailabilityQuery, actor: Actor): Promise<AvailabilitySnapshotView> {
  const propertyId = await scopeProperty(actor);
  const date = input.date ?? today();

  const records = await withDb((db) => availabilityByRoomType(db, propertyId, date));
  const rows: RoomAvailabilityRowView[] = records.map((r) => ({
    roomType: r.roomType,
    total: r.total,
    occupied: r.occupied,
    outOfOrder: r.outOfOrder,
    available: r.total - r.occupied - r.outOfOrder,
  }));
  const total = rows.reduce((n, r) => n + r.total, 0);
  const occupied = rows.reduce((n, r) => n + r.occupied, 0);
  const outOfOrder = rows.reduce((n, r) => n + r.outOfOrder, 0);

  return {
    date,
    totals: {
      total,
      occupied,
      available: total - occupied - outOfOrder,
      outOfOrder,
      occupancyPct: occupancyPct(occupied, total),
    },
    rows,
  };
}

/** Open/closed maintenance issues with mean time-to-resolve (§18.2 row 8). */
export async function maintenanceIssuesReport(input: MaintenanceIssuesQuery, actor: Actor): Promise<MaintenanceIssuesReportView> {
  const propertyId = await scopeProperty(actor);
  const from = input.from ?? addDays(today(), -29);
  const to = input.to ?? today();
  assertRange(from, to);

  const records = await withDb((db) => maintenanceIssueRecords(db, propertyId, from, to));
  const rows: MaintenanceIssueRowView[] = records.map((r) => ({
    issueId: r.issueId,
    reference: r.reference,
    title: r.title,
    roomNumber: r.roomNumber,
    priority: r.priority,
    status: r.status,
    reportedAt: new Date(r.reportedAt).toISOString(),
    resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
    timeToResolveHours: r.timeToResolveHours != null ? Number(r.timeToResolveHours) : null,
  }));

  const isClosed = (r: MaintenanceIssueRowView) => r.status === 'resolved' || r.status === 'closed';
  const resolved = rows.filter((r) => r.timeToResolveHours != null);
  const meanTimeToResolveHours =
    resolved.length > 0
      ? Math.round((resolved.reduce((s, r) => s + (r.timeToResolveHours ?? 0), 0) / resolved.length) * 10) / 10
      : null;

  const byPriority = [...new Set(rows.map((r) => r.priority))].map((priority) => {
    const ofPriority = rows.filter((r) => r.priority === priority);
    return { priority, open: ofPriority.filter((r) => !isClosed(r)).length, closed: ofPriority.filter(isClosed).length };
  });

  return {
    from,
    to,
    open: rows.filter((r) => !isClosed(r)).length,
    closed: rows.filter(isClosed).length,
    meanTimeToResolveHours,
    byPriority,
    rows,
  };
}