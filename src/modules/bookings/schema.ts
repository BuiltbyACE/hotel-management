/**
 * modules/bookings/schema.ts
 *
 * Reservation lifecycle. Owned tables (blueprint §5.1): bookings,
 * booking_nights, booking_guests. The allocation ledger, while deeply
 * intertwined with bookings, is owned by modules/availability.
 *
 * Mirror of drizzle/0001_full_schema.sql §6. bookings.nights and bookings.balance
 * are GENERATED ALWAYS columns there — Postgres computes them, the app never
 * writes them. They ARE mirrored here (generatedAlwaysAs) so reads are typed.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const bookingStatus = pgEnum('booking_status', ['draft', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show']);
export const bookingSource = pgEnum('booking_source', ['walk_in', 'phone', 'email', 'front_desk', 'online', 'ota', 'corporate']);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    reference: text('reference').notNull(),
    guestId: uuid('guest_id').notNull(),
    status: bookingStatus('status').notNull().default('draft'),
    source: bookingSource('source').notNull().default('front_desk'),
    arrivalDate: date('arrival_date', { mode: 'string' }).notNull(),
    departureDate: date('departure_date', { mode: 'string' }).notNull(),
    nights: integer('nights').generatedAlwaysAs(sql`(departure_date - arrival_date)::int`),
    adults: smallint('adults').notNull().default(1),
    children: smallint('children').notNull().default(0),
    guestNameSnapshot: text('guest_name_snapshot').notNull(),
    guestPhoneSnapshot: text('guest_phone_snapshot'),
    totalCharges: numeric('total_charges', { precision: 14, scale: 2 }).notNull().default('0'),
    totalPaid: numeric('total_paid', { precision: 14, scale: 2 }).notNull().default('0'),
    balance: numeric('balance', { precision: 14, scale: 2 }).generatedAlwaysAs(sql`(total_charges - total_paid)`),
    specialRequests: text('special_requests'),
    internalNotes: text('internal_notes'),
    cancellationReason: text('cancellation_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    checkedInBy: uuid('checked_in_by'),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    checkedOutBy: uuid('checked_out_by'),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // CHECK (departure_date > arrival_date), CHECK (adults >= 1)
    check('bookings_dates_valid', sql`${t.departureDate} > ${t.arrivalDate}`),
    check('bookings_adults_min', sql`${t.adults} >= 1`),
    uniqueIndex('bookings_reference_uq').on(t.propertyId, t.reference),
    uniqueIndex('bookings_idempotency_uq')
      .on(t.propertyId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('bookings_arrival_idx').on(t.propertyId, t.arrivalDate, t.status),
    index('bookings_departure_idx').on(t.propertyId, t.departureDate, t.status),
    index('bookings_guest_idx').on(t.guestId, t.createdAt),
    index('bookings_status_idx').on(t.propertyId, t.status).where(sql`status IN ('confirmed','checked_in')`),
  ],
);

export const bookingNights = pgTable(
  'booking_nights',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    bookingId: uuid('booking_id').notNull(),
    allocationId: uuid('allocation_id').notNull(),
    roomId: uuid('room_id').notNull(),
    roomTypeId: uuid('room_type_id').notNull(),
    stayDate: date('stay_date', { mode: 'string' }).notNull(),
    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    isPosted: boolean('is_posted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('booking_nights_uq').on(t.allocationId, t.stayDate),
    index('booking_nights_date_idx').on(t.propertyId, t.stayDate),
    index('booking_nights_unposted_idx').on(t.propertyId, t.stayDate).where(sql`NOT ${t.isPosted}`),
    check('booking_nights_rate_check', sql`${t.rate} >= 0`),
  ],
);

export const bookingGuests = pgTable(
  'booking_guests',
  {
    bookingId: uuid('booking_id').notNull(),
    guestId: uuid('guest_id').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.guestId] })],
);