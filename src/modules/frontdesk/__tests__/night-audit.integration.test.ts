/**
 * Integration test: night audit (§13.3).
 *
 * Fixture — three rooms on a fresh property at `today - 1` (the frozen day D):
 *  - A: checked-in single room at 1000/night → its D stay is posted by the audit
 *  - C: checked-in, due out ON D (stay-over) → flagged for the manager
 *  - B: confirmed arrival on D, never checked in → flipped to no-show + fee
 *
 * ADR/RevPAR/occupancy assertions are derived from the frozen folio lines, not
 * from global tax settings, because settings are shared across suites running
 * in parallel — the exact line amounts are whatever the audit read, and the
 * stat math must be right for THOSE amounts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { jobQueue } from '@/core/db/infra';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { addDays, today, type DateOnly } from '@/core/dates';
import { M } from '@/core/money';
import { checkInBooking, createBooking } from '@/modules/bookings/service';
import { runNightAudit } from '../service';

vi.setConfig({ testTimeout: 60_000 });

function actor(id: string, propertyId: string | null): Actor {
  return {
    id,
    name: 'NA Admin',
    email: `na-admin-${randomUUID().slice(0, 6)}@hms.test`,
    role: 'admin',
    propertyId,
    permissions: resolvePermissions('admin', []),
  };
}

const ACTOR = actor('', null);
const SYSTEM_AUDITOR = { id: null as string | null, name: 'System', role: null as 'admin' | 'manager' | 'receptionist' | null };

let userId = '';
let propertyId = '';
let roomIds: string[] = [];
let targetDate: DateOnly = today();

const a = { id: '', reference: '' };
const b = { id: '', reference: '' };
const c = { id: '', reference: '' };

async function seed() {
  await withTx(async (tx) => {
    userId = randomUUID();
    await tx.insert(schema.users).values({
      id: userId,
      name: 'NA Admin',
      email: `na-admin-${randomUUID().slice(0, 8)}@hms.test`,
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
      .values({ name: `NA Hotel ${randomUUID().slice(0, 6)}` })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);
    propertyId = propId;

    const rt = await tx
      .insert(schema.roomTypes)
      .values({
        propertyId,
        code: 'NA',
        name: 'Night Audit',
        baseRate: '5000.00',
        maxOccupancy: 2,
        maxAdults: 2,
        maxChildren: 0,
      })
      .returning({ id: schema.roomTypes.id })
      .then((rows) => rows[0]!.id);

    const rooms: string[] = [];
    for (const n of ['11', '12', '13']) {
      rooms.push(
        await tx
          .insert(schema.rooms)
          .values({ propertyId, roomTypeId: rt, roomNumber: n })
          .returning({ id: schema.rooms.id })
          .then((rows) => rows[0]!.id),
      );
    }
    roomIds = rooms;
  });
  ACTOR.id = userId;
  ACTOR.propertyId = propertyId;
}

function booking(roomId: string, arrival: DateOnly, departure: DateOnly, rate: number) {
  return {
    guest: { fullName: `Guest ${randomUUID().slice(0, 6)}`, phone: `+2547${randomUUID().slice(0, 8)}`, idType: 'national_id', idNumber: randomUUID() },
    source: 'front_desk' as const,
    rooms: [{ roomId, arrival, departure, adults: 2, children: 0, overrideRate: rate }],
  };
}

beforeAll(async () => {
  await withTx((tx) =>
    tx
      .insert(schema.settings)
      .values([
        { key: 'vat_rate', value: 16 },
        { key: 'levy_rate', value: 2 },
        { key: 'tax_inclusive_pricing', value: false },
        { key: 'deposit_percent', value: 0 },
        { key: 'no_show_fee_nights', value: 1 },
      ])
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: sql`excluded.value`, updatedAt: sql`now()` } }),
  );
  await seed();

  targetDate = addDays(today(), -1);
  const goingHome = addDays(targetDate, -1); // C arrived the day before the freeze

  const createdA = await createBooking(booking(roomIds[0]!, targetDate, addDays(targetDate, 2), 1000), ACTOR);
  a.id = createdA.id;
  a.reference = createdA.reference;
  await checkInBooking(createdA.id, ACTOR);

  const createdC = await createBooking(booking(roomIds[1]!, goingHome, targetDate, 1000), ACTOR);
  c.id = createdC.id;
  c.reference = createdC.reference;
  await checkInBooking(createdC.id, ACTOR);

  const createdB = await createBooking(booking(roomIds[2]!, targetDate, addDays(targetDate, 1), 2000), ACTOR);
  b.id = createdB.id;
  b.reference = createdB.reference;
});

afterAll(async () => {
  await withTx(async (tx) => {
    await tx.delete(schema.bookingGuests).where(eq(schema.bookingGuests.bookingId, a.id));
    await tx.delete(schema.bookingGuests).where(eq(schema.bookingGuests.bookingId, b.id));
    await tx.delete(schema.bookingGuests).where(eq(schema.bookingGuests.bookingId, c.id));
    await tx.delete(schema.bookings).where(eq(schema.bookings.propertyId, propertyId));
  });
});

async function folioLines(bookingId: string) {
  return withDb((db) =>
    db
      .select({
        chargeType: schema.folioCharges.chargeType,
        quantity: schema.folioCharges.quantity,
        unitAmount: schema.folioCharges.unitAmount,
        totalAmount: schema.folioCharges.totalAmount,
      })
      .from(schema.folioCharges)
      .where(and(eq(schema.folioCharges.bookingId, bookingId), eq(schema.folioCharges.isVoided, false))),
  );
}

/** Deterministic expected total for the frozen day: the freeze must equal the ledger. */
async function actualDayRevenue(): Promise<string> {
  return withDb(async (db) => {
    const rows = await db
      .select({
        total: sql<string>`COALESCE(SUM(total_amount), 0)::numeric(14,2)::text`,
      })
      .from(schema.folioCharges)
      .where(and(eq(schema.folioCharges.propertyId, propertyId), eq(schema.folioCharges.chargeDate, targetDate), eq(schema.folioCharges.isVoided, false)));
    return rows[0]!.total;
  });
}

