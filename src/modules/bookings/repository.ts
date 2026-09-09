/**
 * modules/bookings/repository.ts
 *
 * All SQL for the reservation lifecycle. No business rules — queries.
 *
 * Cross-module tables (rooms, room_types, properties and the availability
 * owned allocation ledger) are accessed through the core schema barrel — never
 * through another module's repository. The exclusion constraint on
 * room_allocations is the authoritative double-booking guard;
 * `lockRoomRowsForUpdate` serialises contending transactions so the failure is
 * deterministic instead of racing (§11.1). Payments use row locks + SUM-in-SQL
 * for the derived total_paid cache (§12.3).
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema, type Db, type Tx } from '@/core/db';
import { bookingGuests, bookingNights, bookings, bookingStatus, bookingSource } from './schema';

type BookingStatus = (typeof bookingStatus.enumValues)[number];
type BookingSource = (typeof bookingSource.enumValues)[number];
type AllocationStatusValue = 'held' | 'confirmed' | 'checked_in' | 'checked_out' | 'blocked' | 'released';
type PaymentType = 'payment' | 'deposit' | 'refund';
type PaymentMethod = 'cash' | 'mpesa' | 'card' | 'bank_transfer' | 'cheque' | 'other';

export interface BookingRecord {
  id: string;
  propertyId: string;
  reference: string;
  guestId: string;
  status: string;
  source: string;
  arrivalDate: string;
  departureDate: string;
  nights: number | null;
  adults: number;
  children: number;
  guestNameSnapshot: string;
  guestPhoneSnapshot: string | null;
  totalCharges: string;
  totalPaid: string;
  balance: string | null;
  specialRequests: string | null;
  internalNotes: string | null;
  cancellationReason: string | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  checkedInAt: Date | null;
  checkedInBy: string | null;
  checkedOutAt: Date | null;
  checkedOutBy: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentRecord {
  id: string;
  propertyId: string;
  bookingId: string | null;
  receiptNumber: string;
  paymentType: PaymentType;
  amount: string;
  method: PaymentMethod;
  status: string;
  reference: string | null;
  payerName: string | null;
  paidAt: Date;
  notes: string | null;
  reversalOf: string | null;
  reversedReason: string | null;
}

const BOOKING_COLUMNS = {
  id: bookings.id,
  propertyId: bookings.propertyId,
  reference: bookings.reference,
  guestId: bookings.guestId,
  status: bookings.status,
  source: bookings.source,
  arrivalDate: bookings.arrivalDate,
  departureDate: bookings.departureDate,
  nights: bookings.nights,
  adults: bookings.adults,
  children: bookings.children,
  guestNameSnapshot: bookings.guestNameSnapshot,
  guestPhoneSnapshot: bookings.guestPhoneSnapshot,
  totalCharges: bookings.totalCharges,
  totalPaid: bookings.totalPaid,
  balance: bookings.balance,
  specialRequests: bookings.specialRequests,
  internalNotes: bookings.internalNotes,
  cancellationReason: bookings.cancellationReason,
  cancelledAt: bookings.cancelledAt,
  cancelledBy: bookings.cancelledBy,
  checkedInAt: bookings.checkedInAt,
  checkedInBy: bookings.checkedInBy,
  checkedOutAt: bookings.checkedOutAt,
  checkedOutBy: bookings.checkedOutBy,
  idempotencyKey: bookings.idempotencyKey,
  createdAt: bookings.createdAt,
  updatedAt: bookings.updatedAt,
};

/** actor.propertyId, or the single active property when the actor is unbound. */
export async function resolvePropertyId(db: Db | Tx, preferred: string | null): Promise<string | null> {
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

/** Global `settings.deposit_percent` (0 = no deposit required at check-in). */
export async function readDepositPercent(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, 'deposit_percent'))
    .limit(1);
  const raw = rows[0]?.value;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export interface RoomLockRecord {
  id: string;
  propertyId: string;
  roomTypeId: string;
  condition: string;
  isActive: boolean;
}

/**
 * Row-lock the rooms being booked, in id order (§11.2 step 3). Only rooms the
 * booking may sell: active, not deleted, not out_of_order. ORDER BY id is not
 * decoration — consistent lock order prevents deadlocks between two concurrent
 * multi-room bookings.
 */
