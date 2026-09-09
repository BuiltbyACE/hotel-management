/**
 * Integration test: booking lifecycle, idempotency, concurrency, deposit
 * policy, payments + reversal against Postgres. Blueprint §11, §12.3, §12.4.
 *
 * Two properties:
 *  - MAIN: payment-free lifecycle/cancel/concurrency — fully cleaned in afterAll.
 *  - LEDGER: every scenario that records a payment (deposit policy, payments,
 *    reversal). payments are append-only for hms_app (§11 ROLE REVOKE) and
 *    `payments.booking_id` is a hard FK, so ledger rows cannot be deleted —
 *    this residue is intentional and documented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { AppError } from '@/core/api/errors';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { addDays, nightCount, today, type DateOnly } from '@/core/dates';
import { quoteStay } from '@/modules/availability/service';
import {
  cancelBooking,
  checkInBooking,
  checkOutBooking,
  createBooking,
  getBookingDetail,
  listBookingViews,
  recordPayment,
  reversePayment,
} from '@/modules/bookings/service';
import type { CreateBookingInput } from '@/modules/bookings/types';

vi.setConfig({ testTimeout: 60_000 });

function actor(id: string, propertyId: string | null, role: Actor['role'] = 'admin'): Actor {
  return {
    id,
    name: role,
    email: `${role}-${randomUUID().slice(0, 6)}@hms.test`,
    role,
    propertyId,
    permissions: resolvePermissions(role, []),
  };
}

function code(code: string) {
  return (e: unknown) => e instanceof AppError && e.code === code;
}

function stay(roomId: string, nights = 2): { arrival: DateOnly; departure: DateOnly } {
  const arrival = today();
  return { arrival, departure: addDays(arrival, nights) };
}

const MAIN: Actor = actor('', null);
const LEDGER: Actor = actor('', null);

let mainProperty = '';
let mainRooms: Record<string, string> = {};
const mainBookingIds: string[] = [];

let ledgerProperty = '';
let ledgerRooms: Record<string, string> = {};

let userId = '';
let ledgerUserId = '';

async function seedProperty(
  name: string,
  numbers: string[],
): Promise<{ propertyId: string; rooms: Record<string, string> }> {
  return withTx(async (tx) => {
    const prop = await tx
      .insert(schema.properties)
      .values({ name })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);

    const rt = await tx
      .insert(schema.roomTypes)
      .values({
        propertyId: prop,
        code: 'STD',
        name: 'Standard',
        baseRate: '5000.00',
        maxOccupancy: 2,
        maxAdults: 2,
        maxChildren: 1,
        extraBedRate: '1500.00',
      })
      .returning({ id: schema.roomTypes.id })
      .then((rows) => rows[0]!.id);

    const rooms: Record<string, string> = {};
    for (const n of numbers) {
      rooms[`r${n}`] = await tx
        .insert(schema.rooms)
        .values({ propertyId: prop, roomTypeId: rt, roomNumber: n })
        .returning({ id: schema.rooms.id })
        .then((rows) => rows[0]!.id);
    }
    return { propertyId: prop, rooms };
  });
}

async function setDepositPercent(percent: number) {
  await withTx((tx) =>
    tx.insert(schema.settings).values({ key: 'deposit_percent', value: percent }).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    }),
  );
}

/**
 * deposit_percent lives in the single global settings table, and other suites
 * (billing, property) re-assert their own values concurrently on the same row.
 * So after we set 50% another suite may flip it to 0 before the check-in read.
 * Hardened like the billing totals: re-assert before each attempt and retry
 * until we actually observe the enforcement the assertion is about. Retries use
 * their own room per attempt — a booking that slipped through a flip is
 * checked-in residue (checked_out still blocks availability, so it can never
 * be reused).
 */
const ENFORCED_POOL = ['305', '306', '307', '308'] as const;
async function expectDepositEnforced(): Promise<{
  id: string;
  totalCharges: string;
}> {
  for (let attempt = 1; attempt <= ENFORCED_POOL.length; attempt++) {
    await setDepositPercent(50);
    const roomId = ledgerRooms[`r${ENFORCED_POOL[attempt - 1]}`]!;
    // LEDGER bookings always carry append-only payment/finance rows — they are
    // never added to mainBookingIds and stay as documented residue.
    const created = await createBooking(booking(roomId), LEDGER);
    try {
      await checkInBooking(created.id, LEDGER, null);
    } catch (e) {
      if (e instanceof AppError && e.code === 'DEPOSIT_REQUIRED') return created;
      throw e;
    }
  }
  throw new Error('deposit enforcement never observed (concurrent deposit_percent flips)');
}

