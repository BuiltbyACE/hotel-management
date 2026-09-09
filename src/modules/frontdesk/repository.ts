/**
 * modules/frontdesk/repository.ts
 *
 * Front-desk read projections + the night-audit SQL (§13.3). The module owns
 * no tables: cross-module names come from the core schema barrel and the daily
 * freeze writes straight to `daily_stats` (the reporting module's read model).
 */
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db, type Tx } from '@/core/db';

export interface NoShowCandidateRow {
  bookingId: string;
}

export interface DepartingStayoverRow {
  bookingId: string;
  reference: string;
  guestName: string;
}

export interface ReconcileMismatchRow {
  bookingId: string;
  reference: string;
  headerCharges: string;
  ledgerCharges: string;
  headerPaid: string;
  ledgerPaid: string;
}

export interface DayCountersRow {
  roomsTotal: number;
  roomsSellable: number;
  roomsSold: number;
  inHouse: number;
  arrivals: number;
  departures: number;
  noShows: number;
  cancellations: number;
  roomRevenue: string;
  otherRevenue: string;
  totalRevenue: string;
  expensesTotal: string;
  paymentsTotal: string;
}

export interface DailyStatsRow {
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
}

/** Every active property the audit freezes each night. */
export async function listActivePropertyIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(eq(schema.properties.isActive, true));
  return rows.map((r) => r.id);
}

/** Number of nights charged for a no-show (settings, default 1). */
export async function readNoShowFeeNights(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, 'no_show_fee_nights'));
  const raw = rows[0]?.value as unknown;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
}

/** Confirmed bookings that never checked in and were due on/before `date`. */
export async function noShowCandidates(tx: Tx, propertyId: string, businessDate: string): Promise<NoShowCandidateRow[]> {
  const rows = await tx.execute(sql`
    SELECT id AS "bookingId"
    FROM bookings
    WHERE property_id = ${propertyId}
      AND status = 'confirmed'
      AND arrival_date <= ${businessDate}
      AND checked_in_at IS NULL
  `);
  return rows.rows as unknown as NoShowCandidateRow[];
}

/** In-house bookings whose departure has already passed — manager review list. */
export async function departingStayovers(tx: Tx, propertyId: string, date: string): Promise<DepartingStayoverRow[]> {
  const rows = await tx.execute(sql`
    SELECT id AS "bookingId", reference, guest_name_snapshot AS "guestName"
    FROM bookings
    WHERE property_id = ${propertyId}
      AND status = 'checked_in'
      AND departure_date <= ${date}
    ORDER BY departure_date
  `);
  return rows.rows as unknown as DepartingStayoverRow[];
}

/** Ledger vs header cache mismatches on audited statuses (§12.1 rule 5). */
export async function reconcileMismatches(tx: Tx, propertyId: string): Promise<ReconcileMismatchRow[]> {
  const rows = await tx.execute(sql`
    SELECT b.id AS "bookingId", b.reference,
           COALESCE(b.total_charges, 0)::numeric(14,2)::text AS "headerCharges",
           COALESCE(f.total, 0)::numeric(14,2)::text AS "ledgerCharges",
           COALESCE(b.total_paid, 0)::numeric(14,2)::text AS "headerPaid",
           COALESCE(p.total, 0)::numeric(14,2)::text AS "ledgerPaid"
    FROM bookings b
    LEFT JOIN (
      SELECT booking_id, SUM(total_amount) AS total
      FROM folio_charges WHERE NOT is_voided GROUP BY booking_id
    ) f ON f.booking_id = b.id
    LEFT JOIN (
      SELECT booking_id, SUM(CASE WHEN payment_type = 'refund' THEN -amount ELSE amount END) AS total
      FROM payments WHERE status = 'completed' AND reversal_of IS NULL GROUP BY booking_id
    ) p ON p.booking_id = b.id
    WHERE b.property_id = ${propertyId}
      AND b.status IN ('checked_in', 'checked_out', 'no_show')
      AND (
        COALESCE(b.total_charges, 0) IS DISTINCT FROM COALESCE(f.total, 0)
        OR COALESCE(b.total_paid, 0) IS DISTINCT FROM COALESCE(p.total, 0)
      )
  `);
  return rows.rows as unknown as ReconcileMismatchRow[];
}