async function bookingHeader(id: string) {
  return withDb((db) =>
    db
      .select({ status: schema.bookings.status, totalCharges: schema.bookings.totalCharges })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, id))
      .limit(1)
      .then((rows) => rows[0]!),
  );
}

async function statsRow() {
  return withDb(async (db) => {
    const rows = await db
      .select({
        propertyId: schema.dailyStats.propertyId,
        businessDate: schema.dailyStats.businessDate,
        roomsTotal: schema.dailyStats.roomsTotal,
        roomsSellable: schema.dailyStats.roomsSellable,
        roomsSold: schema.dailyStats.roomsSold,
        occupancyPct: schema.dailyStats.occupancyPct,
        roomRevenue: schema.dailyStats.roomRevenue,
        otherRevenue: schema.dailyStats.otherRevenue,
        totalRevenue: schema.dailyStats.totalRevenue,
        adr: schema.dailyStats.adr,
        revpar: schema.dailyStats.revpar,
        arrivals: schema.dailyStats.arrivals,
        departures: schema.dailyStats.departures,
        inHouse: schema.dailyStats.inHouse,
        noShows: schema.dailyStats.noShows,
        cancellations: schema.dailyStats.cancellations,
        expensesTotal: schema.dailyStats.expensesTotal,
        paymentsTotal: schema.dailyStats.paymentsTotal,
      })
      .from(schema.dailyStats)
      .where(and(eq(schema.dailyStats.propertyId, propertyId), eq(schema.dailyStats.businessDate, targetDate)))
      .limit(1);
    return rows[0]!;
  });
}

