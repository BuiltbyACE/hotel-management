/**
 * Integration test: the front desk today board + the walk-in (§13.1, §16.3).
 *
 * The lists are projections over the allocation ledger (arrivals departures
 * in-house) and the walk-in composes guest + booking + check-in. Rows that
 * touch money (the walk-in's payment) are append-only, so the walk-in booking
 * is documented residue; payment-free bookings and their rooms are cleaned.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { addDays, today, type DateOnly } from '@/core/dates';
import { quoteStay } from '@/modules/availability/service';
import { createBooking, checkInBooking } from '@/modules/bookings/service';
import { arrivalsOn, departuresOn, inHouseOn, getTodaySummary, walkIn } from '../service';
import type { WalkInInput } from '../validation';

vi.setConfig({ testTimeout: 60_000 });

function actor(id: string, propertyId: string | null): Actor {
  return {
    id,
    name: 'FD Admin',
    email: `fd-admin-${randomUUID().slice(0, 6)}@hms.test`,
    role: 'admin',
    propertyId,
    permissions: resolvePermissions('admin', []),
  };
}

const ACTOR = actor('', null);

const ARRIVAL = '201';
const DEPARTURE = '202';
const IN_HOUSE = '203';
const WALK_IN = '204';

let userId = '';
let propertyId = '';
let roomTypeId = '';
const rooms: Record<string, string> = {};
const cleanableBookingIds: string[] = [];

async function seed() {
  await withTx(async (tx) => {
    userId = randomUUID();
    await tx.insert(schema.users).values({
      id: userId,
      name: 'FD Admin',
      email: `fd-admin-${randomUUID().slice(0, 8)}@hms.test`,
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
      createdBy: null,
    });
    await tx.insert(schema.accounts).values({
      id: randomUUID(),
      userId,
      providerId: 'credential',
      accountId: userId,
      password: 'not-used-in-tests',
    });
    const propId = await tx
      .insert(schema.properties)
      .values({ name: `FD Hotel ${randomUUID().slice(0, 6)}` })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);
    propertyId = propId;

    const rt = await tx
      .insert(schema.roomTypes)
      .values({
        propertyId,
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
    roomTypeId = rt;

    for (const n of [ARRIVAL, DEPARTURE, IN_HOUSE, WALK_IN]) {
      rooms[n] = await tx
        .insert(schema.rooms)
        .values({ propertyId, roomTypeId: rt, roomNumber: n })
        .returning({ id: schema.rooms.id })
        .then((rows) => rows[0]!.id);
    }
  });
  ACTOR.id = userId;
  ACTOR.propertyId = propertyId;
}

function bookingOn(roomId: string, arrival: DateOnly, departure: DateOnly) {
  return createBooking(
    {
      guest: { fullName: `Guest ${randomUUID().slice(0, 6)}`, phone: `+2547${randomUUID().slice(0, 8)}`, idType: 'national_id', idNumber: randomUUID() },
      source: 'front_desk',
      rooms: [{ roomId, arrival, departure, adults: 2, children: 0 }],
    },
    ACTOR,
  ).then((b) => {
    cleanableBookingIds.push(b.id);
    return b;
  });
}

async function checkIn(bookingId: string) {
  return checkInBooking(bookingId, ACTOR, 'integration-test override');
}

beforeAll(async () => {
  await withTx((tx) =>
    tx.insert(schema.settings).values([
      { key: 'vat_rate', value: 16 },
      { key: 'levy_rate', value: 2 },
      { key: 'tax_inclusive_pricing', value: false },
      { key: 'deposit_percent', value: 0 },
    ]).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    }),
  );
  await seed();

  await bookingOn(rooms[ARRIVAL]!, today(), addDays(today(), 2)); // arriving today
  await bookingOn(rooms[DEPARTURE]!, addDays(today(), -3), today()); // due out today
  const inHouse = await bookingOn(rooms[IN_HOUSE]!, addDays(today(), -1), addDays(today(), 1));
  await checkIn(inHouse.id);
});

afterAll(async () => {
  await withTx(async (tx) => {
    if (cleanableBookingIds.length > 0) {
      await tx.delete(schema.bookingGuests).where(inArray(schema.bookingGuests.bookingId, cleanableBookingIds));
      await tx.delete(schema.bookings).where(inArray(schema.bookings.id, cleanableBookingIds));
    }
    // room 204 carries the append-only walk-in payment → stays as residue.
    await tx.delete(schema.rooms).where(inArray(schema.rooms.id, [rooms[ARRIVAL]!, rooms[DEPARTURE]!, rooms[IN_HOUSE]!]));
    await tx.delete(schema.numberSequences).where(eq(schema.numberSequences.propertyId, propertyId));
  });
});

describe('front desk lists', () => {
  it('lists arrivals for the date', async () => {
    const rows = await arrivalsOn(today(), ACTOR);
    expect(rows.some((r) => r.roomId === rooms[ARRIVAL]!)).toBe(true);
    expect(rows.some((r) => r.roomId === rooms[DEPARTURE]!)).toBe(false);
  });

  it('lists departures for the date', async () => {
    const rows = await departuresOn(today(), ACTOR);
    expect(rows.some((r) => r.roomId === rooms[DEPARTURE]!)).toBe(true);
  });

  it('lists in-house rooms', async () => {
    const rows = await inHouseOn(ACTOR);
    expect(rows.some((r) => r.roomId === rooms[IN_HOUSE]!)).toBe(true);
    expect(rows.some((r) => r.roomId === rooms[ARRIVAL]!)).toBe(false);
  });

  it('summarises the day at a glance', async () => {
    const s = await getTodaySummary(today(), ACTOR);
    expect(s).toMatchObject({ date: today(), roomsTotal: 4, roomsOccupied: 1, roomsVacant: 3, occupancyPct: 25 });
    expect(s.arrivals.some((r) => r.roomId === rooms[ARRIVAL]!)).toBe(true);
    expect(s.departures.some((r) => r.roomId === rooms[DEPARTURE]!)).toBe(true);
    expect(s.inHouse.some((r) => r.roomId === rooms[IN_HOUSE]!)).toBe(true);
  });
});

describe('walkIn', () => {
  it('creates a guest + booking and checks in, in the walk-in flow', async () => {
    const arrival = today();
    const departure = addDays(arrival, 1);
    const quote = await withDb((db) =>
      quoteStay(db, {
        propertyId,
        roomTypeId,
        arrival,
        departure,
        adults: 2,
        children: 0,
      }),
    );

    const input: WalkInInput = {
      guest: { fullName: 'Walk In Wonder', phone: '+254700000000' },
      rooms: [{ roomId: rooms[WALK_IN]!, arrival, departure, adults: 2, children: 0 }],
      payment: { amount: quote.total, method: 'cash' },
    };

    const result = await walkIn(input, ACTOR);

    expect(result.status).toBe('checked_in');
    expect(result.source).toBe('walk_in');
    expect(result.arrivalDate).toBe(arrival);

    const alloc = await withDb((db) =>
      db.select().from(schema.roomAllocations).where(eq(schema.roomAllocations.bookingId, result.id)),
    );
    expect(alloc).toHaveLength(1);
    expect(alloc[0]).toMatchObject({ roomId: rooms[WALK_IN]!, status: 'checked_in', kind: 'reservation' });

    const roomRow = await withDb((db) => db.select().from(schema.rooms).where(eq(schema.rooms.id, rooms[WALK_IN]!)));
    expect(roomRow[0]!.condition).toBe('occupied');

    const folio = await withDb((db) => db.select().from(schema.bookings).where(and(eq(schema.bookings.id, result.id))));
    expect(folio[0]!.totalPaid).toBe(quote.total);
  });
});