export async function lockRoomRowsForUpdate(
  tx: Tx,
  propertyId: string,
  roomIds: string[],
): Promise<RoomLockRecord[]> {
  const rows = await tx.execute(sql`
    SELECT id, property_id AS "propertyId", room_type_id AS "roomTypeId",
           condition, is_active AS "isActive"
    FROM rooms
    WHERE property_id = ${propertyId}
      AND id IN (${roomIds.map((id) => sql`${id}`)})
      AND deleted_at IS NULL
      AND is_active = true
      AND condition <> 'out_of_order'
    ORDER BY id
    FOR UPDATE
  `);
  return rows.rows as unknown as RoomLockRecord[];
}

/** Lock a booking's header row so payments cannot double-apply (§12.3). */
export async function lockBookingForUpdate(
  tx: Tx,
  propertyId: string,
  bookingId: string,
): Promise<BookingRecord | null> {
  const rows = await tx.execute(sql`
    SELECT id, property_id AS "propertyId", reference, guest_id AS "guestId",
           status, source, arrival_date AS "arrivalDate", departure_date AS "departureDate",
           nights, adults, children, guest_name_snapshot AS "guestNameSnapshot",
           guest_phone_snapshot AS "guestPhoneSnapshot",
           total_charges AS "totalCharges", total_paid AS "totalPaid", balance,
           special_requests AS "specialRequests", internal_notes AS "internalNotes",
           cancellation_reason AS "cancellationReason", cancelled_at AS "cancelledAt",
           cancelled_by AS "cancelledBy", checked_in_at AS "checkedInAt",
           checked_in_by AS "checkedInBy", checked_out_at AS "checkedOutAt",
           checked_out_by AS "checkedOutBy", idempotency_key AS "idempotencyKey",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM bookings
    WHERE id = ${bookingId} AND property_id = ${propertyId}
    FOR UPDATE
  `);
  return (rows.rows as unknown as BookingRecord[])[0] ?? null;
}

export async function findBookingById(db: Db | Tx, id: string): Promise<BookingRecord | null> {
  const rows = await db.select(BOOKING_COLUMNS).from(bookings).where(eq(bookings.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Idempotency: same key ⇒ same booking, never a second row (§11.1 layer 3). */
export async function findBookingByIdempotencyKey(
  tx: Tx,
  propertyId: string,
  key: string,
): Promise<BookingRecord | null> {
  const rows = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.propertyId, propertyId), eq(bookings.idempotencyKey, key)))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) return null;
  return findBookingById(tx, id);
}

/** The booking's allocation rows (identity + dates, for transitions). */
export async function allocationsForBooking(tx: Tx, bookingId: string) {
  const a = schema.roomAllocations;
  return tx
    .select({
      id: a.id,
      roomId: a.roomId,
      status: a.status,
      startDate: a.startDate,
      endDate: a.endDate,
    })
    .from(a)
    .where(eq(a.bookingId, bookingId))
    .orderBy(asc(a.startDate));
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export interface BookingListFilters {
  propertyId: string;
  search?: string;
  status?: string;
  limit: number;
  offset: number;
}

export async function listBookings(db: Db, f: BookingListFilters): Promise<BookingRecord[]> {
  return db
    .select(BOOKING_COLUMNS)
    .from(bookings)
    .where(and(eq(bookings.propertyId, f.propertyId), statusOrSearch(f)))
    .orderBy(desc(bookings.createdAt))
    .limit(f.limit)
    .offset(f.offset);
}

export async function countBookings(db: Db, f: Omit<BookingListFilters, 'limit' | 'offset'>): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.propertyId, f.propertyId), statusOrSearch(f)));
  return rows[0]?.n ?? 0;
}

function statusOrSearch(f: { search?: string; status?: string }) {
  return and(
    f.status ? sql`${bookings.status} = ${f.status}` : undefined,
    f.search
      ? or(
          sql`${bookings.reference} ILIKE ${`%${f.search}%`}`,
          sql`${bookings.guestNameSnapshot} ILIKE ${`%${f.search}%`}`,
        )
      : undefined,
  );
}

// ─── Booking writes ──────────────────────────────────────────────────────────

export interface InsertBookingValues {
  propertyId: string;
  reference: string;
  guestId: string;
  source: BookingSource;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  guestNameSnapshot: string;
  guestPhoneSnapshot: string | null;
  totalCharges: string;
  totalPaid: string;
  specialRequests?: string | null;
  internalNotes?: string | null;
  idempotencyKey?: string | null;
  createdBy: string;
}

