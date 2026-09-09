/**
 * Integration test: the housekeeping board and the one-tap flip (§13.4).
 *
 * The board is a projection over the property rooms + the allocation ledger:
 *  - vacant rooms are listed clean/available with no activity flag
 *  - an arriving booking flips its room to 'arrival'
 *  - a departing booking flips its room to 'departure'
 *  - checking in flips the room to 'stayover' and condition to occupied
 *  - the flip (housekeeping.update) writes the rooms table and audits
 *
 * Rows are append-only for the audit FKs (actor -> users, property), so the
 * seeded property + user are documented residue. The seeded bookings here are
 * payment-free, so their bookings/rooms/roomTypes are cleaned in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { addDays, today, type DateOnly } from '@/core/dates';
import { createBooking, checkInBooking } from '@/modules/bookings/service';
import { getHousekeepingBoard, updateHousekeeping } from '../service';
import type { BoardRoomView } from '../types';

vi.setConfig({ testTimeout: 60_000 });

function actor(id: string, propertyId: string | null): Actor {
  return {
    id,
    name: 'HK Admin',
    email: `hk-admin-${randomUUID().slice(0, 6)}@hms.test`,
    role: 'admin',
    propertyId,
    permissions: resolvePermissions('admin', []),
  };
}

const ACTOR = actor('', null);
const ARRIVAL = '101';
const DEPARTURE = '102';
const STAYOVER = '103';

let userId = '';
let propertyId = '';
const rooms: Record<string, string> = {};
const cleanableBookingIds: string[] = [];

async function seed() {
  const prop = randomUUID();
  userId = prop;
  const propertyName = `HK Hotel ${randomUUID().slice(0, 6)}`;
  await withTx(async (tx) => {
    await tx.insert(schema.users).values({
      id: userId,
      name: 'HK Admin',
      email: `hk-admin-${randomUUID().slice(0, 8)}@hms.test`,
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
      .values({ name: propertyName })
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

    for (const n of [ARRIVAL, DEPARTURE, STAYOVER]) {
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

function stay(nights = 1): { arrival: DateOnly; departure: DateOnly } {
  const arrival = today();
  return { arrival, departure: addDays(arrival, nights) };
}

async function bookingOn(roomId: string, arrival: DateOnly, departure: DateOnly) {
  const created = await createBooking(
    {
      guest: { fullName: `Guest ${randomUUID().slice(0, 6)}`, phone: `+2547${randomUUID().slice(0, 8)}`, idType: 'national_id', idNumber: randomUUID() },
      source: 'front_desk',
      rooms: [{ roomId, arrival, departure, adults: 2, children: 0 }],
    },
    ACTOR,
  );
  cleanableBookingIds.push(created.id);
  return created;
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
});

afterAll(async () => {
  await withTx(async (tx) => {
    if (cleanableBookingIds.length > 0) {
      await tx.delete(schema.bookingGuests).where(inArray(schema.bookingGuests.bookingId, cleanableBookingIds));
      await tx.delete(schema.bookings).where(inArray(schema.bookings.id, cleanableBookingIds));
    }
    await tx.delete(schema.guests).where(eq(schema.guests.propertyId, propertyId));
    const roomIds = Object.values(rooms);
    if (roomIds.length > 0) await tx.delete(schema.rooms).where(inArray(schema.rooms.id, roomIds));
    await tx.delete(schema.roomTypes).where(eq(schema.roomTypes.propertyId, propertyId));
    await tx.delete(schema.numberSequences).where(eq(schema.numberSequences.propertyId, propertyId));
  });
});

function byNumber(board: BoardRoomView[], n: string) {
  return board.find((r) => r.roomNumber === n)!;
}

describe('getHousekeepingBoard', () => {
  it('lists every room as vacant / clean / available when idle', async () => {
    const board = await getHousekeepingBoard(today(), ACTOR);
    expect(board).toHaveLength(3);
    const r = byNumber(board, ARRIVAL);
    expect(r).toMatchObject({ condition: 'available', housekeeping: 'clean', activity: 'vacant' });
  });

  it('flags rooms with a same-day arrival as arrival', async () => {
    const d = stay();
    await bookingOn(rooms[ARRIVAL]!, d.arrival, d.departure);
    const board = await getHousekeepingBoard(today(), ACTOR);
    expect(byNumber(board, ARRIVAL).activity).toBe('arrival');
  });

  it('flags rooms departing today as departure', async () => {
    const arrival = addDays(today(), -2);
    await bookingOn(rooms[DEPARTURE]!, arrival, addDays(arrival, 2));
    const board = await getHousekeepingBoard(today(), ACTOR);
    expect(byNumber(board, DEPARTURE).activity).toBe('departure');
  });

  it('flags checked-in rooms as stayover', async () => {
    const arrival = addDays(today(), -1);
    await bookingOn(rooms[STAYOVER]!, arrival, addDays(arrival, 2));
    const bookingId = cleanableBookingIds[cleanableBookingIds.length - 1]!;
    await checkInBooking(bookingId, ACTOR, 'integration-test override');
    const board = await getHousekeepingBoard(today(), ACTOR);
    const r = byNumber(board, STAYOVER);
    expect(r.activity).toBe('stayover');
    expect(r.condition).toBe('occupied');
  });
});

describe('updateHousekeeping', () => {
  it('flips housekeeping and audits housekeeping.update', async () => {
    const updated = await updateHousekeeping(rooms[ARRIVAL]!, { housekeeping: 'dirty' }, ACTOR);
    expect(updated.housekeeping).toBe('dirty');

    const row = await withDb((db) =>
      db
        .select({ action: schema.activityLogs.action })
        .from(schema.activityLogs)
        .where(
          and(
            eq(schema.activityLogs.actorId, userId),
            eq(schema.activityLogs.entityId, rooms[ARRIVAL]!),
            eq(schema.activityLogs.action, 'housekeeping.update'),
          ),
        ),
    );
    expect(row.length).toBeGreaterThanOrEqual(1);
    const board = await getHousekeepingBoard(today(), ACTOR);
    expect(byNumber(board, ARRIVAL).housekeeping).toBe('dirty');
  });

  it('can flip condition and housekeeping together', async () => {
    const updated = await updateHousekeeping(
      rooms[DEPARTURE]!,
      { housekeeping: 'clean', condition: 'available' },
      ACTOR,
    );
    expect(updated).toMatchObject({ housekeeping: 'clean', condition: 'available' });
  });
});