function booking(roomId: string, over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  const d = stay(roomId);
  return {
    guest: { fullName: `Guest ${randomUUID().slice(0, 6)}`, phone: `+2547${randomUUID().slice(0, 8)}`, idType: 'national_id', idNumber: randomUUID() },
    source: 'front_desk',
    rooms: [{ roomId, arrival: d.arrival, departure: d.departure, adults: 2, children: 0 }],
    ...over,
  };
}

beforeAll(async () => {
  const mainUser = randomUUID();
  const ledgerUser = randomUUID();

  await withTx(async (tx) => {
    for (const [id, name] of [
      [mainUser, 'Bookings Admin'],
      [ledgerUser, 'Bookings Ledger Admin'],
    ] as const) {
      await tx.insert(schema.users).values({
        id,
        name,
        email: `${name.toLowerCase().replaceAll(' ', '-')}-${randomUUID().slice(0, 8)}@hms.test`,
        role: 'admin',
        status: 'active',
        mustChangePassword: true,
        createdBy: null,
      });
      await tx.insert(schema.accounts).values({
        id: randomUUID(),
        userId: id,
        providerId: 'credential',
        accountId: id,
        password: 'not-used-in-tests',
      });
    }
  });

  await withTx((tx) =>
    tx
      .insert(schema.settings)
      .values([
        { key: 'vat_rate', value: 16 },
        { key: 'levy_rate', value: 0 },
        { key: 'tax_inclusive_pricing', value: false },
        { key: 'deposit_percent', value: 0 },
      ])
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: sql`excluded.value`, updatedAt: sql`now()` },
      }),
  );

  userId = mainUser;
  ledgerUserId = ledgerUser;
  const main = await seedProperty(`Bookings Hotel ${randomUUID().slice(0, 6)}`, [
    '101', '102', '103', '201', '202', '203', '204', '205', '206', '207', '208',
  ]);
  const ledger = await seedProperty(`Bookings Ledger ${randomUUID().slice(0, 6)}`, [
    '301', '302', '303', '304', '305', '306', '307', '308',
  ]);

  mainProperty = main.propertyId;
  mainRooms = main.rooms;
  ledgerProperty = ledger.propertyId;
  ledgerRooms = ledger.rooms;

  MAIN.id = userId;
  MAIN.propertyId = mainProperty;
  LEDGER.id = ledgerUserId;
  LEDGER.propertyId = ledgerProperty;
});

afterAll(async () => {
  await withTx(async (tx) => {
    // MAIN bookings are payment-free → safe to delete (cascade through
    // allocations → booking_nights bypasses the DELETE revoke). The property /
    // job_queue / files rows are append-only residue, exactly like LEDGER:
    // every createBooking outbox-enqueues job_queue rows and hms_app may not
    // delete them, so the property can never be dropped. Unique UUIDs keep
    // each run isolated.
    if (mainBookingIds.length > 0) {
      await tx.delete(schema.bookingGuests).where(inArray(schema.bookingGuests.bookingId, mainBookingIds));
      await tx.delete(schema.bookings).where(inArray(schema.bookings.id, mainBookingIds));
    }
    await tx.delete(schema.guests).where(eq(schema.guests.propertyId, mainProperty));
    const mains = Object.values(mainRooms);
    if (mains.length > 0) await tx.delete(schema.rooms).where(inArray(schema.rooms.id, mains));
    const mRoomTypes = await tx
      .select({ id: schema.roomTypes.id })
      .from(schema.roomTypes)
      .where(eq(schema.roomTypes.propertyId, mainProperty));
    if (mRoomTypes.length > 0) {
      await tx.delete(schema.roomTypes).where(inArray(schema.roomTypes.id, mRoomTypes.map((r) => r.id)));
    }
    await tx.delete(schema.numberSequences).where(eq(schema.numberSequences.propertyId, mainProperty));
    // converge the global settings back to blueprint defaults.
    await tx.insert(schema.settings).values([
      { key: 'vat_rate', value: 16 },
      { key: 'levy_rate', value: 2 },
      { key: 'tax_inclusive_pricing', value: false },
      { key: 'deposit_percent', value: 0 },
    ]).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });
    // The booked-in admin now has activity_logs rows (actor_id FK) and the
    // audit trail is append-only, so the user row itself can never be removed.
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
    await tx.delete(schema.accounts).where(eq(schema.accounts.userId, userId));
  });
});

