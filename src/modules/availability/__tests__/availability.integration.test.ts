/**
 * Integration test: availability reads + server-side quoting against Postgres.
 * The allocation ledger, calendar, tape, and rate-rule resolution are covered.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, and, isNotNull, sql } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import {
  findAvailableRooms,
  getCalendar,
  getTape,
  quoteStay,
  quoteStayForActor,
} from '@/modules/availability/service';

vi.setConfig({ testTimeout: 30_000 });

function actor(role: Actor['role'], propertyId: string | null, id?: string): Actor {
  return {
    id: id ?? randomUUID(),
    name: role,
    email: `${role}@actor.test`,
    role,
    propertyId,
    permissions: resolvePermissions(role, []),
  };
}

const ADMIN = actor('admin', null);

let propertyId = '';
let roomA101 = '';
let roomA201 = '';
let roomA202 = '';
let guestId = '';
const userIds: string[] = [];
const extraRooms: string[] = [];

/** Insert a room allocation + its booking in one transaction. */
async function addAllocation(params: {
  roomId: string;
  status: 'held' | 'confirmed' | 'released';
  start: string;
  end: string;
  bookingStatus?: 'draft' | 'confirmed';
}) {
  const { roomId, status, start, end } = params;
  const reference = `AV-BK-${randomUUID().slice(0, 6)}`;
  await withTx(async (tx) => {
    const booking = await tx
      .insert(schema.bookings)
      .values({
        propertyId,
        reference,
        guestId,
        status: params.bookingStatus ?? (status === 'held' ? 'draft' : 'confirmed'),
        arrivalDate: start,
        departureDate: end,
        guestNameSnapshot: 'Availability Dummy',
        createdBy: ADMIN.id,
      })
      .returning({ id: schema.bookings.id })
      .then((rows) => rows[0]!.id);
    await tx.insert(schema.roomAllocations).values({
      propertyId,
      roomId,
      kind: 'reservation',
      status,
      bookingId: booking,
      startDate: start,
      endDate: end,
      adults: 1,
      createdBy: ADMIN.id,
    });
  });
}

async function newProperty(name: string, opts: { active?: boolean } = {}): Promise<string> {
  return withTx(async (tx) => {
    const prop = await tx
      .insert(schema.properties)
      .values({ name, isActive: opts.active ?? true })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);
    return prop;
  });
}

beforeAll(async () => {
  const seeded = await withTx(async (tx) => {
    const prop = await tx
      .insert(schema.properties)
      .values({ name: `Availability Hotel ${randomUUID().slice(0, 6)}` })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);

    const user = await tx
      .insert(schema.users)
      .values({
        id: randomUUID(),
        name: 'Avail Admin',
        email: `avail-admin-${randomUUID().slice(0, 8)}@hotm.test`,
        role: 'admin',
        status: 'active',
        mustChangePassword: true,
        createdBy: null,
      })
      .returning({ id: schema.users.id })
      .then((rows) => rows[0]!.id);
    await tx.insert(schema.accounts).values({
      id: randomUUID(),
      userId: user,
      providerId: 'credential',
      accountId: user,
      password: 'not-used-in-tests',
    });

    const rtStandard = await tx
      .insert(schema.roomTypes)
      .values({
        propertyId: prop,
        code: 'STD',
        name: 'Standard',
        baseRate: '5000.00',
        maxOccupancy: 2,
        maxAdults: 2,
        maxChildren: 0,
        extraBedRate: '1500.00',
      })
      .returning({ id: schema.roomTypes.id })
      .then((rows) => rows[0]!.id);
    const rtDeluxe = await tx
      .insert(schema.roomTypes)
      .values({
        propertyId: prop,
        code: 'DLX',
        name: 'Deluxe',
        baseRate: '8000.00',
        maxOccupancy: 3,
        maxAdults: 3,
        maxChildren: 1,
        extraBedRate: '2000.00',
      })
      .returning({ id: schema.roomTypes.id })
      .then((rows) => rows[0]!.id);

    const mkRoom = async (
      number: string,
      typeId: string,
      over: Partial<{ condition: 'available' | 'occupied' | 'cleaning' | 'maintenance' | 'out_of_order'; isActive: boolean }> = {},
    ) => {
      return tx
        .insert(schema.rooms)
        .values({ propertyId: prop, roomTypeId: typeId, roomNumber: number, ...over })
        .returning({ id: schema.rooms.id })
        .then((rows) => rows[0]!.id);
    };
    const roomA101 = await mkRoom('101', rtStandard);
    await mkRoom('102', rtStandard, { condition: 'out_of_order' });
    await mkRoom('103', rtStandard, { isActive: false });
    await mkRoom('104', rtStandard);
    const roomA201 = await mkRoom('201', rtDeluxe);
    const roomA202 = await mkRoom('202', rtDeluxe);

    const guest = await tx
      .insert(schema.guests)
      .values({ propertyId: prop, fullName: 'Avail Guest', createdBy: user })
      .returning({ id: schema.guests.id })
      .then((rows) => rows[0]!.id);

    // settings are GLOBAL (no property column) — converge to known values.
    await tx.insert(schema.settings).values([
      { key: 'vat_rate', value: 16 },
      { key: 'levy_rate', value: 0 },
      { key: 'tax_inclusive_pricing', value: false },
    ]).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });

    return { prop, user, roomA101, roomA201, roomA202, guest };
  });

  propertyId = seeded.prop;
  roomA101 = seeded.roomA101;
  roomA201 = seeded.roomA201;
  roomA202 = seeded.roomA202;
  guestId = seeded.guest;
  ADMIN.propertyId = propertyId;
  ADMIN.id = seeded.user;
  userIds.push(seeded.user);

  await addAllocation({ roomId: roomA101, status: 'confirmed', start: '2026-10-01', end: '2026-10-03' });
  await addAllocation({ roomId: roomA201, status: 'held', start: '2026-10-01', end: '2026-10-03' });
  await addAllocation({ roomId: roomA202, status: 'released', start: '2026-10-01', end: '2026-10-03' });
});

