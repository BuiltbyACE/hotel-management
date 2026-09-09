/**
 * Integration test: folio charges (post/void), invoices with frozen snapshots
 * and gap-free INV- numbering, voided invoices, receipts — against Postgres.
 * Blueprint §12.2, §12.5, §16.3 finance endpoints.
 *
 * Money here is append-only for hms_app (§8.3): folio_charges, invoices,
 * invoice_lines and payments can never be deleted, so every booking that gets
 * a charge leaves residue (as do its guests/rooms/room_types and the acting
 * user — hard FKs). Cleanup therefore converges the global settings and frees
 * the number sequences; financial rows, bookings, catalogs and the test user
 * stay as documented residue. Unique UUIDs keep runs isolated.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { AppError } from '@/core/api/errors';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { addDays, today, type DateOnly } from '@/core/dates';
import { M } from '@/core/money';
import { createBooking, cancelBooking, recordPayment } from '@/modules/bookings/service';
import {
  getFolioView,
  getInvoice,
  getInvoiceDocument,
  getPaymentReceipt,
  issueInvoice,
  listInvoiceViews,
  postCharge,
  voidCharge,
  voidInvoice,
} from '@/modules/billing/service';
import { readTaxSettings } from '@/modules/billing/repository';

type BookingInput = Parameters<typeof createBooking>[0];

vi.setConfig({ testTimeout: 60_000 });

function actor(id: string, propertyId: string, role: Actor['role'] = 'admin'): Actor {
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

// Residue bookings never release their rooms, so each new booking shifts its
// stay forward to keep the availability window free.
let dayOffset = 0;

function stay(roomId: string, nights = 2): { arrival: DateOnly; departure: DateOnly } {
  const arrival = addDays(today(), dayOffset);
  dayOffset += 7;
  return { arrival, departure: addDays(arrival, nights) };
}

function booking(roomId: string): BookingInput {
  const d = stay(roomId);
  return {
    guest: {
      fullName: `Bill Guest ${randomUUID().slice(0, 6)}`,
      phone: `+2547${randomUUID().slice(0, 8)}`,
      idType: 'national_id',
      idNumber: randomUUID(),
    },
    source: 'front_desk',
    rooms: [{ roomId, arrival: d.arrival, departure: d.departure, adults: 2, children: 0 }],
  };
}

const BILL: Actor = actor('', '');
let billRooms: Record<string, string> = {};
let billProperty = '';
let actorId = '';

function assertMoney(actual: string | null, expected: string): void {
  expect(M.of(actual ?? '0')).toBe(M.of(expected));
}

beforeAll(async () => {
  actorId = randomUUID();
  await withTx(async (tx) => {
    await tx.insert(schema.users).values({
      id: actorId,
      name: 'Billing Admin',
      email: `billing-admin-${randomUUID().slice(0, 8)}@hms.test`,
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
      createdBy: null,
    });
    await tx.insert(schema.accounts).values({
      id: randomUUID(),
      userId: actorId,
      providerId: 'credential',
      accountId: actorId,
      password: 'not-used-in-tests',
    });

    const prop = await tx
      .insert(schema.properties)
      .values({ name: `Billing Hotel ${randomUUID().slice(0, 6)}`, taxPin: 'P051234567K' })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);

    const rt = await tx
      .insert(schema.roomTypes)
      .values({
        propertyId: prop,
        code: 'STD',
        name: 'Deluxe',
        baseRate: '5000.00',
        maxOccupancy: 2,
        maxAdults: 2,
        maxChildren: 1,
        extraBedRate: '1500.00',
      })
      .returning({ id: schema.roomTypes.id })
      .then((rows) => rows[0]!.id);

    const rooms: Record<string, string> = {};
    for (const n of ['401', '402']) {
      rooms[`r${n}`] = await tx
        .insert(schema.rooms)
        .values({ propertyId: prop, roomTypeId: rt, roomNumber: n })
        .returning({ id: schema.rooms.id })
        .then((rows) => rows[0]!.id);
    }

    await tx.insert(schema.settings).values([
      { key: 'vat_rate', value: 16 },
      { key: 'levy_rate', value: 0 },
      { key: 'tax_inclusive_pricing', value: false },
      { key: 'deposit_percent', value: 0 },
    ]).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });

    BILL.id = actorId;
    BILL.propertyId = prop;
    billProperty = prop;
    billRooms = rooms;
  });
});

// The tax settings are a single global table shared by every suite that runs
// in parallel; other files' afterAll can flip levy_rate mid-run, so re-assert
// the values every test expects just before it runs.
beforeEach(async () => {
  await withTx((tx) =>
    tx.insert(schema.settings).values([
      { key: 'vat_rate', value: 16 },
      { key: 'levy_rate', value: 0 },
      { key: 'tax_inclusive_pricing', value: false },
      { key: 'deposit_percent', value: 0 },
    ]).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    }),
  );
});

afterAll(async () => {
  await withTx(async (tx) => {
    // Guests/rooms/room_types/user are hard-FK residue from the charged
    // bookings (bookings.created_by / posted.by / recorded.by all point at the
    // user) — only sequences and settings are free to restore.
    await tx.delete(schema.numberSequences).where(eq(schema.numberSequences.propertyId, billProperty));
    await tx.insert(schema.settings).values([
      { key: 'vat_rate', value: 16 },
      { key: 'levy_rate', value: 2 },
      { key: 'tax_inclusive_pricing', value: false },
      { key: 'deposit_percent', value: 0 },
    ]).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });
  });
});

async function makeBooking(): Promise<string> {
  const created = await createBooking(booking(billRooms.r401!), BILL);
  return created.id;
}

describe('folio', () => {
  it('shows an empty folio for a fresh booking', async () => {
    const bid = await makeBooking();
    const folio = await getFolioView(bid, BILL);
    expect(folio.charges).toHaveLength(0);
    expect(folio.payments).toHaveLength(0);
    expect(folio.grandTotal).toBe('0');
    expect(folio.booking.reference).toMatch(/^BK-/);
  });

  it('posts a taxed extra charge and updates the header cache', async () => {
    const bid = await makeBooking();
    const before = (await getFolioView(bid, BILL)).booking.totalCharges;

    const charge = await postCharge(
      bid,
      { chargeType: 'extra', description: 'Airport transfer', quantity: 2, unitAmount: '500.00' },
      BILL,
    );
    expect(charge.totalAmount).toBe('1160.00');
    expect(charge.taxAmount).toBe('160.00');
    expect(M.of(charge.taxRate)).toBe(M.of(16));
    const after = (await getFolioView(bid, BILL));
    assertMoney(after.booking.totalCharges, M.add(before, '1160.00'));
    assertMoney(after.grandTotal, '1160.00');
    assertMoney(after.taxTotal, '160.00');
  });

  it('posting a discount requires folio.discount', async () => {
    const bid = await makeBooking();
    const receptionist = actor(randomUUID(), billProperty, 'receptionist');

    await expect(
      postCharge(bid, { chargeType: 'discount', description: 'Comeback rebate', quantity: 1, unitAmount: '-100.00' }, receptionist),
    ).rejects.toSatisfy(code('FORBIDDEN'));

    const charge = await postCharge(
      bid,
      { chargeType: 'discount', description: 'Comeback rebate', quantity: 1, unitAmount: '-100.00' },
      BILL,
    );
    expect(charge.totalAmount).toBe('-100.00');
    const folio = await getFolioView(bid, BILL);
    expect(M.of(folio.discountTotal)).toBe(M.of('100.00'));
  });

  it('voiding a charge never deletes it and recomputes the cache', async () => {
    const bid = await makeBooking();
    const charge = await postCharge(
      bid,
      { chargeType: 'service', description: 'Laundry', quantity: 1, unitAmount: '600.00' },
      BILL,
    );
    expect(charge.totalAmount).toBe('696.00');
    const before = (await getFolioView(bid, BILL)).booking.totalCharges;

    const voided = await voidCharge(bid, charge.id, 'Posted in error', BILL);
    expect(voided.isVoided).toBe(true);
    expect(voided.voidedReason).toBe('Posted in error');

    const folio = await getFolioView(bid, BILL);
    assertMoney(folio.booking.totalCharges, M.sub(before, '696.00'));
    expect(folio.charges.find((c) => c.id === charge.id)!.isVoided).toBe(true);
    expect(folio.grandTotal).toBe('0');

    await expect(voidCharge(bid, charge.id, 'Twice', BILL)).rejects.toSatisfy(code('INVALID_TRANSITION'));
  });

  it('rejects charges on a cancelled booking', async () => {
    const bid = await makeBooking();
    await cancelBooking(bid, { reason: 'Guest changed plans' }, BILL);
    await expect(
      postCharge(bid, { chargeType: 'extra', description: 'Late fee', quantity: 1, unitAmount: '100.00' }, BILL),
    ).rejects.toSatisfy(code('INVALID_TRANSITION'));
  });
});

describe('invoices', () => {
  it('issues an invoice that freezes a snapshot, posts nights and numbers gap-free', async () => {
    const bid = await makeBooking();
    await postCharge(bid, { chargeType: 'discount', description: 'Corporate discount', quantity: 1, unitAmount: '-500.00' }, BILL);

    // Mirror the service's own math from the settings it reads at issue time,
    // so a parallel suite flipping the shared tax table can't flake this.
    const tax = await withDb((db) => readTaxSettings(db));
    const nightsSubtotal = M.mul(M.of('5000.00'), 2);
    const vat = M.pct(nightsSubtotal, tax.vatRate);
    const levy = tax.levyRate > 0 ? M.pct(nightsSubtotal, tax.levyRate) : '0';
    const grandTotal = M.add(nightsSubtotal, vat, levy, '-500.00');
    const subtotal = M.add(nightsSubtotal, levy, '-500.00');
    const taxTotal = M.add(vat, levy);
    const lineCount = 4 + (tax.levyRate > 0 ? 1 : 0);

    const invoice = await issueInvoice(bid, BILL);

    expect(invoice.status).toBe('issued');
    expect(invoice.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(M.of(invoice.grandTotal)).toBe(M.of(grandTotal));
    expect(M.of(invoice.subtotal)).toBe(M.of(subtotal));
    expect(M.of(invoice.taxTotal)).toBe(M.of(taxTotal));
    expect(M.of(invoice.discountTotal)).toBe(M.of('500.00'));
    expect(invoice.billToName).toBeTruthy();
    expect(invoice.lines).toHaveLength(lineCount);
    expect(invoice.lines.some((l) => l.description.startsWith('Deluxe · 401'))).toBe(true);

    // nights are now posted to the folio only once
    const folio = await getFolioView(bid, BILL);
    assertMoney(folio.booking.totalCharges, invoice.grandTotal);
    assertMoney(folio.booking.balance, M.sub(invoice.grandTotal, invoice.amountPaid));
    const posted = await withDb((db) =>
      db.select({ n: sql<number>`count(*)::int` }).from(schema.bookingNights)
        .where(and(eq(schema.bookingNights.bookingId, bid), eq(schema.bookingNights.isPosted, true))),
    );
    expect(posted[0]?.n).toBe(2);

    const again = await issueInvoice(bid, BILL);
    expect(again.invoiceNumber).not.toBe(invoice.invoiceNumber);
    expect(M.of(again.grandTotal)).toBe(M.of(grandTotal));
  });

  it('lists invoices with status filters', async () => {
    const bid = await makeBooking();
    await issueInvoice(bid, BILL);
    const list = await listInvoiceViews({ limit: 25, offset: 0 }, BILL);
    expect(list.total).toBeGreaterThanOrEqual(1);
    const issued = await listInvoiceViews({ limit: 25, offset: 0, status: 'issued' }, BILL);
    expect(issued.data.every((i) => i.status === 'issued')).toBe(true);
    const paid = await listInvoiceViews({ limit: 25, offset: 0, status: 'paid' }, BILL);
    expect(paid.data.every((i) => i.status === 'paid')).toBe(true);
  });

  it('reflects payments in invoice status (issued → partially_paid → paid)', async () => {
    const bid = await makeBooking();
    const partial = await issueInvoice(bid, BILL);
    expect(partial.status).toBe('issued');

    const pay1 = await recordPayment(bid, { amount: '1000.00', method: 'cash', reference: `MP-${randomUUID().slice(0, 8)}` }, BILL);
    const afterPay = await getInvoice(partial.id, BILL);
    expect(afterPay.status).toBe('partially_paid');
    assertMoney(afterPay.amountPaid, '1000.00');
    assertMoney(afterPay.balance, M.sub(partial.grandTotal, '1000.00'));

    const more = await recordPayment(bid, { amount: partial.grandTotal, method: 'mpesa', reference: `MP-${randomUUID().slice(0, 8)}` }, BILL);
    const settled = await getInvoice(partial.id, BILL);
    expect(settled.status).toBe('paid');
    assertMoney(settled.amountPaid, M.add(pay1.amount, more.amount));

    const receipt = await getPaymentReceipt(pay1.id, BILL);
    expect(receipt).toContain(pay1.receiptNumber);
    expect(receipt).toContain('KES 1,000.00');
  });

  it('voiding an invoice keeps the row forever', async () => {
    const bid = await makeBooking();
    const invoice = await issueInvoice(bid, BILL);

    const voided = await voidInvoice(invoice.id, 'Duplicate invoice', BILL);
    expect(voided.status).toBe('void');
    expect(voided.voidReason).toBe('Duplicate invoice');

    await expect(voidInvoice(invoice.id, 'Again', BILL)).rejects.toSatisfy(code('INVALID_TRANSITION'));
    const list = await listInvoiceViews({ limit: 25, offset: 0, status: 'void' }, BILL);
    expect(list.data.some((i) => i.id === invoice.id)).toBe(true);
  });

  it('scopes invoice reads to the actor property', async () => {
    const bid = await makeBooking();
    const invoice = await issueInvoice(bid, BILL);
    const stranger = actor(randomUUID(), randomUUID());
    await expect(getInvoice(invoice.id, stranger)).rejects.toSatisfy(code('NOT_FOUND'));
  });

  it('renders an inline invoice document', async () => {
    const bid = await makeBooking();
    const invoice = await issueInvoice(bid, BILL);
    const html = await getInvoiceDocument(invoice.id, BILL);
    expect(html).toContain('INVOICE');
    expect(html).toContain(invoice.invoiceNumber);
    expect(html).toContain('Grand total');
    expect(html).toContain('P051234567K');
  });
});