export function insertBooking(tx: Tx, v: InsertBookingValues): Promise<BookingRecord> {
  return tx
    .insert(bookings)
    .values({
      propertyId: v.propertyId,
      reference: v.reference,
      guestId: v.guestId,
      status: 'confirmed',
      source: v.source,
      arrivalDate: v.arrivalDate,
      departureDate: v.departureDate,
      adults: v.adults,
      children: v.children,
      guestNameSnapshot: v.guestNameSnapshot,
      guestPhoneSnapshot: v.guestPhoneSnapshot,
      totalCharges: v.totalCharges,
      totalPaid: v.totalPaid,
      specialRequests: v.specialRequests ?? null,
      internalNotes: v.internalNotes ?? null,
      idempotencyKey: v.idempotencyKey ?? null,
      createdBy: v.createdBy,
    })
    .returning(BOOKING_COLUMNS)
    .then((rows) => rows[0]!);
}

export interface AllocationInsertValues {
  propertyId: string;
  roomId: string;
  bookingId: string;
  startDate: string;
  endDate: string;
  roomTypeId: string;
  rateSnapshot: string;
  adults: number;
  children: number;
  createdBy: string;
}

/**
 * One confirmed reservation on the ledger. The exclusion constraint
 * (room_allocations_no_overlap) raises 23P01 here if the room is taken — by
 * design; the caller translates it to 409 ROOM_UNAVAILABLE.
 */
export function insertRoomAllocation(tx: Tx, v: AllocationInsertValues) {
  return tx
    .insert(schema.roomAllocations)
    .values({
      propertyId: v.propertyId,
      roomId: v.roomId,
      kind: 'reservation',
      status: 'confirmed',
      bookingId: v.bookingId,
      startDate: v.startDate,
      endDate: v.endDate,
      rateSnapshot: v.rateSnapshot,
      roomTypeSnapshot: v.roomTypeId,
      adults: v.adults,
      children: v.children,
      createdBy: v.createdBy,
    })
    .returning({ id: schema.roomAllocations.id })
    .then((rows) => rows[0]!.id);
}

export interface NightInsertValues {
  propertyId: string;
  bookingId: string;
  allocationId: string;
  roomId: string;
  roomTypeId: string;
  stayDate: string;
  rate: string;
}

export function insertBookingNight(tx: Tx, v: NightInsertValues): Promise<void> {
  return tx
    .insert(bookingNights)
    .values({
      propertyId: v.propertyId,
      bookingId: v.bookingId,
      allocationId: v.allocationId,
      roomId: v.roomId,
      roomTypeId: v.roomTypeId,
      stayDate: v.stayDate,
      rate: v.rate,
      isPosted: false,
    })
    .then(() => undefined);
}

export function insertBookingGuest(tx: Tx, bookingId: string, guestId: string): Promise<void> {
  return tx
    .insert(bookingGuests)
    .values({ bookingId, guestId, isPrimary: true })
    .onConflictDoNothing()
    .then(() => undefined);
}

export async function updateBookingStatus(
  tx: Tx,
  id: string,
  patch: {
    status: BookingStatus;
    checkedInAt?: Date;
    checkedInBy?: string;
    checkedOutAt?: Date;
    checkedOutBy?: string;
    cancelledAt?: Date;
    cancelledBy?: string;
    cancellationReason?: string;
  },
): Promise<BookingRecord> {
  const values: Record<string, unknown> = { status: patch.status };
  if (patch.checkedInAt) values.checkedInAt = patch.checkedInAt;
  if (patch.checkedInBy) values.checkedInBy = patch.checkedInBy;
  if (patch.checkedOutAt) values.checkedOutAt = patch.checkedOutAt;
  if (patch.checkedOutBy) values.checkedOutBy = patch.checkedOutBy;
  if (patch.cancelledAt) values.cancelledAt = patch.cancelledAt;
  if (patch.cancelledBy) values.cancelledBy = patch.cancelledBy;
  if (patch.cancellationReason) values.cancellationReason = patch.cancellationReason;
  return tx
    .update(bookings)
    .set(values)
    .where(eq(bookings.id, id))
    .returning(BOOKING_COLUMNS)
    .then((rows) => rows[0]!);
}

/** A cancel frees the rooms: live allocations → released. */
export async function releaseReservationsForBooking(tx: Tx, bookingId: string): Promise<void> {
  await tx
    .update(schema.roomAllocations)
    .set({ status: 'released', releasedAt: new Date() })
    .where(
      and(
        eq(schema.roomAllocations.bookingId, bookingId),
        inArray(schema.roomAllocations.status, ['held', 'confirmed'] as AllocationStatusValue[]),
      ),
    );
}