afterAll(async () => {
  await withTx(async (tx) => {
    // hms_app has no DELETE on booking_nights/folio tables — bookings are the
    // parent (allocations cascade), and this suite never inserts nights.
    if (extraRooms.length > 0) {
      await tx.delete(schema.rooms).where(inArray(schema.rooms.id, extraRooms));
    }
    const bookingRows = await tx.select({ id: schema.bookings.id }).from(schema.bookings).where(eq(schema.bookings.propertyId, propertyId));
    const bookingIds = bookingRows.map((b) => b.id);
    if (bookingIds.length > 0) {
      await tx.delete(schema.bookingGuests).where(inArray(schema.bookingGuests.bookingId, bookingIds));
      await tx.delete(schema.bookings).where(inArray(schema.bookings.id, bookingIds));
    }
    await tx.delete(schema.guests).where(eq(schema.guests.propertyId, propertyId));
    await tx.delete(schema.rooms).where(eq(schema.rooms.propertyId, propertyId));
    await tx.delete(schema.roomTypes).where(eq(schema.roomTypes.propertyId, propertyId));
    // converge the global tax settings back to blueprint defaults
    await tx.insert(schema.settings).values([
      { key: 'vat_rate', value: 16 },
      { key: 'levy_rate', value: 2 },
      { key: 'tax_inclusive_pricing', value: false },
    ]).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });
    await tx.delete(schema.files).where(eq(schema.files.propertyId, propertyId));
    await tx.delete(schema.properties).where(eq(schema.properties.id, propertyId));
    for (const id of userIds) {
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      await tx.delete(schema.accounts).where(eq(schema.accounts.userId, id));
      await tx.delete(schema.users).where(eq(schema.users.id, id));
    }
  });
});

describe('findAvailableRooms', () => {
  it('returns only free rooms for the range', async () => {
    const rooms = await findAvailableRooms({ arrival: '2026-10-01', departure: '2026-10-03' }, ADMIN);
    const numbers = rooms.map((r) => r.roomNumber).sort();
    // 101 confirmed, 201 held, 202 released → free: 104 (STD) + 202 (DLX)
    expect(numbers).toEqual(['104', '202']);
  });

  it('filters by room type and minimum occupancy', async () => {
    const std = await findAvailableRooms({ arrival: '2026-10-01', departure: '2026-10-03', roomTypeId: await stdTypeId() }, ADMIN);
    expect(std.every((r) => r.roomNumber === '104')).toBe(true);

    const three = await findAvailableRooms({ arrival: '2026-10-01', departure: '2026-10-03', occupancy: 3 }, ADMIN);
    expect(three.map((r) => r.roomNumber)).toEqual(['202']);

    const none = await findAvailableRooms({ arrival: '2026-10-01', departure: '2026-10-03', occupancy: 5 }, ADMIN);
    expect(none).toEqual([]);
  });

  it('excludeBookingId re-includes a room blocked by that booking', async () => {
    const confirmedBooking = await withDb((db) =>
      db
        .select({ bookingId: schema.roomAllocations.bookingId })
        .from(schema.roomAllocations)
        .where(
          and(
            eq(schema.roomAllocations.roomId, roomA101),
            eq(schema.roomAllocations.status, 'confirmed'),
            isNotNull(schema.roomAllocations.bookingId),
          ),
        )
        .limit(1),
    );
    const id = confirmedBooking[0]!.bookingId!;
    const without = await findAvailableRooms({ arrival: '2026-10-01', departure: '2026-10-03' }, ADMIN);
    expect(without.some((r) => r.roomNumber === '101')).toBe(false);

    const withExclude = await findAvailableRooms(
      { arrival: '2026-10-01', departure: '2026-10-03', excludeBookingId: id },
      ADMIN,
    );
    expect(withExclude.some((r) => r.roomNumber === '101')).toBe(true);
  });

  it('exposes the base rate and max occupancy on the view', async () => {
    const rooms = await findAvailableRooms({ arrival: '2026-10-01', departure: '2026-10-03' }, ADMIN);
    const std = rooms.find((r) => r.roomNumber === '104')!;
    expect(std.baseRate).toBe(5000);
    expect(std.maxOccupancy).toBe(2);
  });
});