describe('createBooking', () => {
  it('confirms a booking at the server-side price and writes ledger rows', async () => {
    const roomId = mainRooms.r101!;
    const input = booking(roomId);
    const typeId = (await roomTypeFor(roomId))!;
    const quote = await withDb((db) =>
      quoteStay(db, {
        propertyId: mainProperty,
        roomTypeId: typeId,
        arrival: input.rooms[0]!.arrival,
        departure: input.rooms[0]!.departure,
        adults: 2,
        children: 0,
      }),
    );

    const created = await createBooking(input, MAIN);
    mainBookingIds.push(created.id);

    expect(created.status).toBe('confirmed');
    expect(created.nights).toBe(2);
    expect(created.arrivalDate).toBe(input.rooms[0]!.arrival);
    expect(created.departureDate).toBe(input.rooms[0]!.departure);
    expect(created.totalCharges).toBe(quote.total.toFixed(2));
    expect(created.totalPaid).toBe('0.00');
    expect(created.balance).toBe(quote.total.toFixed(2));
    expect(created.source).toBe('front_desk');
    expect(created.reference).toMatch(/^BK-/);
    expect(created.guestNameSnapshot).toBe(input.guest.fullName);

    const allocations = await withDb((db) =>
      db.select().from(schema.roomAllocations).where(eq(schema.roomAllocations.bookingId, created.id)),
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      roomId,
      kind: 'reservation',
      status: 'confirmed',
      startDate: input.rooms[0]!.arrival,
      endDate: input.rooms[0]!.departure,
    });
    expect(allocations[0]!.rateSnapshot).toBe(quote.roomSubtotal.toFixed(2));

    const nights = await withDb((db) =>
      db.select().from(schema.bookingNights).where(eq(schema.bookingNights.bookingId, created.id)),
    );
    expect(nights).toHaveLength(
      nightCount(input.rooms[0]!.arrival as DateOnly, input.rooms[0]!.departure as DateOnly),
    );
    expect(nights.every((n) => n.rate === '5000.00' && !n.isPosted)).toBe(true);
  });

  it('returns the same booking for the same idempotency key', async () => {
    const roomId = mainRooms.r102!;
    const input = booking(roomId, { idempotencyKey: 'idem-bookings-1' });

    const first = await createBooking(input, MAIN);
    mainBookingIds.push(first.id);
    const second = await createBooking(input, MAIN);

    expect(second.id).toBe(first.id);
    const rows = await withDb((db) =>
      db
        .select({ id: schema.bookings.id })
        .from(schema.bookings)
        .where(and(eq(schema.bookings.idempotencyKey, 'idem-bookings-1'), eq(schema.bookings.propertyId, mainProperty))),
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects a second booking over the same nights (ROOM_UNAVAILABLE)', async () => {
    const roomId = mainRooms.r103!;
    const first = await createBooking(booking(roomId, { idempotencyKey: `double-${randomUUID()}` }), MAIN);
    mainBookingIds.push(first.id);

    const rival = booking(roomId, { idempotencyKey: `rival-${randomUUID()}` });
    await expect(createBooking(rival, MAIN)).rejects.toSatisfy(code('ROOM_UNAVAILABLE'));
  });

  it('rejects blacklisted guests (GUEST_BLACKLISTED)', async () => {
    const idNumber = `BLK-${randomUUID().slice(0, 8)}`;
    await withTx((tx) =>
      tx.insert(schema.guests).values({
        propertyId: mainProperty,
        fullName: 'Trouble Maker',
        idType: 'national_id',
        idNumber,
        isBlacklisted: true,
        blacklistReason: 'Stole the towels',
        createdBy: userId,
      }),
    );

    const input = booking(mainRooms.r201!, {
      guest: { fullName: 'Trouble Maker', idType: 'national_id', idNumber },
    });
    await expect(createBooking(input, MAIN)).rejects.toSatisfy(code('GUEST_BLACKLISTED'));
  });

  it('dedupes the guest across bookings (resolveOrCreate)', async () => {
    const phone = `+2547${randomUUID().slice(0, 8)}`;
    const a = await createBooking(booking(mainRooms.r202!, { guest: { fullName: 'Repeat Guest', phone } }), MAIN);
    mainBookingIds.push(a.id);
    const b = await createBooking(booking(mainRooms.r203!, { guest: { fullName: 'Repeat Guest', phone } }), MAIN);
    mainBookingIds.push(b.id);

    expect(b.guestId).toBe(a.guestId);
  });

  it('lets 14 concurrent attempts on the same nights produce exactly one winner', async () => {
    const roomId = mainRooms.r204!;
    const attempts = Array.from({ length: 14 }, (_, i) =>
      createBooking(
        booking(roomId, { idempotencyKey: `race-${i}-${randomUUID()}` }),
        MAIN,
      ),
    );
    const settled = await Promise.allSettled(attempts);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const busy = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

    expect(ok).toHaveLength(1);
    expect(busy.every((b) => code('ROOM_UNAVAILABLE')(b.reason))).toBe(true);
    for (const b of ok) mainBookingIds.push((b as PromiseFulfilledResult<Awaited<ReturnType<typeof createBooking>>>).value.id);
  });
});

