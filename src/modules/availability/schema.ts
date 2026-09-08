/**
 * modules/availability/schema.ts
 *
 * The allocation ledger — the single source of truth for what a room can be
 * sold for. Owned table (blueprint §5.1 "the allocation ledger, search,
 * calendar"): room_allocations. See §6.4 note: "Reserved" is NOT a room status;
 * reservation state is derived from this ledger.
 *
 * Mirror of drizzle/0001_full_schema.sql §6. The heart of the table is the
 * exclusion constraint room_allocations_no_overlap, which the DB enforces:
 *
 *   EXCLUDE USING gist (room_id WITH =, daterange(start_date,end_date,'[)') WITH &&)
 *     WHERE (status IN ('held','confirmed','checked_in','checked_out','blocked'))
 *
 * Drizzle 0.45 has NO exclusion-constraint builder for Postgres, so the mirror
 * intentionally omits it — Postgres enforces it and drizzle never issues DDL.
 * It is verified by scripts/verify-schema.ts (check "Exclusion constraint
 * blocks overlap"). Do NOT "helpfully" add it as a plain index.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgEnum, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const allocationKind = pgEnum('allocation_kind', ['reservation', 'block']);
export const allocationStatus = pgEnum('allocation_status', ['held', 'confirmed', 'checked_in', 'checked_out', 'blocked', 'released']);

export const roomAllocations = pgTable(
  'room_allocations',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    roomId: uuid('room_id').notNull(),
    kind: allocationKind('kind').notNull(),
    status: allocationStatus('status').notNull(),
    bookingId: uuid('booking_id'),
    maintenanceIssueId: uuid('maintenance_issue_id'),
    blockReason: text('block_reason'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    rateSnapshot: numeric('rate_snapshot', { precision: 14, scale: 2 }),
    roomTypeSnapshot: uuid('room_type_snapshot'),
    adults: smallint('adults').notNull().default(1),
    children: smallint('children').notNull().default(0),
    heldUntil: timestamp('held_until', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // CHECK (end_date > start_date) — alloc_dates_valid in the migration
    check('alloc_dates_valid', sql`${t.endDate} > ${t.startDate}`),
    // CHECK ((kind='reservation' AND booking_id IS NOT NULL) OR (kind='block' AND booking_id IS NULL AND block_reason IS NOT NULL))
    check(
      'alloc_kind_shape',
      sql`((${t.kind} = 'reservation' AND ${t.bookingId} IS NOT NULL) OR (${t.kind} = 'block' AND ${t.bookingId} IS NULL AND ${t.blockReason} IS NOT NULL))`,
    ),
    index('allocations_booking_idx').on(t.bookingId),
    index('allocations_room_dates_idx').on(t.roomId, t.startDate, t.endDate),
    index('allocations_property_dates_idx')
      .on(t.propertyId, t.startDate, t.endDate)
      .where(sql`status IN ('confirmed','checked_in','checked_out','blocked')`),
    index('allocations_held_expiry_idx').on(t.heldUntil).where(sql`status = 'held'`),
  ],
);