describe('calendar', () => {
  it('summarises per room type per day', async () => {
    const rows = await getCalendar('2026-10-01', '2026-10-04', undefined, ADMIN);
    const stdRows = rows.filter((r) => r.roomTypeName === 'Standard');
    const stdOnDay1 = stdRows.find((r) => r.date === '2026-10-01')!;
    expect(stdOnDay1.total).toBe(2); // 101 + 104 (102 out_of_order, 103 inactive)
    expect(stdOnDay1.sold).toBe(1);
    expect(stdOnDay1.available).toBe(1);

    const stdOnDay3 = stdRows.find((r) => r.date === '2026-10-03')!;
    expect(stdOnDay3.sold).toBe(0);
    expect(stdOnDay3.available).toBe(2);

    const dlxOnDay1 = rows.find((r) => r.roomTypeName === 'Deluxe' && r.date === '2026-10-01')!;
    expect(dlxOnDay1.sold).toBe(1); // 201 held counts, 202 released does not
    expect(dlxOnDay1.available).toBe(1);
  });

  it('restricts to a single room type when asked', async () => {
    const rows = await getCalendar('2026-10-01', '2026-10-04', await stdTypeId(), ADMIN);
    expect(rows.every((r) => r.roomTypeName === 'Standard')).toBe(true);
  });
});

describe('tape', () => {
  it('renders the rooms × dates grid', async () => {
    const rows = await getTape('2026-10-01', '2026-10-04', ADMIN);
    const byNumber = new Map(rows.map((r) => [r.roomNumber, r]));

    const r101 = byNumber.get('101')!;
    expect(r101.days.map((d) => d.status)).toEqual(['confirmed', 'confirmed', 'available']);

    const r201 = byNumber.get('201')!;
    expect(r201.days[0]!.status).toBe('held');

    const r202 = byNumber.get('202')!;
    expect(r202.days.every((d) => d.status === 'available')).toBe(true);

    const r102 = byNumber.get('102')!;
    expect(r102.days[0]!.status).toBe('out_of_order');

    const r104 = byNumber.get('104')!;
    expect(r104.days.every((d) => d.status === 'available')).toBe(true);
  });
});