describe('lifecycle transitions', () => {
  it('checks in and back out, moving the room through occupied → cleaning', async () => {
    const roomId = mainRooms.r205!;
    const created = await createBooking(booking(roomId), MAIN);
    mainBookingIds.push(created.id);

    const inHouse = await checkInBooking(created.id, MAIN);
    expect(inHouse.status).toBe('checked_in');
    expect(inHouse.checkedInBy).toBe(userId);
    expect(inHouse.checkedInAt).toBeTruthy();

    const condition = await withDb((db) =>
      db.select({ condition: schema.rooms.condition }).from(schema.rooms).where(eq(schema.rooms.id, roomId)),
    );
    expect(condition[0]!.condition).toBe('occupied');

    const out = await checkOutBooking(created.id, MAIN);
    expect(out.status).toBe('checked_out');
    expect(out.checkedOutAt).toBeTruthy();

    const after = await withDb((db) =>
      db.select({ condition: schema.rooms.condition }).from(schema.rooms).where(eq(schema.rooms.id, roomId)),
    );
    expect(after[0]!.condition).toBe('cleaning');

    const allocs = await withDb((db) =>
      db.select().from(schema.roomAllocations).where(eq(schema.roomAllocations.bookingId, created.id)),
    );
    expect(allocs.every((a) => a.status === 'checked_out')).toBe(true);
  });

  it('refuses transitions out of order', async () => {
    const created = await createBooking(booking(mainRooms.r206!), MAIN);
    mainBookingIds.push(created.id);

    await expect(checkOutBooking(created.id, MAIN)).rejects.toSatisfy(code('INVALID_TRANSITION'));

    await checkInBooking(created.id, MAIN);
    await expect(cancelBooking(created.id, { reason: 'Booking was in the wrong state' }, MAIN)).rejects.toSatisfy(
      code('INVALID_TRANSITION'),
    );
  });

  it('releases rooms on cancellation', async () => {
    const roomId = mainRooms.r207!;
    const created = await createBooking(booking(roomId), MAIN);
    mainBookingIds.push(created.id);

    const cancelled = await cancelBooking(created.id, { reason: 'Guest changed their mind' }, MAIN);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationReason).toBe('Guest changed their mind');
    expect(cancelled.cancelledBy).toBe(userId);

    const allocs = await withDb((db) =>
      db.select().from(schema.roomAllocations).where(eq(schema.roomAllocations.bookingId, created.id)),
    );
    expect(allocs.every((a) => a.status === 'released')).toBe(true);
  });
});

