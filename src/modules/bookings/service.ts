/**
 * modules/bookings/service.ts
 *
 * The booking engine (blueprint §11). `createBooking` is THE confirm-booking
 * transaction: idempotency → guest resolve (dedupe + blacklist gate) → room row
 * locks → server-side pricing → gap-free reference → header + allocations +
 * nights (+ optional deposit), audited and outboxed. The exclusion constraint
 * is the final arbiter; every conflict path rolls the whole thing back.
 *
 * Transitions are executed ONLY here. Route handlers, components and scripts
 * never set `status` directly; illegal transitions throw INVALID_TRANSITION.
 */
import { withDb, withTx, type Tx } from '@/core/db';
import { AppError } from '@/core/api';
import { translateDbError } from '@/core/db/errors';
import { nextNumber } from '@/core/db/sequence';
import { M } from '@/core/money';
import { today } from '@/core/dates';
import { eventBus } from '@/core/events';
import { enqueue as outbox } from '@/core/jobs';
import { type Actor } from '@/modules/identity/auth-guard';
import { resolveOrCreate } from '@/modules/guests/service';
import { quoteStay, type QuoteInput } from '@/modules/availability/service';
import { syncInvoicePayments } from '@/modules/billing/service';
import {
  allocationsForBooking,
  countBookings,
  findBookingById,
  findBookingByIdempotencyKey,
  findPaymentById,
  insertBooking as insertBookingRow,
  insertBookingGuest,
  insertBookingNight,
  insertPayment,
  insertRoomAllocation,
  listBookings,
  lockBookingForUpdate,
  lockRoomRowsForUpdate,
  paymentsForBooking,
  readDepositPercent,
  releaseReservationsForBooking,
  resolvePropertyId,
  setAllocationStatusForBooking,
  sumCompletedPayments,
  updateBookingStatus,
  updateBookingTotalPaid,
  updateRoomCondition,
  voidPayment,
  type BookingRecord,
  type PaymentRecord,
} from './repository';
import { BOOKING_EVENTS } from './events';
import type { BookingView, CancelBookingInput, CreateBookingInput, PaymentView, RecordPaymentInput, ReversePaymentInput } from './types';

/** The pg driver returns timestamptz as ISO-like strings; convert defensively. */
function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return new Date(v as string | Date).toISOString();
}

function toBookingView(b: BookingRecord): BookingView {
  return {
    id: b.id,
    propertyId: b.propertyId,
    reference: b.reference,
    guestId: b.guestId,
    status: b.status,
    source: b.source,
    arrivalDate: b.arrivalDate,
    departureDate: b.departureDate,
    nights: b.nights ?? 0,
    adults: b.adults,
    children: b.children,
    guestNameSnapshot: b.guestNameSnapshot,
    guestPhoneSnapshot: b.guestPhoneSnapshot,
    totalCharges: b.totalCharges,
    totalPaid: b.totalPaid,
    balance: b.balance ?? '0',
    specialRequests: b.specialRequests,
    internalNotes: b.internalNotes,
    cancellationReason: b.cancellationReason,
    cancelledAt: iso(b.cancelledAt),
    cancelledBy: b.cancelledBy,
    checkedInAt: iso(b.checkedInAt),
    checkedInBy: b.checkedInBy,
    checkedOutAt: iso(b.checkedOutAt),
    checkedOutBy: b.checkedOutBy,
    idempotencyKey: b.idempotencyKey,
    createdAt: iso(b.createdAt)!,
    updatedAt: iso(b.updatedAt)!,
  };
}

function toPaymentView(p: PaymentRecord): PaymentView {
  return {
    id: p.id,
    propertyId: p.propertyId,
    bookingId: p.bookingId,
    receiptNumber: p.receiptNumber,
    paymentType: p.paymentType,
    amount: p.amount,
    method: p.method,
    status: p.status,
    reference: p.reference,
    payerName: p.payerName,
    paidAt: iso(p.paidAt)!,
    notes: p.notes,
    reversalOf: p.reversalOf,
    reversedReason: p.reversedReason,
  };
}