describe('night audit (§13.3)', () => {
  it('freezes yesterday across the board', async () => {
    const results = await runNightAudit(targetDate, SYSTEM_AUDITOR, [propertyId]);
    const r = results.find((x) => x.propertyId === propertyId)!;
    expect(results.length).toBeGreaterThan(0);

    // No-show flip + fee.
    expect(r.noShowsMarked).toBe(1);
    expect(r.noShowReferences).toContain(b.reference);
    const headerB = await bookingHeader(b.id);
    expect(headerB.status).toBe('no_show');
    const linesB = await folioLines(b.id);
    const fee = linesB.find((l) => l.chargeType === 'adjustment');
    expect(fee).toBeDefined();
    expect(fee!.unitAmount).toBe('2000.00');
    expect(fee!.quantity).toBe('1.00');

    // B's rooms are released (no longer reserve availability).
    const released = await withDb((db) =>
      db
        .select({ status: schema.roomAllocations.status })
        .from(schema.roomAllocations)
        .where(eq(schema.roomAllocations.bookingId, b.id)),
    );
    expect(released.every((r) => r.status === 'released')).toBe(true);

    // Nightly posting: A's night on D, not C's earlier-night, not B's no-show night.
    expect(r.nightsPosted).toBe(1);
    const nightStates = await withDb((db) =>
      db
        .select({ id: schema.bookingNights.id, posted: schema.bookingNights.isPosted })
        .from(schema.bookingNights)
        .where(eq(schema.bookingNights.propertyId, propertyId)),
    );
    expect(nightStates.filter((n) => n.posted)).toHaveLength(1);

    // A: in-house night posted and header resynced to the ledger.
    const headerA = await bookingHeader(a.id);
    expect(headerA.status).toBe('checked_in');
    const linesA = await folioLines(a.id);
    const roomA = linesA.find((l) => l.chargeType === 'room');
    expect(roomA!.unitAmount).toBe('1000.00');
    expect(M.cmp(headerA.totalCharges, M.add(...linesA.map((l) => l.totalAmount)))).toBe(0);

    // Stay-over flagged (C due out on D).
    expect(r.stayoversFlagged).toContain(c.reference);

    // Frozen stats mirror the ledger exactly; ADR/RevPAR derive from them.
    const actual = await actualDayRevenue();
    const s = r.stats;
    expect(s.roomsTotal).toBe(3);
    expect(s.roomsSellable).toBe(3);
    expect(s.roomsSold).toBe(1);
    expect(s.arrivals).toBe(2);
    expect(s.departures).toBe(1);
    expect(s.inHouse).toBe(1);
    expect(s.noShows).toBe(1);
    expect(s.cancellations).toBe(0);
    expect(s.roomRevenue).toBe('1000.00'); // room lines only — untouched by tax flips
    expect(s.totalRevenue).toBe(actual);
    expect(M.cmp(s.otherRevenue, M.sub(actual, M.of('1000.00')))).toBe(0);
    expect(s.adr).toBe('1000.00');
    expect(s.revpar).toBe(M.toDecimal(M.of(actual)).dividedBy(3).toFixed(2));
    expect(s.occupancyPct).toBe('33.33');

    // Management notified, summary job outboxed once.
    const notifs = await withDb((db) =>
      db.select({ type: schema.notifications.type }).from(schema.notifications).where(eq(schema.notifications.type, 'night.audit_completed')),
    );
    expect(notifs.length).toBeGreaterThan(0);
    const jobs = await withDb((db) =>
      db.select({ n: sql<number>`count(*)::int` }).from(jobQueue).where(eq(jobQueue.dedupeKey, `nightaudit:summary:${propertyId}:${targetDate}`)),
    );
    expect(jobs[0]!.n).toBe(1);
  });

  it('is idempotent on re-run', async () => {
    const first = (await runNightAudit(targetDate, SYSTEM_AUDITOR, [propertyId])).find((x) => x.propertyId === propertyId)!;
    const second = (await runNightAudit(targetDate, SYSTEM_AUDITOR, [propertyId])).find((x) => x.propertyId === propertyId)!;

    expect(second.noShowsMarked).toBe(0);
    expect(second.nightsPosted).toBe(0);
    expect(second.stayoversFlagged).toHaveLength(1);
    expect(second.totalRevenue).toBe(first.totalRevenue);

    // The frozen day is byte-for-byte the same.
    const frozen1 = await statsRow();
    const frozen2 = await statsRow();
    expect(frozen2).toEqual(frozen1);

    // And no second summary job slipped through the dedupe key.
    const jobs = await withDb((db) =>
      db.select({ n: sql<number>`count(*)::int` }).from(jobQueue).where(eq(jobQueue.dedupeKey, `nightaudit:summary:${propertyId}:${targetDate}`)),
    );
    expect(jobs[0]!.n).toBe(1);
  });

  it('rejects a future target date', async () => {
    await expect(runNightAudit(addDays(today(), 1), SYSTEM_AUDITOR, [propertyId])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('does not post while a booking is still pending arrival', async () => {
    // A booking arriving TODAY is not touched by yesterday's audit.
    const pending = await createBooking(booking(roomIds[2]!, today(), addDays(today(), 1), 1000), ACTOR);
    await runNightAudit(targetDate, SYSTEM_AUDITOR, [propertyId]);
    const header = await bookingHeader(pending.id);
    expect(header.status).toBe('confirmed');
  });
});