describe('quoteStay', () => {
  it('prices at base rate with VAT and levy breakdown', async () => {
    const prop = await newProperty(`Quote Hotel ${randomUUID().slice(0, 6)}`);
    const rt = await withTx(async (tx) => {
      const row = await tx
        .insert(schema.roomTypes)
        .values({ propertyId: prop, code: 'SUP', name: 'Superior', baseRate: '5000.00', maxOccupancy: 2 })
        .returning({ id: schema.roomTypes.id })
        .then((rows) => rows[0]!.id);
      return row;
    });

    const quote = await quoteStayForActor(
      { roomTypeId: rt, arrival: '2026-10-01', departure: '2026-10-03', adults: 2, children: 0 },
      actor('admin', prop),
    );
    expect(quote.nights).toHaveLength(2);
    expect(quote.nights[0]).toMatchObject({ rate: 5000, ruleId: null });
    expect(quote.roomSubtotal).toBe('10000.00');
    expect(quote.taxBreakdown).toEqual([{ name: 'VAT', rate: 16, amount: '1600.00' }]);
    expect(quote.total).toBe('11600.00');
    expect(quote.taxInclusive).toBe(false);

    await cleanupQuoteProperty(prop, rt);
  });

  it('applies the best rate rule, then specific-over-global at equal priority', async () => {
    const prop = await newProperty(`Rules Hotel ${randomUUID().slice(0, 6)}`);
    const rt = await withTx(async (tx) => {
      const row = await tx
        .insert(schema.roomTypes)
        .values({ propertyId: prop, code: 'SUP', name: 'Superior', baseRate: '5000.00', maxOccupancy: 2 })
        .returning({ id: schema.roomTypes.id })
        .then((rows) => rows[0]!.id);
      return row;
    });
    const rules = await withTx(async (tx) => {
      const mk = async (name: string, over: Record<string, unknown>) => {
        const row = await tx
          .insert(schema.rateRules)
          .values({
            propertyId: prop,
            roomTypeId: null,
            name,
            validFrom: '2026-09-01',
            validTo: '2026-12-31',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            minNights: 1,
            rate: '4000.00',
            priority: 10,
            ...over,
          })
          .returning({ id: schema.rateRules.id })
          .then((rows) => rows[0]!.id);
        return row;
      };
      const global10 = await mk('Global high', {});
      const specific5 = await mk('Specific low', { roomTypeId: rt, priority: 5, rate: '4500.00' });
      const global3 = await mk('Global low', { priority: 3, rate: '3800.00' });
      return { global10, specific5, global3 };
    });

    const actor2 = actor('admin', prop);
    const base = await quoteStayForActor({ roomTypeId: rt, arrival: '2026-10-01', departure: '2026-10-03', adults: 1, children: 0 }, actor2);
    expect(base.nights[0]!.ruleId).toBe(rules.global10);
    expect(base.nights[0]!.rate).toBe(4000);

    const specific10 = await withTx(async (tx) => {
      const row = await tx
        .insert(schema.rateRules)
        .values({
          propertyId: prop,
          roomTypeId: rt,
          name: 'Specific high',
          validFrom: '2026-09-01',
          validTo: '2026-12-31',
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          minNights: 1,
          rate: '4700.00',
          priority: 10,
        })
        .returning({ id: schema.rateRules.id })
        .then((rows) => rows[0]!.id);
      return row;
    });
    const after = await quoteStayForActor({ roomTypeId: rt, arrival: '2026-10-01', departure: '2026-10-03', adults: 1, children: 0 }, actor2);
    expect(after.nights[0]!.ruleId).toBe(specific10);
    expect(after.nights[0]!.rate).toBe(4700);

    await cleanupQuoteProperty(prop, rt);
  });

  it('honours overrideRate', async () => {
    const prop = await newProperty(`Override Hotel ${randomUUID().slice(0, 6)}`);
    const rt = await withTx(async (tx) => {
      const row = await tx
        .insert(schema.roomTypes)
        .values({ propertyId: prop, code: 'SUP', name: 'Superior', baseRate: '5000.00', maxOccupancy: 2 })
        .returning({ id: schema.roomTypes.id })
        .then((rows) => rows[0]!.id);
      return row;
    });

    const quoted = await withDb((db) =>
      quoteStay(db, {
        propertyId: prop,
        roomTypeId: rt,
        arrival: '2026-10-01',
        departure: '2026-10-03',
        adults: 1,
        children: 0,
        overrideRate: 1000,
      }),
    );
    expect(quoted.nights.every((n) => n.rate === 1000)).toBe(true);
    expect(quoted.roomSubtotal).toBe('2000.00');
    expect(quoted.total).toBe('2320.00');

    await cleanupQuoteProperty(prop, rt);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function stdTypeId(): Promise<string> {
  const rows = await withDb((db) =>
    db.select({ id: schema.roomTypes.id }).from(schema.roomTypes).where(eq(schema.roomTypes.code, 'STD')).limit(1),
  );
  return rows[0]!.id;
}

async function cleanupQuoteProperty(prop: string, rt: string) {
  await withTx(async (tx) => {
    await tx.delete(schema.roomAllocations).where(eq(schema.roomAllocations.propertyId, prop));
    const bookings = await tx.select({ id: schema.bookings.id }).from(schema.bookings).where(eq(schema.bookings.propertyId, prop));
    const ids = bookings.map((b) => b.id);
    if (ids.length > 0) await tx.delete(schema.bookings).where(inArray(schema.bookings.id, ids));
    await tx.delete(schema.rateRules).where(eq(schema.rateRules.propertyId, prop));
    await tx.delete(schema.rooms).where(eq(schema.rooms.propertyId, prop));
    await tx.delete(schema.guests).where(eq(schema.guests.propertyId, prop));
    await tx.delete(schema.roomTypes).where(eq(schema.roomTypes.id, rt));
    await tx.delete(schema.properties).where(eq(schema.properties.id, prop));
  });
}