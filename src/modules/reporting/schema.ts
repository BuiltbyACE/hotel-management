/**
 * modules/reporting/schema.ts
 *
 * Read models. Owned objects (blueprint §5.1 "read models, daily stats,
 * exports"): daily_stats, maintenance_cost_view.
 *
 * - daily_stats mirrors the night-audit freeze row (§9 in 0001). Trend reports
 *   read ONLY from this table (§18.1); only "today" is computed live.
 * - maintenance_cost_view is a view owned by the migrator (defined in 0001 §8);
 *   the Drizzle `existing()` reference just types it for reporting queries — it
 *   must not be re-created.
 *
 * `maintenance_cost_view` reaches across maintenance_issues + expenses; this is
 * the allowed read-across for the reporting repository.
 */
import { date, integer, numeric, pgTable, pgView, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';

export const dailyStats = pgTable(
  'daily_stats',
  {
    propertyId: uuid('property_id').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    roomsTotal: integer('rooms_total').notNull(),
    roomsSellable: integer('rooms_sellable').notNull(),
    roomsSold: integer('rooms_sold').notNull(),
    occupancyPct: numeric('occupancy_pct', { precision: 5, scale: 2 }).notNull(),
    roomRevenue: numeric('room_revenue', { precision: 14, scale: 2 }).notNull(),
    otherRevenue: numeric('other_revenue', { precision: 14, scale: 2 }).notNull(),
    totalRevenue: numeric('total_revenue', { precision: 14, scale: 2 }).notNull(),
    adr: numeric('adr', { precision: 14, scale: 2 }).notNull(),
    revpar: numeric('revpar', { precision: 14, scale: 2 }).notNull(),
    arrivals: integer('arrivals').notNull(),
    departures: integer('departures').notNull(),
    inHouse: integer('in_house').notNull(),
    noShows: integer('no_shows').notNull(),
    cancellations: integer('cancellations').notNull(),
    expensesTotal: numeric('expenses_total', { precision: 14, scale: 2 }).notNull(),
    paymentsTotal: numeric('payments_total', { precision: 14, scale: 2 }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.businessDate] })],
);

/**
 * Typed reference to the existing maintenance_cost_view (SELECT only).
 */
export const maintenanceCostView = pgView('maintenance_cost_view', {
  issueId: uuid('issue_id'),
  propertyId: uuid('property_id'),
  estimatedCost: numeric('estimated_cost', { precision: 14, scale: 2 }),
  actualCost: numeric('actual_cost', { precision: 14, scale: 2 }),
  expenseCount: integer('expense_count'),
}).existing();