/** Re-derive the audited bookings' header caches from their ledgers. */
export async function reconcileRewrite(tx: Tx, propertyId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE bookings b
    SET total_charges = COALESCE(f.total, 0)::numeric(14,2),
        total_paid = COALESCE(p.total, 0)::numeric(14,2),
        updated_at = now()
    FROM (
      SELECT booking_id, SUM(total_amount) AS total
      FROM folio_charges WHERE NOT is_voided GROUP BY booking_id
    ) f
    JOIN (
      SELECT booking_id, SUM(CASE WHEN payment_type = 'refund' THEN -amount ELSE amount END) AS total
      FROM payments WHERE status = 'completed' AND reversal_of IS NULL GROUP BY booking_id
    ) p ON p.booking_id = f.booking_id
    JOIN bookings b2
      ON b2.id = f.booking_id
      AND b2.property_id = ${propertyId}
      AND b2.status IN ('checked_in', 'checked_out', 'no_show')
    WHERE b.id = f.booking_id
  `);
}

/** The frozen day's counters, all read from live data in one statement. */
export async function dayCounters(tx: Tx, propertyId: string, date: string): Promise<DayCountersRow> {
  const rows = await tx.execute(sql`
    WITH room_counts AS (
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE condition <> 'out_of_order' AND is_active) AS sellable
      FROM rooms
      WHERE property_id = ${propertyId} AND deleted_at IS NULL
    ),
    occupancy AS (
      SELECT count(DISTINCT bn.room_id) FILTER (WHERE b.status IN ('checked_in', 'checked_out'))::int AS sold,
             count(DISTINCT bn.room_id) FILTER (WHERE b.status IN ('checked_in', 'checked_out'))::int AS in_house
      FROM booking_nights bn
      JOIN bookings b ON b.id = bn.booking_id
      WHERE bn.property_id = ${propertyId} AND bn.stay_date = ${date}
    ),
    arrivals AS (
      SELECT count(*)::int AS n
      FROM bookings
      WHERE property_id = ${propertyId}
        AND arrival_date = ${date}
        AND status IN ('confirmed', 'checked_in', 'checked_out', 'no_show')
    ),
    departures AS (
      SELECT count(*)::int AS n
      FROM bookings
      WHERE property_id = ${propertyId}
        AND departure_date = ${date}
        AND status IN ('checked_in', 'checked_out')
    ),
    no_shows AS (
      SELECT count(*)::int AS n
      FROM bookings
      WHERE property_id = ${propertyId} AND arrival_date = ${date} AND status = 'no_show'
    ),
    cancellations AS (
      SELECT count(*)::int AS n
      FROM bookings
      WHERE property_id = ${propertyId} AND status = 'cancelled' AND cancelled_at::date = ${date}
    ),
    revenue AS (
      SELECT COALESCE(SUM(total_amount) FILTER (WHERE charge_type = 'room'), 0)::numeric(14,2) AS "roomRevenue",
             COALESCE(SUM(total_amount), 0)::numeric(14,2) AS "totalRevenue"
      FROM folio_charges
      WHERE property_id = ${propertyId} AND charge_date = ${date} AND NOT is_voided
    ),
    expenses AS (
      SELECT COALESCE(SUM(amount), 0)::numeric(14,2) AS n
      FROM expenses
      WHERE property_id = ${propertyId}
        AND expense_date = ${date}
        AND deleted_at IS NULL
        AND status <> 'rejected'
    ),
    payments AS (
      SELECT COALESCE(SUM(CASE WHEN payment_type = 'refund' THEN -amount ELSE amount END), 0)::numeric(14,2) AS n
      FROM payments
      WHERE property_id = ${propertyId}
        AND business_date = ${date}
        AND status = 'completed'
        AND reversal_of IS NULL
    )
    SELECT (SELECT total FROM room_counts) AS "roomsTotal",
           (SELECT sellable FROM room_counts) AS "roomsSellable",
           COALESCE((SELECT sold FROM occupancy), 0) AS "roomsSold",
           COALESCE((SELECT in_house FROM occupancy), 0) AS "inHouse",
           (SELECT n FROM arrivals) AS "arrivals",
           (SELECT n FROM departures) AS "departures",
           (SELECT n FROM no_shows) AS "noShows",
           (SELECT n FROM cancellations) AS "cancellations",
           (SELECT "roomRevenue" FROM revenue) AS "roomRevenue",
           COALESCE((SELECT "totalRevenue" FROM revenue) - (SELECT "roomRevenue" FROM revenue), 0)::numeric(14,2) AS "otherRevenue",
           COALESCE((SELECT "totalRevenue" FROM revenue), 0)::numeric(14,2) AS "totalRevenue",
           (SELECT n FROM expenses) AS "expensesTotal",
           (SELECT n FROM payments) AS "paymentsTotal"
  `);
  const raw = rows.rows[0] as Record<string, unknown>;
  const int = (v: unknown): number => Number(v) || 0;
  const money = (v: unknown): string => String(v ?? 0);
  return {
    roomsTotal: int(raw.roomsTotal),
    roomsSellable: int(raw.roomsSellable),
    roomsSold: int(raw.roomsSold),
    inHouse: int(raw.inHouse),
    arrivals: int(raw.arrivals),
    departures: int(raw.departures),
    noShows: int(raw.noShows),
    cancellations: int(raw.cancellations),
    roomRevenue: money(raw.roomRevenue),
    otherRevenue: money(raw.otherRevenue),
    totalRevenue: money(raw.totalRevenue),
    expensesTotal: money(raw.expensesTotal),
    paymentsTotal: money(raw.paymentsTotal),
  };
}

/** Freeze (or refresh on re-run) a night-audit day (§18.1 freeze rows). */
export async function upsertDailyStats(tx: Tx, s: DailyStatsRow): Promise<void> {
  await tx
    .insert(schema.dailyStats)
    .values({
      propertyId: s.propertyId,
      businessDate: s.businessDate,
      roomsTotal: s.roomsTotal,
      roomsSellable: s.roomsSellable,
      roomsSold: s.roomsSold,
      occupancyPct: s.occupancyPct,
      roomRevenue: s.roomRevenue,
      otherRevenue: s.otherRevenue,
      totalRevenue: s.totalRevenue,
      adr: s.adr,
      revpar: s.revpar,
      arrivals: s.arrivals,
      departures: s.departures,
      inHouse: s.inHouse,
      noShows: s.noShows,
      cancellations: s.cancellations,
      expensesTotal: s.expensesTotal,
      paymentsTotal: s.paymentsTotal,
    })
    .onConflictDoUpdate({
      target: [schema.dailyStats.propertyId, schema.dailyStats.businessDate],
      set: {
        roomsTotal: s.roomsTotal,
        roomsSellable: s.roomsSellable,
        roomsSold: s.roomsSold,
        occupancyPct: s.occupancyPct,
        roomRevenue: s.roomRevenue,
        otherRevenue: s.otherRevenue,
        totalRevenue: s.totalRevenue,
        adr: s.adr,
        revpar: s.revpar,
        arrivals: s.arrivals,
        departures: s.departures,
        inHouse: s.inHouse,
        noShows: s.noShows,
        cancellations: s.cancellations,
        expensesTotal: s.expensesTotal,
        paymentsTotal: s.paymentsTotal,
        computedAt: sql`now()`,
      },
    });
}

/** Read a frozen day back (response body + re-run idempotency checks). */
export async function frozenStatsRow(
  tx: Tx,
  propertyId: string,
  businessDate: string,
): Promise<Array<DailyStatsRow & { computedAt: Date }>> {
  const s = schema.dailyStats;
  return tx
    .select({
      propertyId: s.propertyId,
      businessDate: s.businessDate,
      roomsTotal: s.roomsTotal,
      roomsSellable: s.roomsSellable,
      roomsSold: s.roomsSold,
      occupancyPct: s.occupancyPct,
      roomRevenue: s.roomRevenue,
      otherRevenue: s.otherRevenue,
      totalRevenue: s.totalRevenue,
      adr: s.adr,
      revpar: s.revpar,
      arrivals: s.arrivals,
      departures: s.departures,
      inHouse: s.inHouse,
      noShows: s.noShows,
      cancellations: s.cancellations,
      expensesTotal: s.expensesTotal,
      paymentsTotal: s.paymentsTotal,
      computedAt: s.computedAt,
    })
    .from(s)
    .where(and(eq(s.propertyId, propertyId), eq(s.businessDate, businessDate)))
    .limit(1);
}