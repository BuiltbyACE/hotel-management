/**
 * modules/reporting/repository.ts
 *
 * The reporting read layer. Blueprint §5 escape hatch: this is the ONE module
 * allowed to read across schemas (configured in eslint.config.mjs), so every
 * cross-module join the reports need lives here. Reporting NEVER writes —
 * daily_stats is the read model the night audit freezes; all other tables are
 * read-only projections over the ledgers.
 *
 * Trend queries (occupancy, revenue-by-day, profit) read `daily_stats` (§18.1);
 * "today" and the breakdown probes hit the live ledger.
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { schema } from '@/core/db';
import type { Db, Tx } from '@/core/db';

type DbOrTx = Db | Tx;

/** actor.propertyId, or the single active property when the actor is unbound. */
export async function resolvePropertyId(db: DbOrTx, preferred: string | null): Promise<string | null> {
  if (preferred) {
    const rows = await db
      .select({ id: schema.properties.id })
      .from(schema.properties)
      .where(and(eq(schema.properties.id, preferred), eq(schema.properties.isActive, true)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(eq(schema.properties.isActive, true))
    .orderBy(asc(schema.properties.name))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** A frozen day from daily_stats. */
export interface DailyStatsRow {
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
}

/** Frozen days in [from, to] — the fact table for every trend report (§18.1). */
export async function dailyRows(db: DbOrTx, propertyId: string, from: string, to: string): Promise<DailyStatsRow[]> {
  return db
    .select({
      businessDate: schema.dailyStats.businessDate,
      roomsTotal: schema.dailyStats.roomsTotal,
      roomsSellable: schema.dailyStats.roomsSellable,
      roomsSold: schema.dailyStats.roomsSold,
      occupancyPct: schema.dailyStats.occupancyPct,
      roomRevenue: schema.dailyStats.roomRevenue,
      otherRevenue: schema.dailyStats.otherRevenue,
      totalRevenue: schema.dailyStats.totalRevenue,
      adr: schema.dailyStats.adr,
      revpar: schema.dailyStats.revpar,
      arrivals: schema.dailyStats.arrivals,
      departures: schema.dailyStats.departures,
      inHouse: schema.dailyStats.inHouse,
      noShows: schema.dailyStats.noShows,
      cancellations: schema.dailyStats.cancellations,
      expensesTotal: schema.dailyStats.expensesTotal,
      paymentsTotal: schema.dailyStats.paymentsTotal,
    })
    .from(schema.dailyStats)
    .where(
      and(
        eq(schema.dailyStats.propertyId, propertyId),
        gte(schema.dailyStats.businessDate, from),
        lte(schema.dailyStats.businessDate, to),
      ),
    )
    .orderBy(asc(schema.dailyStats.businessDate));
}

/** Sum of non-voided folio charges on `date` (today's revenue, live). */
export async function revenueOnDay(db: DbOrTx, propertyId: string, date: string): Promise<string> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(total_amount), 0)::numeric(14,2)::text` })
    .from(schema.folioCharges)
    .where(
      and(
        eq(schema.folioCharges.propertyId, propertyId),
        eq(schema.folioCharges.chargeDate, date),
        eq(schema.folioCharges.isVoided, false),
      ),
    );
  return rows[0]!.total;
}

export interface MoneyRow {
  key: string;
  total: string;
}

/** Completed payments on `date` by method (cash vs M-Pesa vs card…). */
export async function paymentsByMethodOn(db: DbOrTx, propertyId: string, date: string): Promise<MoneyRow[]> {
  return rawRows<MoneyRow>(
    db,
    sql`SELECT p.method AS key, SUM(p.amount)::numeric(14,2)::text AS total
        FROM payments p
        WHERE p.property_id = ${propertyId} AND p.business_date = ${date}
          AND p.status = 'completed' AND p.payment_type IN ('payment', 'deposit')
        GROUP BY p.method
        ORDER BY total DESC`,
  );
}

/**
 * Folio revenue grouped by a dimension (§18.2 Revenue).
 * - roomType: room-type-attributable charges via source_night_id → room_types
 * - source:   booking source (walk-in, online, OTA…)
 * - method:   payment method (from the payments ledger, not the folio)
 */
export async function folioRevenueByDimension(
  db: DbOrTx,
  propertyId: string,
  from: string,
  to: string,
  dimension: 'roomType' | 'source' | 'method',
): Promise<MoneyRow[]> {
  if (dimension === 'method') {
    return rawRows<MoneyRow>(
      db,
      sql`SELECT p.method AS key, SUM(p.amount)::numeric(14,2)::text AS total
          FROM payments p
          WHERE p.property_id = ${propertyId}
            AND p.business_date BETWEEN ${from} AND ${to}
            AND p.status = 'completed' AND p.payment_type IN ('payment', 'deposit')
          GROUP BY p.method
          ORDER BY total DESC`,
    );
  }
  const join =
    dimension === 'roomType'
      ? sql`
        LEFT JOIN booking_nights bn ON bn.id = fc.source_night_id
        LEFT JOIN room_types rt ON rt.id = bn.room_type_id`
      : sql`JOIN bookings b ON b.id = fc.booking_id`;
  const keyCol = dimension === 'roomType' ? sql`COALESCE(rt.name, 'Other')` : sql`b.source`;
  return rawRows<MoneyRow>(
    db,
    sql`SELECT ${keyCol} AS key, SUM(fc.total_amount)::numeric(14,2)::text AS total
        FROM folio_charges fc
        ${join}
        WHERE fc.property_id = ${propertyId}
          AND fc.charge_date BETWEEN ${from} AND ${to}
          AND NOT fc.is_voided
        GROUP BY 1
        ORDER BY total DESC`,
  );
}

export interface OutstandingRecord {
  bookingId: string;
  reference: string;
  guestName: string;
  status: string;
  balance: string;
  departureDate: string;
}

/** Bookings still owing, newest balance first (§18.2 Payments & balances). */
export async function outstandingRows(db: DbOrTx, propertyId: string): Promise<OutstandingRecord[]> {
  return rawRows<OutstandingRecord>(
    db,
    sql`SELECT id AS "bookingId", reference, guest_name_snapshot AS "guestName", status,
               balance::numeric(14,2)::text AS balance, departure_date AS "departureDate"
        FROM bookings
        WHERE property_id = ${propertyId}
          AND status IN ('confirmed', 'checked_in', 'checked_out')
          AND (total_charges - total_paid) > 0
        ORDER BY (total_charges - total_paid) DESC, arrival_date
        LIMIT 500`,
  );
}

export interface ExpenseGroupRecord {
  key: string;
  count: number;
  total: string;
}

/** Non-deleted expenses in [from, to] grouped by category (or by month). */
export async function expenseGroups(
  db: DbOrTx,
  propertyId: string,
  from: string,
  to: string,
  groupBy: 'category' | 'month',
): Promise<ExpenseGroupRecord[]> {
  const keyCol = groupBy === 'category' ? sql`COALESCE(c.name, 'Uncategorised')` : sql`to_char(e.expense_date, 'YYYY-MM')`;
  return rawRows<ExpenseGroupRecord>(
    db,
    sql`SELECT ${keyCol} AS key, count(*)::int AS count, SUM(e.amount)::numeric(14,2)::text AS total
        FROM expenses e
        LEFT JOIN expense_categories c ON c.id = e.category_id
        WHERE e.property_id = ${propertyId} AND e.deleted_at IS NULL
          AND e.expense_date BETWEEN ${from} AND ${to}
        GROUP BY 1
        ORDER BY total DESC`,
  );
}

export interface MaintenanceCostRecord {
  issueId: string;
  reference: string;
  roomNumber: string | null;
  title: string;
  priority: string;
  reportedAt: string;
  estimatedCost: string;
  actualCost: string;
  expenseCount: number;
}

/** Issues reported in [from, to] with estimated vs actual from the cost view. */
export async function maintenanceCostRecords(
  db: DbOrTx,
  propertyId: string,
  from: string,
  to: string,
): Promise<MaintenanceCostRecord[]> {
  return rawRows<MaintenanceCostRecord>(
    db,
    sql`SELECT mi.id AS "issueId", mi.reference, r.room_number AS "roomNumber", mi.title, mi.priority,
               mi.reported_at AS "reportedAt",
               COALESCE(v.estimated_cost, 0)::numeric(14,2)::text AS "estimatedCost",
               COALESCE(v.actual_cost, 0)::numeric(14,2)::text AS "actualCost",
               COALESCE(v.expense_count, 0)::int AS "expenseCount"
        FROM maintenance_cost_view v
        JOIN maintenance_issues mi ON mi.id = v.issue_id AND mi.property_id = ${propertyId}
        LEFT JOIN rooms r ON r.id = mi.room_id
        WHERE date(mi.reported_at) BETWEEN ${from} AND ${to}
        ORDER BY mi.reported_at DESC`,
  );
}

export interface PriorityCountRow {
  key: string;
  count: number;
}

/** Open maintenance issues by priority (status not resolved/closed). */
export async function openMaintenanceByPriority(db: DbOrTx, propertyId: string): Promise<PriorityCountRow[]> {
  return rawRows<PriorityCountRow>(
    db,
    sql`SELECT priority AS key, count(*)::int AS count
        FROM maintenance_issues
        WHERE property_id = ${propertyId} AND status NOT IN ('resolved', 'closed')
        GROUP BY priority`,
  );
}

/** Active staff users — one dashboard card for admins. */
export async function activeUsersCount(db: DbOrTx): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.users)
    .where(eq(schema.users.status, 'active'));
  return rows[0]!.n;
}

async function rawRows<T>(db: DbOrTx, stmt: ReturnType<typeof sql>): Promise<T[]> {
  const rows = await db.execute(stmt);
  return rows.rows as unknown as T[];
}