describe('deposit policy (§12.4) + payments (§12.3) — LEDGER property', () => {
  it('blocks check-in below the deposit, honours a justified override, and clears after payment', async () => {
    const noDeposit = await expectDepositEnforced();

    const required = (Number(noDeposit.totalCharges) * 0.5).toFixed(2);
    await recordPayment(noDeposit.id, { amount: required, method: 'mpesa', reference: 'TXN-DEP-1' }, LEDGER);
    const paid = await checkInBooking(noDeposit.id, LEDGER, null);
    expect(paid.status).toBe('checked_in');
    expect(paid.totalPaid).toBe(required);

    const override = await createBooking(booking(ledgerRooms.r302!), LEDGER);
    const checkedIn = await checkInBooking(override.id, LEDGER, 'Client confirmed the wire transfer');
    expect(checkedIn.status).toBe('checked_in');
  });

  it('records a payment, then reverses it into a refund and recomputes the balance', async () => {
    const created = await createBooking(
      booking(ledgerRooms.r303!, { payment: { amount: '2000.00', method: 'card', reference: 'CARD-77' } }),
      LEDGER,
    );
    expect(created.totalPaid).toBe('2000.00');

    const second = await recordPayment(created.id, { amount: '4000.00', method: 'card', reference: 'CARD-78' }, LEDGER);
    expect(second.amount).toBe('4000.00');
    expect(second.status).toBe('completed');

    const detail = await getBookingDetail(created.id, LEDGER);
    expect(detail.booking.totalPaid).toBe('6000.00');
    expect(detail.payments).toHaveLength(2);

    const reversed = await reversePayment(created.id, second.id, { reason: 'Duplicate card charge' }, LEDGER);
    expect(reversed.status).toBe('reversed');
    expect(reversed.reversedReason).toBe('Duplicate card charge');

    const after = await getBookingDetail(created.id, LEDGER);
    expect(after.payments).toHaveLength(3);
    const refund = after.payments.find((p) => p.paymentType === 'refund')!;
    expect(refund.amount).toBe('4000.00');
    expect(refund.reversalOf).toBe(second.id);
    expect(after.booking.totalPaid).toBe('2000.00');
    expect(after.booking.balance).toBe((Number(after.booking.totalCharges) - 2000).toFixed(2));

    await expect(reversePayment(created.id, second.id, { reason: 'Cannot reverse twice' }, LEDGER)).rejects.toSatisfy(
      code('INVALID_TRANSITION'),
    );
  });

  it('forbids reversing a refund', async () => {
    const created = await createBooking(
      booking(ledgerRooms.r304!, { payment: { amount: '1000.00', method: 'cash' } }),
      LEDGER,
    );
    const parsed = await getBookingDetail(created.id, LEDGER);
    const payment = parsed.payments[0]!;

    const reversed = await reversePayment(created.id, payment.id, { reason: 'Couple split the bill' }, LEDGER);
    expect(reversed.status).toBe('reversed');
    expect(reversed.paymentType).toBe('deposit');
    expect(reversed.reversedReason).toBe('Couple split the bill');

    const refund = (await getBookingDetail(created.id, LEDGER)).payments.find((p) => p.paymentType === 'refund')!;
    await expect(reversePayment(created.id, refund.id, { reason: 'Nope, cannot undo a refund' }, LEDGER)).rejects.toSatisfy(
      code('INVALID_TRANSITION'),
    );
  });
});

describe('reads', () => {
  it('lists bookings with pagination and search', async () => {
    const list = await listBookingViews({ limit: 25, offset: 0 }, MAIN);
    expect(list.total).toBeGreaterThan(0);
    expect(list.data.some((b) => b.reference.startsWith('BK-'))).toBe(true);

    const searched = await listBookingViews({ search: 'Repeat Guest', limit: 25, offset: 0 }, MAIN);
    expect(searched.data.every((b) => b.guestNameSnapshot === 'Repeat Guest')).toBe(true);
  });

  it('returns allocations and payments in the detail', async () => {
    const roomId = mainRooms.r208!;
    const created = await createBooking(booking(roomId), MAIN);
    mainBookingIds.push(created.id);

    const detail = await getBookingDetail(created.id, MAIN);
    expect(detail.booking.id).toBe(created.id);
    expect(detail.allocations).toContainEqual(expect.objectContaining({ roomId, status: 'confirmed' }));
    expect(detail.payments).toEqual([]);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function roomTypeFor(roomId: string): Promise<string | null> {
  const rows = await withDb((db) =>
    db
      .select({ roomTypeId: schema.rooms.roomTypeId })
      .from(schema.rooms)
      .where(eq(schema.rooms.id, roomId))
      .limit(1),
  );
  return rows[0]?.roomTypeId ?? null;
}