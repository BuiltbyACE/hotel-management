/**
 * Integration test: reporting (§18).
 *
 * Fixture: a fresh property with one room and one checked-in booking on
 * yesterday (frozen by the night audit in the same PR's fixture style), plus
 * hand-seeded daily_stats (for multi-day trends), expenses (for MoM), a folio
 * charge today (for revenueToday), and a maintenance issue with a linked cost.
 *
 * Trend reports read ONLY daily_stats (§18.1); "today" probes hit the ledger.
 * Amount assertions are derived from the DB where the night audit's posting is
 * involved (settings are shared across suites), not hand-computed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { addDays, today, type DateOnly } from '@/core/dates';
import { M } from '@/core/money';
import { checkInBooking, createBooking } from '@/modules/bookings/service';
import { runNightAudit } from '@/modules/frontdesk/service';
import {
  arrivalsDeparturesReport,
  dashboard,
  expensesReport,
  maintenanceCostsReport,
  occupancyReport,
  outstandingBalancesReport,
  profitSummaryReport,
  revenueReport,
} from '../service';

vi.setConfig({ testTimeout: 60_000 });

function actor(id: string, propertyId: string | null, role: Actor['role']): Actor {
  return {
    id,
    name: 'REP Admin',
    email: `rep-admin-${randomUUID().slice(0, 6)}@hms.test`,
    role,
    propertyId,
    permissions: resolvePermissions(role, []),
  };
}

const SYSTEM_AUDITOR = { id: null as string | null, name: 'System', role: null as 'admin' | 'manager' | 'receptionist' | null };

let manager: Actor;
let receptionist: Actor;
let propertyId = '';
let roomId = '';
let userId = '';
let bookingId = '';
let bookingReference = '';
let targetDate: DateOnly = today();
const expenseCategoryIds: string[] = [];

async function seed() {
  await withTx(async (tx) => {
    userId = randomUUID();
    await tx.insert(schema.users).values({
      id: userId,
      name: 'REP Admin',
      email: `rep-admin-${randomUUID().slice(0, 8)}@hms.test`,
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
      createdBy: null,
    });
    await tx.insert(schema.accounts).values({ id: randomUUID(), userId, providerId: 'credential', accountId: userId, password: 'x' });

    const propId = await tx
      .insert(schema.properties)
      .values({ name: `REP Hotel ${randomUUID().slice(0, 6)}` })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);
    propertyId = propId;

    const rt = await tx
      .insert(schema.roomTypes)
      .values({ propertyId, code: 'REP', name: 'Reporter', baseRate: '2000.00', maxOccupancy: 2, maxAdults: 2, maxChildren: 0 })
      .returning({ id: schema.roomTypes.id })
      .then((rows) => rows[0]!.id);

    roomId = await tx
      .insert(schema.rooms)
      .values({ propertyId, roomTypeId: rt, roomNumber: '1' })
      .returning({ id: schema.rooms.id })
      .then((rows) => rows[0]!.id);

    const catFood = await tx
      .insert(schema.expenseCategories)
      .values({ propertyId, name: 'Hotel Supplies' })
      .returning({ id: schema.expenseCategories.id })
      .then((rows) => rows[0]!.id);
    const catPower = await tx
      .insert(schema.expenseCategories)
      .values({ propertyId, name: 'Electricity and Utilities' })
      .returning({ id: schema.expenseCategories.id })
      .then((rows) => rows[0]!.id);
    expenseCategoryIds.push(catFood, catPower);

    // Expenses: two inside the report window, one in the PRIOR window (MoM).
    await tx.insert(schema.expenses).values([
      { propertyId, categoryId: catFood, reference: `EXP-REP-1-${randomUUID().slice(0, 4)}`, description: 'Detergent', amount: '1000.00', expenseDate: addDays(targetDate, -1), method: 'cash', status: 'approved', recordedBy: userId },
      { propertyId, categoryId: catFood, reference: `EXP-REP-2-${randomUUID().slice(0, 4)}`, description: 'Tea', amount: '500.00', expenseDate: addDays(targetDate, -1), method: 'cash', status: 'approved', recordedBy: userId },
      { propertyId, categoryId: catPower, reference: `EXP-REP-3-${randomUUID().slice(0, 4)}`, description: 'Power bill', amount: '3000.00', expenseDate: addDays(targetDate, -1), method: 'bank_transfer', status: 'approved', recordedBy: userId },
      { propertyId, categoryId: catFood, reference: `EXP-REP-4-${randomUUID().slice(0, 4)}`, description: 'Earlier supplies', amount: '2000.00', expenseDate: addDays(targetDate, -70), method: 'cash', status: 'approved', recordedBy: userId },
    ]);

    // A resolved maintenance issue with a linked, approved cost (feeds the view).
    const issueId = await tx
      .insert(schema.maintenanceIssues)
      .values({
        propertyId,
        reference: `MT-REP-${randomUUID().slice(0, 4)}`,
        title: 'Aircon repair',
        description: 'Coolant refill',
        roomId,
        priority: 'high',
        status: 'resolved',
        estimatedCost: '4000.00',
        reportedBy: userId,
        reportedAt: new Date(`${addDays(targetDate, -1)}T10:00:00Z`),
      })
      .returning({ id: schema.maintenanceIssues.id })
      .then((rows) => rows[0]!.id);
    await tx.insert(schema.expenses).values({
      propertyId,
      categoryId: catFood,
      maintenanceIssueId: issueId,
      reference: `EXP-REP-5-${randomUUID().slice(0, 4)}`,
      description: 'Coolant',
      amount: '2500.00',
      expenseDate: addDays(targetDate, -1),
      method: 'cash',
      status: 'approved',
      recordedBy: userId,
    });
  });
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
      ])
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: sql`excluded.value`, updatedAt: sql`now()` } }),
  );
  targetDate = addDays(today(), -1);
  await seed();
  manager = actor(userId, propertyId, 'manager');
  receptionist = actor(userId, propertyId, 'receptionist');

  // A checked-in booking arriving yesterday → the audit posts its night and
  // freezes the day. That gives us a real folio line, a >0 balance, and a
  // frozen daily_stats row without hand-rolling any of it.
  const booking = await createBooking(
    {
      guest: { fullName: `Guest ${randomUUID().slice(0, 6)}`, phone: `+2547${randomUUID().slice(0, 8)}`, idType: 'national_id', idNumber: randomUUID() },
      source: 'walk_in',
      rooms: [{ roomId, arrival: targetDate, departure: addDays(targetDate, 2), adults: 2, children: 0 }],
    },
    manager,
  );
  bookingId = booking.id;
  bookingReference = booking.reference;
  await checkInBooking(booking.id, manager);

  await runNightAudit(targetDate, SYSTEM_AUDITOR, [propertyId]);

  // Extra frozen days for trends + today's folio revenue probe.
  await withDb((db) =>
    db.insert(schema.dailyStats).values([
      { propertyId, businessDate: addDays(targetDate, -2), roomsTotal: 5, roomsSellable: 4, roomsSold: 2, occupancyPct: '50.00', roomRevenue: '3000.00', otherRevenue: '200.00', totalRevenue: '3200.00', adr: '1500.00', revpar: '800.00', arrivals: 1, departures: 1, inHouse: 2, noShows: 0, cancellations: 0, expensesTotal: '100.00', paymentsTotal: '1500.00' },
      { propertyId, businessDate: addDays(targetDate, -1), roomsTotal: 5, roomsSellable: 4, roomsSold: 3, occupancyPct: '75.00', roomRevenue: '4500.00', otherRevenue: '300.00', totalRevenue: '4800.00', adr: '1500.00', revpar: '1200.00', arrivals: 2, departures: 0, inHouse: 3, noShows: 0, cancellations: 1, expensesTotal: '200.00', paymentsTotal: '2000.00' },
    ]),
  );
  await withDb((db) =>
    db.insert(schema.folioCharges).values({
      propertyId,
      bookingId,
      chargeType: 'extra',
      description: 'Spa',
      quantity: '1',
      unitAmount: '600.00',
      totalAmount: '600.00',
      chargeDate: today(),
      isVoided: false,
    }),
  );
});

afterAll(async () => {
  await withTx(async (tx) => {
    await tx.delete(schema.bookingGuests).where(eq(schema.bookingGuests.bookingId, bookingId));
    await tx.delete(schema.bookings).where(eq(schema.bookings.propertyId, propertyId));
  });
});

describe('reporting (§18)', () => {
  it('occupancy trends read daily_stats into day buckets with correct totals', async () => {
    const r = await occupancyReport({ from: addDays(targetDate, -2), to: addDays(targetDate, -1), groupBy: 'day' }, manager);

    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.periodStart).toBe(addDays(targetDate, -2));
    expect(r.rows[1]!.periodStart).toBe(addDays(targetDate, -1));
    expect(r.rows[0]!.roomsSold).toBe(2);
    expect(r.rows[0]!.adr).toBe('1500.00');
    expect(r.rows[1]!.occupancyPct).toBe('75.00');

    expect(r.totals.roomsSold).toBe(5);
    expect(r.totals.roomsSellable).toBe(8);
    expect(r.totals.roomRevenue).toBe('7500.00');
    expect(r.totals.totalRevenue).toBe('8000.00');
    expect(r.totals.occupancyPct).toBe('62.50'); // 5/8
    expect(r.totals.adr).toBe('1500.00');
  });

  it('occupancy groups weeks to their Monday', async () => {
    // targetDate-1 and targetDate-2 can fall in the same or different weeks;
    // the key must be the Monday start either way.
    const r = await occupancyReport({ from: addDays(targetDate, -2), to: addDays(targetDate, -1), groupBy: 'week' }, manager);
    const mondayKey = (d: string) => {
      const dt = new Date(`${d}T00:00:00`);
      dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
      // Local formatting — toISOString() would shift the day in +UTC zones.
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    };
    const expected = new Set([mondayKey(addDays(targetDate, -2)), mondayKey(addDays(targetDate, -1))]);
    for (const row of r.rows) expect(expected.has(row.periodStart)).toBe(true);
    expect(r.rows.reduce((n, row) => n + row.roomsSold, 0)).toBe(5);
  });

  it('revenue by day matches daily_stats and breakdowns cover the folio', async () => {
    const byDay = await revenueReport({ from: addDays(targetDate, -2), to: addDays(targetDate, -1) }, manager);
    expect(byDay.breakdown).toBe('day');
    expect(byDay.totals.totalRevenue).toBe('8000.00');

    const byRoom = await revenueReport({ from: addDays(targetDate, -2), to: targetDate, breakdown: 'roomType' }, manager);
    expect(byRoom.breakdown).toBe('roomType');
    const roomTotal = byRoom.rows.find((r) => r.key === 'Reporter');
    expect(roomTotal).toBeDefined();
    // The frozen audit night posted room revenue for the booked room.
    expect(M.toDecimal(roomTotal!.total).gte(M.of('0'))).toBe(true);

    const bySource = await revenueReport({ from: addDays(targetDate, -2), to: targetDate, breakdown: 'source' }, manager);
    const walkIn = bySource.rows.find((r) => r.key === 'walk_in');
    expect(walkIn).toBeDefined();
    expect(M.toDecimal(walkIn!.total).gt(M.of('0'))).toBe(true);
  });

  it('arrivals-departures lists the in-house booking', async () => {
    const r = await arrivalsDeparturesReport(targetDate as DateOnly, receptionist);
    expect(r.arrivals.map((a) => a.reference)).toContain(bookingReference);
    // The booking is checked in and due out later → not on departures yet.
    expect(r.departures.map((d) => d.reference)).not.toContain(bookingReference);
    expect(r.arrivals[0]!.roomNumber).toBe('1');
  });

  it('outstanding balances age the booking and bucket it', async () => {
    const r = await outstandingBalancesReport(manager);
    const row = r.rows.find((x) => x.reference === bookingReference);
    expect(row).toBeDefined();
    expect(M.toDecimal(row!.balance).gt(M.of('0'))).toBe(true);
    expect(r.count).toBe(1);
    const ages = r.buckets.reduce((n, b) => n + b.count, 0);
    expect(ages).toBe(r.count);
  });

  it('expenses report aggregates categories with MoM change', async () => {
    // Window [-45, -1]: detergent 1000 + tea 500 + coolant 2500 + power 3000.
    // The prior equal window [-90, -46] holds the 2000 "Earlier supplies".
    const r = await expensesReport({ from: addDays(targetDate, -45), to: addDays(targetDate, -1), groupBy: 'category' }, manager);
    const supplies = r.rows.find((x) => x.label === 'Hotel Supplies');
    expect(supplies).toBeDefined();
    expect(M.cmp(supplies!.total, M.add('1000.00', '500.00', '2500.00'))).toBe(0);
    expect(supplies!.momChange).toBe('100.0'); // (4000 - 2000) / 2000
    const power = r.rows.find((x) => x.label === 'Electricity and Utilities');
    expect(power).toBeDefined();
    expect(M.cmp(power!.total, M.of('3000.00'))).toBe(0);
    expect(power!.momChange).toBeNull(); // nothing in the prior window
    expect(r.total).toBe('7000.00');
    expect(r.count).toBe(4);
  });

  it('maintenance-costs reconciles estimated vs actual', async () => {
    const r = await maintenanceCostsReport({ from: addDays(targetDate, -10), to: addDays(targetDate, -1) }, manager);
    expect(r.rows.length).toBeGreaterThan(0);
    const row = r.rows.find((x) => x.title === 'Aircon repair');
    expect(row).toBeDefined();
    expect(row!.estimatedCost).toBe('4000.00');
    expect(M.cmp(row!.actualCost, M.of('2500.00'))).toBe(0);
    expect(M.cmp(row!.variance, M.sub('2500.00', '4000.00'))).toBe(0);
    expect(row!.roomNumber).toBe('1');
    expect(M.cmp(r.estimatedTotal, M.of('4000.00'))).toBe(0);
    expect(M.cmp(r.actualTotal, M.of('2500.00'))).toBe(0);
  });

  it('profit-summary derives revenue − expenses from daily_stats', async () => {
    const r = await profitSummaryReport({ from: addDays(targetDate, -2), to: addDays(targetDate, -1) }, manager);
    expect(r.revenue).toBe('8000.00');
    expect(r.expenses).toBe('300.00');
    expect(r.profit).toBe('7700.00');
    expect(r.marginPct).toBe('96.25'); // 7700 / 8000
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('dashboard is role-shaped: no financial KPIs for receptionists', async () => {
    const rep = await dashboard(receptionist);
    expect(rep.role).toBe('receptionist');
    expect(rep.financial).toBeUndefined();
    expect(rep.admin).toBeUndefined();
    expect(rep.today.inHouse).toBe(1);
    expect(rep.today.roomsTotal).toBe(1);
    expect(rep.sparkline).toBeInstanceOf(Array);

    const mgr = await dashboard(manager);
    expect(mgr.role).toBe('manager');
    expect(mgr.financial).toBeDefined();
    expect(M.cmp(mgr.financial!.revenueToday, M.of('600.00'))).toBe(0); // the Spa charge
    expect(mgr.financial!.outstandingBalance).toBeTruthy();
    expect(mgr.admin).toBeUndefined();
    expect(mgr.sparkline.length).toBeGreaterThan(0);
  });

  it('rejects an inverted date range', async () => {
    await expect(occupancyReport({ from: addDays(today(), 1), to: addDays(today(), -1) }, manager)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});