/** Checked-in/out allocations; returns the affected rooms for inventory updates. */
export async function setAllocationStatusForBooking(
  tx: Tx,
  bookingId: string,
  status: AllocationStatusValue,
): Promise<{ id: string; roomId: string }[]> {
  return tx
    .update(schema.roomAllocations)
    .set({ status: status as never })
    .where(eq(schema.roomAllocations.bookingId, bookingId))
    .returning({ id: schema.roomAllocations.id, roomId: schema.roomAllocations.roomId });
}

export async function updateRoomCondition(tx: Tx, roomId: string, condition: 'available' | 'occupied' | 'cleaning'): Promise<void> {
  await tx.update(schema.rooms).set({ condition: condition as never }).where(eq(schema.rooms.id, roomId));
}

// ─── Payments ────────────────────────────────────────────────────────────────

const PAYMENT_COLUMNS = {
  id: schema.payments.id,
  propertyId: schema.payments.propertyId,
  bookingId: schema.payments.bookingId,
  receiptNumber: schema.payments.receiptNumber,
  paymentType: schema.payments.paymentType,
  amount: schema.payments.amount,
  method: schema.payments.method,
  status: schema.payments.status,
  reference: schema.payments.reference,
  payerName: schema.payments.payerName,
  paidAt: schema.payments.paidAt,
  notes: schema.payments.notes,
  reversalOf: schema.payments.reversalOf,
  reversedReason: schema.payments.reversedReason,
};

export interface InsertPaymentValues {
  propertyId: string;
  bookingId: string;
  receiptNumber: string;
  paymentType: PaymentType;
  amount: string;
  method: PaymentMethod;
  businessDate: string;
  reference?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  reversalOf?: string | null;
  recordedBy: string;
}

export function insertPayment(tx: Tx, v: InsertPaymentValues): Promise<PaymentRecord> {
  return tx
    .insert(schema.payments)
    .values({
      propertyId: v.propertyId,
      bookingId: v.bookingId,
      receiptNumber: v.receiptNumber,
      paymentType: v.paymentType,
      amount: v.amount,
      method: v.method,
      status: 'completed',
      businessDate: v.businessDate,
      reference: v.reference ?? null,
      notes: v.notes ?? null,
      idempotencyKey: v.idempotencyKey ?? null,
      reversalOf: v.reversalOf ?? null,
      recordedBy: v.recordedBy,
    })
    .returning(PAYMENT_COLUMNS)
    .then((rows) => rows[0]!);
}

export async function findPaymentById(db: Db | Tx, id: string): Promise<PaymentRecord | null> {
  const rows = await db.select(PAYMENT_COLUMNS).from(schema.payments).where(eq(schema.payments.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function paymentsForBooking(db: Db | Tx, bookingId: string): Promise<PaymentRecord[]> {
  return db.select(PAYMENT_COLUMNS).from(schema.payments).where(eq(schema.payments.bookingId, bookingId)).orderBy(asc(schema.payments.createdAt));
}

/**
 * Net paid = Σ completed rows (refunds negative). Reversal marks the original
 * 'reversed' and inserts a refund row, so the ledger never forgets (§12.3).
 */
export async function sumCompletedPayments(tx: Tx, bookingId: string): Promise<string> {
  const rows = await tx
    .select({
      total: sql<string>`COALESCE(SUM(
        CASE WHEN payment_type = 'refund' THEN -amount ELSE amount END
      ), 0)`,
    })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.bookingId, bookingId),
        eq(schema.payments.status, 'completed'),
        isNull(schema.payments.reversalOf),
      ),
    );
  return rows[0]?.total ?? '0';
}

export async function updateBookingTotalPaid(tx: Tx, bookingId: string, totalPaid: string): Promise<void> {
  await tx
    .update(bookings)
    .set({ totalPaid: totalPaid as never })
    .where(eq(bookings.id, bookingId));
}

/** Mark a payment reversed; its unique external-reference slot frees up. */
export async function voidPayment(tx: Tx, id: string, reason: string, byId: string): Promise<PaymentRecord> {
  return tx
    .update(schema.payments)
    .set({ status: 'reversed', reversedBy: byId, reversedReason: reason })
    .where(eq(schema.payments.id, id))
    .returning(PAYMENT_COLUMNS)
    .then((rows) => rows[0]!);
}