async function scopeProperty(actor: Actor): Promise<string> {
  const propertyId = await withDb((db) => resolvePropertyId(db, actor.propertyId));
  if (!propertyId) throw AppError.notFound('No active property is configured');
  return propertyId;
}

// ─── Create / confirm ────────────────────────────────────────────────────────

/**
 * Create-and-confirm a booking. One transaction, under 250 ms budget:
 * no email, no PDF, no network — side effects go to the outbox.
 */
export async function createBooking(input: CreateBookingInput, actor: Actor): Promise<BookingView> {
  const propertyId = await scopeProperty(actor);

  return withTx(async (tx) => {
    // 1. Idempotency — same key returns the original, never a second booking.
    if (input.idempotencyKey) {
      const existing = await findBookingByIdempotencyKey(tx, propertyId, input.idempotencyKey);
      if (existing) return toBookingView(existing);
    }

    // 2. Guest — resolve or create, then enforce the blacklist gate.
    const guest = await resolveOrCreate(tx, propertyId, input.guest, actor);
    if (guest.isBlacklisted) {
      throw AppError.forbidden('GUEST_BLACKLISTED', `Guest is blacklisted: ${guest.blacklistReason ?? 'no reason'}`);
    }

    // 3. Lock the rooms, consistently ordered, so concurrent bookings queue.
    const roomIds = [...new Set(input.rooms.map((r) => r.roomId))].sort();
    const locked = await lockRoomRowsForUpdate(tx, propertyId, roomIds);
    if (locked.length !== roomIds.length) {
      throw AppError.conflict('ROOM_UNAVAILABLE', 'One or more rooms are unavailable for these dates');
    }
    const lockedById = new Map(locked.map((r) => [r.id, r]));

    // 4. Price server-side. Client totals are never trusted.
    const quotes = new Map<string, Awaited<ReturnType<typeof quoteStay>>>();
    for (const line of input.rooms) {
      if (line.overrideRate != null && !actor.permissions.has('bookings.override_rate')) {
        throw AppError.forbidden('FORBIDDEN', 'Overriding rates requires bookings.override_rate');
      }
      const room = lockedById.get(line.roomId)!;
      const quoteInput: QuoteInput = {
        propertyId,
        roomTypeId: room.roomTypeId,
        arrival: line.arrival,
        departure: line.departure,
        adults: line.adults,
        children: line.children,
        overrideRate: line.overrideRate ?? undefined,
      };
      quotes.set(line.roomId, await quoteStay(tx, quoteInput));
    }

    // 5. Header facts.
    const arrivals = input.rooms.map((r) => r.arrival).sort();
    const departures = input.rooms.map((r) => r.departure).sort();
    const adults = Math.max(...input.rooms.map((r) => r.adults));
    const children = Math.max(...input.rooms.map((r) => r.children));

    // 6. Gap-free reference under an advisory lock scoped to the sequence.
    const { reference } = await nextNumber(tx, propertyId, 'booking', {
      prefix: 'BK-',
      period: today().slice(0, 4),
    });

    const totalCharges = M.add(...[...quotes.values()].map((q) => q.total.toFixed(2)));
    const depositAmount = input.payment ? M.of(input.payment.amount) : M.of(0);

    // 7. Header (status 'confirmed'; balance is a generated column).
    const booking = await insertBookingRow(tx, {
      propertyId,
      reference,
      guestId: guest.id,
      source: input.source,
      arrivalDate: arrivals[0]!,
      departureDate: departures[departures.length - 1]!,
      adults,
      children,
      guestNameSnapshot: guest.fullName,
      guestPhoneSnapshot: guest.phone,
      totalCharges,
      totalPaid: depositAmount,
      specialRequests: input.specialRequests ?? null,
      internalNotes: input.internalNotes ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: actor.id,
    });

    // 8. Allocations — THE EXCLUSION CONSTRAINT IS THE ARBITER. 23P01 here
    //    rolls back the entire transaction; there is no partial booking.
    try {
      for (const line of input.rooms) {
        const quote = quotes.get(line.roomId)!;
        const allocationId = await insertRoomAllocation(tx, {
          propertyId,
          roomId: line.roomId,
          bookingId: booking.id,
          startDate: line.arrival,
          endDate: line.departure,
          roomTypeId: lockedById.get(line.roomId)!.roomTypeId,
          rateSnapshot: quote.roomSubtotal.toFixed(2),
          adults: line.adults,
          children: line.children,
          createdBy: actor.id,
        });
        for (const night of quote.nights) {
          await insertBookingNight(tx, {
            propertyId,
            bookingId: booking.id,
            allocationId,
            roomId: line.roomId,
            roomTypeId: lockedById.get(line.roomId)!.roomTypeId,
            stayDate: night.date,
            rate: night.rate.toFixed(2),
          });
        }
      }
    } catch (e) {
      throw translateDbError(e);
    }

    // 9. Primary guest link + optional deposit.
    await insertBookingGuest(tx, booking.id, guest.id);
    let final = booking;
    if (input.payment) {
      const { totalPaid } = await _recordPayment(tx, propertyId, booking.id, {
        amount: input.payment.amount,
        method: input.payment.method,
        reference: input.payment.reference ?? null,
        notes: input.payment.notes ?? null,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:deposit` : undefined,
      }, actor, 'deposit');
      await updateBookingTotalPaid(tx, booking.id, totalPaid);
      final = (await lockBookingForUpdate(tx, propertyId, booking.id))!;
    }

    // 10. Audit + outbox. NOTHING that talks to the network happens here.
    await eventBus.emit(BOOKING_EVENTS.bookingCreated, {
      bookingId: booking.id,
      reference,
      totalCharges,
      by: actor.email,
    });
    await outbox(tx, [
      { jobType: 'email.booking_confirmation', payload: { bookingId: booking.id }, propertyId, dedupeKey: `confirm:${booking.id}` },
      { jobType: 'realtime.broadcast', payload: { channel: 'availability', bookingId: booking.id }, propertyId },
    ]);

    return toBookingView(final);
  });
}

// ─── Transitions ─────────────────────────────────────────────────────────────

/** confirmed → checked_in. Room must be sellable; deposit policy is enforced. */
export async function checkInBooking(bookingId: string, actor: Actor, overrideDepositReason?: string | null): Promise<BookingView> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const booking = await lockBookingForUpdate(tx, propertyId, bookingId);
    if (!booking) throw AppError.notFound('Booking not found');
    if (booking.status !== 'confirmed') {
      throw AppError.conflict('INVALID_TRANSITION', 'Only confirmed bookings can be checked in');
    }
    if (booking.arrivalDate > today()) {
      throw AppError.conflict('INVALID_TRANSITION', 'Cannot check in before the arrival date');
    }

    // Deposit policy (§12.4): blocked unless the actor records payment and
    // explicitly overrides with a reason.
    const required = await readDepositRequirement(tx, booking.totalCharges);
    if (M.cmp(booking.totalPaid, required) < 0) {
      const canOverride = actor.permissions.has('payments.record') && !!overrideDepositReason;
      if (!canOverride) {
        throw AppError.conflict('DEPOSIT_REQUIRED', `Deposit of ${required} is required before check-in`);
      }
    }

    const allocations = await setAllocationStatusForBooking(tx, bookingId, 'checked_in');
    for (const alloc of allocations) {
      await updateRoomCondition(tx, alloc.roomId, 'occupied');
    }
    const updated = await updateBookingStatus(tx, bookingId, {
      status: 'checked_in',
      checkedInAt: new Date(),
      checkedInBy: actor.id,
    });
    await eventBus.emit(BOOKING_EVENTS.bookingCheckedIn, { bookingId, by: actor.email });
    return toBookingView(updated);
  });
}

/** checked_in → checked_out. Rooms go to cleaning; the folio/invoice is billing's job. */
export async function checkOutBooking(bookingId: string, actor: Actor): Promise<BookingView> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const booking = await lockBookingForUpdate(tx, propertyId, bookingId);
    if (!booking) throw AppError.notFound('Booking not found');
    if (booking.status !== 'checked_in') {
      throw AppError.conflict('INVALID_TRANSITION', 'Only in-house bookings can be checked out');
    }

    const allocations = await setAllocationStatusForBooking(tx, bookingId, 'checked_out');
    for (const alloc of allocations) {
      await updateRoomCondition(tx, alloc.roomId, 'cleaning');
    }
    const updated = await updateBookingStatus(tx, bookingId, {
      status: 'checked_out',
      checkedOutAt: new Date(),
      checkedOutBy: actor.id,
    });
    await eventBus.emit(BOOKING_EVENTS.bookingCheckedOut, { bookingId, by: actor.email });
    return toBookingView(updated);
  });
}

/** draft|confirmed → cancelled. Rooms are released; reasons are mandatory. */
export async function cancelBooking(bookingId: string, input: CancelBookingInput, actor: Actor): Promise<BookingView> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const booking = await lockBookingForUpdate(tx, propertyId, bookingId);
    if (!booking) throw AppError.notFound('Booking not found');
    if (booking.status !== 'confirmed' && booking.status !== 'draft') {
      throw AppError.conflict('INVALID_TRANSITION', 'Only draft or confirmed bookings can be cancelled');
    }

    await releaseReservationsForBooking(tx, bookingId);
    const updated = await updateBookingStatus(tx, bookingId, {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: actor.id,
      cancellationReason: input.reason,
    });
    await eventBus.emit(BOOKING_EVENTS.bookingCancelled, { bookingId, reason: input.reason, by: actor.email });
    return toBookingView(updated);
  });
}

// ─── Payments ────────────────────────────────────────────────────────────────

/** Record a payment against a booking (§12.3). Idempotency is the unique key. */
export async function recordPayment(bookingId: string, input: RecordPaymentInput, actor: Actor): Promise<PaymentView> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const booking = await lockBookingForUpdate(tx, propertyId, bookingId);
    if (!booking) throw AppError.notFound('Booking not found');
    const payment = await _recordPayment(tx, propertyId, bookingId, input, actor, 'payment');
    await updateBookingTotalPaid(tx, bookingId, payment.totalPaid);
    await syncInvoicePayments(tx, bookingId);
    return toPaymentView(payment.record);
  });
}

/** Reverse a payment: the original goes 'reversed', a refund row is booked. */
export async function reversePayment(bookingId: string, paymentId: string, input: ReversePaymentInput, actor: Actor): Promise<PaymentView> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const booking = await lockBookingForUpdate(tx, propertyId, bookingId);
    if (!booking) throw AppError.notFound('Booking not found');

    const payment = await findPaymentById(tx, paymentId);
    if (!payment || payment.bookingId !== bookingId || payment.propertyId !== propertyId) {
      throw AppError.notFound('Payment not found');
    }
    if (payment.status !== 'completed') {
      throw AppError.conflict('INVALID_TRANSITION', 'Only completed payments can be reversed');
    }
    if (payment.paymentType === 'refund') {
      throw AppError.conflict('INVALID_TRANSITION', 'A refund cannot be reversed');
    }

    const { reference } = await nextNumber(tx, propertyId, 'receipt', {
      prefix: 'RC-',
      period: today().slice(0, 4),
    });

    try {
      await voidPayment(tx, paymentId, input.reason, actor.id);
      await insertPayment(tx, {
        propertyId,
        bookingId,
        receiptNumber: reference,
        paymentType: 'refund',
        amount: payment.amount,
        method: payment.method,
        businessDate: today(),
        reference: null,
        notes: `Reversal of ${payment.receiptNumber}: ${input.reason}`,
        reversalOf: payment.id,
        recordedBy: actor.id,
      });
    } catch (e) {
      throw translateDbError(e);
    }

    const totalPaid = await sumCompletedPayments(tx, bookingId);
    await updateBookingTotalPaid(tx, bookingId, totalPaid);
    await syncInvoicePayments(tx, bookingId);

    await eventBus.emit(BOOKING_EVENTS.paymentReversed, { bookingId, paymentId, by: actor.email });
    return toPaymentView(await findPaymentById(tx, paymentId).then((r) => r!));
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listBookingViews(
  filters: { search?: string; status?: string; limit: number; offset: number },
  actor: Actor,
): Promise<{ data: BookingView[]; total: number }> {
  const propertyId = await scopeProperty(actor);
  return withDb(async (db) => {
    const rows = await listBookings(db, { propertyId, ...filters });
    const total = await countBookings(db, { propertyId, search: filters.search, status: filters.status });
    return { data: rows.map(toBookingView), total };
  });
}

export async function getBooking(bookingId: string, actor: Actor): Promise<BookingView> {
  const propertyId = await scopeProperty(actor);
  const booking = await withDb((db) => findBookingById(db, bookingId));
  if (!booking || booking.propertyId !== propertyId) throw AppError.notFound('Booking not found');
  return toBookingView(booking);
}

export async function getBookingAllocations(bookingId: string, actor: Actor): Promise<unknown[]> {
  const propertyId = await scopeProperty(actor);
  const booking = await withDb((db) => findBookingById(db, bookingId));
  if (!booking || booking.propertyId !== propertyId) throw AppError.notFound('Booking not found');
  return withTx((tx) => allocationsForBooking(tx, bookingId));
}

export async function getBookingDetail(bookingId: string, actor: Actor): Promise<{
  booking: BookingView;
  allocations: unknown[];
  payments: PaymentView[];
}> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const booking = await findBookingById(tx, bookingId);
    if (!booking || booking.propertyId !== propertyId) throw AppError.notFound('Booking not found');
    const allocations = await allocationsForBooking(tx, bookingId);
    const payments = await paymentsForBooking(tx, bookingId);
    return { booking: toBookingView(booking), allocations, payments: payments.map(toPaymentView) };
  });
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface PaymentWriteResult {
  record: PaymentRecord;
  totalPaid: string;
}

async function _recordPayment(
  tx: Tx,
  propertyId: string,
  bookingId: string,
  input: RecordPaymentInput,
  actor: Actor,
  paymentType: 'payment' | 'deposit',
): Promise<PaymentWriteResult> {
  const { reference } = await nextNumber(tx, propertyId, 'receipt', {
    prefix: 'RC-',
    period: today().slice(0, 4),
  });
  let record: PaymentRecord;
  try {
record = await insertPayment(tx, {
        propertyId,
        bookingId,
        receiptNumber: reference,
        paymentType,
        amount: input.amount,
        method: input.method,
        businessDate: today(),
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        recordedBy: actor.id,
      });
  } catch (e) {
    throw translateDbError(e);
  }
  const totalPaid = await sumCompletedPayments(tx, bookingId);
  await eventBus.emit(BOOKING_EVENTS.paymentRecorded, { bookingId, paymentId: record.id, by: actor.email });
  await outbox(tx, [
    { jobType: 'email.payment_receipt', payload: { paymentId: record.id }, propertyId, dedupeKey: `receipt:${record.id}` },
  ]);
  return { record, totalPaid };
}

async function readDepositRequirement(tx: Tx, totalCharges: string): Promise<string> {
  const percent = await readDepositPercent(tx);
  return M.mul(totalCharges, percent / 100);
}