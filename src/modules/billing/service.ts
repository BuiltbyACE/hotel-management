/**
 * modules/billing/service.ts
 *
 * Money (blueprint §12): the folio, charges (append-only, voided — never
 * deleted), invoices with frozen snapshots, and payment receipts.
 *
 * Design notes:
 * - Room nights hit the folio when an invoice is issued (auto-post of every
 *   unposted `booking_nights` row, plus one VAT/levy line). The unique
 *   `folio_room_night_uq` index makes double-posting impossible. Until then,
 *   the quoted total lives on the header only, so manual charges are applied
 *   as deltas — after issue, `total_charges` is re-synced to SUM(folio),
 *   exactly as §12.1 rule 5 demands.
 * - Issuing freezes a snapshot: bill-to, per-line tax and totals. Voiding an
 *   invoice keeps the row forever. Money is always a string (core/money).
 * - Invoices are numbered gap-free from `number_sequences` as INV-<year>-NNNNNN.
 */
import { and, eq } from 'drizzle-orm';
import { schema, withDb, withTx, type Db, type Tx } from '@/core/db';
import { AppError } from '@/core/api';
import { nextNumber } from '@/core/db/sequence';
import { M } from '@/core/money';
import { today } from '@/core/dates';
import { eventBus } from '@/core/events';
import { type Actor } from '@/modules/identity/auth-guard';
import { auditActor, recordAudit } from '@/modules/audit/service';
import {
  applyTotalChargesDelta,
  countInvoices,
  findBookingForFinance,
  findFinanceGuest,
  findFinanceProperty,
  findFolioCharge,
  findInvoiceById,
  findPayment,
  folioChargesForBooking,
  insertFolioCharge,
  insertInvoice,
  insertInvoiceLine,
  invoiceLinesForInvoice,
  invoicesForBooking,
  listInvoices,
  liveFolioCharges,
  lockBookingForFinance,
  markNightsPosted,
  paymentsForBooking,
  postableNightsForDate,
  readTaxSettings,
  roomLabels,
  sumCompletedPayments,
  syncTotalChargesToLedger,
  unpostedNights,
  updateInvoicePayments,
  voidFolioCharge as voidFolioChargeRow,
  voidInvoice as voidInvoiceRow,
  type ChargeType,
  type FolioChargeRecord,
  type InvoiceRecord,
  type InvoiceStatusValue,
  type TaxSettingsRecord,
} from './repository';
import { BILLING_EVENTS } from './events';
import type {
  FolioChargeView,
  FolioPaymentView,
  FolioView,
  InvoiceLineView,
  InvoiceView,
  PostChargeInput,
} from './types';

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return new Date(v as string | Date).toISOString();
}

async function scopeProperty(actor: Actor): Promise<string> {
  const propertyId = await withDb((db) => resolveActiveProperty(db, actor.propertyId));
  if (!propertyId) throw AppError.notFound('No active property is configured');
  return propertyId;
}

/** The actor's property, or the single active property when unbound. */
async function resolveActiveProperty(db: Db | Tx, preferred: string | null): Promise<string | null> {
  if (preferred) {
    const rows = await db
      .select({ id: schema.properties.id })
      .from(schema.properties)
      .where(and(eq(schema.properties.id, preferred), eq(schema.properties.isActive, true)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db.select({ id: schema.properties.id }).from(schema.properties).where(eq(schema.properties.isActive, true)).limit(1);
  return rows[0]?.id ?? null;
}

function toFolioChargeView(c: FolioChargeRecord): FolioChargeView {
  return {
    id: c.id,
    bookingId: c.bookingId,
    chargeType: c.chargeType,
    description: c.description,
    quantity: c.quantity,
    unitAmount: c.unitAmount,
    taxRate: c.taxRate,
    taxAmount: c.taxAmount,
    totalAmount: c.totalAmount,
    chargeDate: c.chargeDate,
    isVoided: c.isVoided,
    voidedBy: c.voidedBy,
    voidedReason: c.voidedReason,
  };
}

function toFolioPaymentView(p: { id: string; receiptNumber: string; paymentType: string; amount: string; method: string; status: string; reference: string | null; paidAt: Date; reversalOf: string | null }): FolioPaymentView {
  return {
    id: p.id,
    receiptNumber: p.receiptNumber,
    paymentType: p.paymentType,
    amount: p.amount,
    method: p.method,
    status: p.status,
    reference: p.reference,
    paidAt: iso(p.paidAt)!,
    reversalOf: p.reversalOf,
  };
}

function toInvoiceLineView(l: { id: string; description: string; quantity: string; unitAmount: string; taxRate: string; taxAmount: string; totalAmount: string }): InvoiceLineView {
  return {
    id: l.id,
    description: l.description,
    quantity: l.quantity,
    unitAmount: l.unitAmount,
    taxRate: l.taxRate,
    taxAmount: l.taxAmount,
    totalAmount: l.totalAmount,
  };
}

function toInvoiceView(i: Omit<InvoiceRecord, 'pdfFileId'>, lines: InvoiceLineView[]): InvoiceView {
  return {
    id: i.id,
    propertyId: i.propertyId,
    bookingId: i.bookingId,
    invoiceNumber: i.invoiceNumber,
    status: i.status,
    issuedAt: iso(i.issuedAt),
    dueDate: i.dueDate,
    billToName: i.billToName,
    billToAddress: i.billToAddress,
    billToTaxPin: i.billToTaxPin,
    subtotal: i.subtotal,
    taxTotal: i.taxTotal,
    discountTotal: i.discountTotal,
    grandTotal: i.grandTotal,
    amountPaid: i.amountPaid,
    balance: M.sub(i.grandTotal, i.amountPaid),
    currency: i.currency,
    voidReason: i.voidReason,
    issuedBy: i.issuedBy,
    createdAt: iso(i.createdAt)!,
    lines,
  };
}

/** Ledger totals computed from live (non-voided) folio lines, rounded once. */
function ledgerTotals(live: FolioChargeRecord[]): { subtotal: string; taxTotal: string; discountTotal: string; grandTotal: string } {
  const grandTotal = M.add(...live.map((l) => l.totalAmount));
  const taxTotal = M.add(...live.map((l) => l.taxAmount));
  const subtotal = M.add(...live.map((l) => M.sub(l.totalAmount, l.taxAmount)));
  const discountSum = M.add(...live.filter((l) => l.chargeType === 'discount').map((l) => l.totalAmount));
  const discountTotal = M.sub('0', discountSum);
  return { subtotal, taxTotal, discountTotal, grandTotal };
}

/** Tax snapshot for a manually posted charge (§12.2 "snapshotted from settings"). */
function taxRateFor(tax: TaxSettingsRecord, chargeType: ChargeType): number {
  switch (chargeType) {
    case 'levy':
      return tax.levyRate;
    case 'extra':
    case 'service':
    case 'adjustment':
      return tax.vatRate;
    default:
      return 0; // room, tax, discount: no auto tax
  }
}

// ─── Folio ───────────────────────────────────────────────────────────────────

export async function getFolioView(bookingId: string, actor: Actor): Promise<FolioView> {
  const propertyId = await scopeProperty(actor);
  const booking = await withDb((db) => findBookingForFinance(db, bookingId));
  if (!booking || booking.propertyId !== propertyId) throw AppError.notFound('Booking not found');

  const [property, charges, payments] = await withTx((tx) =>
    Promise.all([
      findFinanceProperty(tx, propertyId),
      folioChargesForBooking(tx, bookingId),
      paymentsForBooking(tx, bookingId),
    ]),
  );

  const live = charges.filter((c) => !c.isVoided);
  const totals = ledgerTotals(live);
  return {
    booking: {
      id: booking.id,
      reference: booking.reference,
      status: booking.status,
      guestName: booking.guestNameSnapshot,
      totalCharges: booking.totalCharges,
      totalPaid: booking.totalPaid,
      balance: booking.balance ?? M.sub(booking.totalCharges, booking.totalPaid),
    },
    charges: charges.map(toFolioChargeView),
    payments: payments.map(toFolioPaymentView),
    ...totals,
    currency: property?.currency ?? 'KES',
  };
}

/** POST a charge (receptionist posting bar/laundry/transfer; §12.2). */
export async function postCharge(bookingId: string, input: PostChargeInput, actor: Actor): Promise<FolioChargeView> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const booking = await lockBookingForFinance(tx, propertyId, bookingId);
    if (!booking) throw AppError.notFound('Booking not found');
    if (booking.status === 'cancelled' || booking.status === 'draft') {
      throw AppError.conflict('INVALID_TRANSITION', `Charges cannot be posted to a ${booking.status} booking`);
    }
    if (input.chargeType === 'discount' && !actor.permissions.has('folio.discount')) {
      throw AppError.forbidden('FORBIDDEN', 'Posting discounts requires folio.discount');
    }

    const tax = await readTaxSettings(tx);
    const taxRate = taxRateFor(tax, input.chargeType);
    const lineTotal = M.mul(M.of(input.unitAmount), input.quantity);
    const taxAmount = M.pct(lineTotal, taxRate);
    const totalAmount = M.add(lineTotal, taxAmount);

    const charge = await insertFolioCharge(tx, {
      propertyId,
      bookingId,
      chargeType: input.chargeType,
      description: input.description,
      quantity: input.quantity,
      unitAmount: input.unitAmount,
      taxRate,
      taxAmount,
      totalAmount,
      chargeDate: today(),
      postedBy: actor.id,
    });
    await applyTotalChargesDelta(tx, bookingId, totalAmount);
    await eventBus.emit(BILLING_EVENTS.folioChargePosted, {
      bookingId,
      chargeId: charge.id,
      amount: totalAmount,
      by: actor.email,
    });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'folio.post_charge',
      entityType: 'folio_charge',
      entityId: charge.id,
      summary: `${charge.description} ${charge.quantity}×${charge.unitAmount} (${totalAmount}) posted`,
    });
    return toFolioChargeView(charge);
  });
}

/** Void a charge line — charges are never deleted, only voided (§12.2). */
export async function voidCharge(bookingId: string, chargeId: string, reason: string, actor: Actor): Promise<FolioChargeView> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const booking = await lockBookingForFinance(tx, propertyId, bookingId);
    if (!booking) throw AppError.notFound('Booking not found');

    const charge = await findFolioCharge(tx, chargeId);
    if (!charge || charge.bookingId !== bookingId || charge.propertyId !== propertyId) {
      throw AppError.notFound('Charge not found');
    }
    if (charge.isVoided) {
      throw AppError.conflict('INVALID_TRANSITION', 'Charge is already voided');
    }

    const updated = await voidFolioChargeRow(tx, chargeId, actor.id, reason);
    await applyTotalChargesDelta(tx, bookingId, M.sub('0', charge.totalAmount));
    await eventBus.emit(BILLING_EVENTS.folioChargeVoided, {
      bookingId,
      chargeId,
      amount: charge.totalAmount,
      reason,
      by: actor.email,
    });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'folio.void_charge',
      entityType: 'folio_charge',
      entityId: chargeId,
      summary: `${charge.description} (${charge.totalAmount}) voided: ${reason}`,
    });
    return toFolioChargeView(updated);
  });
}

// ─── Night audit posting (§13.3) ─────────────────────────────────────────────
// The nightly sweep posts each unposted in-house stay date to the folio (room +
// VAT/levy lines) and books no-show fees. Both reuse the same per-line posting
// so the totals match what invoice issue would have produced (linear, §12.1).

interface RoomChargeLinesOptions {
  propertyId: string;
  bookingId: string;
  chargeType: 'room' | 'adjustment';
  chargeDate: string;
  description: string;
  quantity: number;
  unitAmount: string;
  sourceNightId?: string | null;
  postedBy: string | null;
}

/**
 * Post the main line plus one VAT/levy split. Returns the total (all lines)
 * added to the folio for the given date. Mirrors issueInvoice's arithmetic:
 * the line itself never carries tax in the auto-post path.
 */

async function postRoomChargeLines(tx: Tx, o: RoomChargeLinesOptions): Promise<string> {
  const tax = await readTaxSettings(tx);
  const lineTotal = M.mul(M.of(o.unitAmount), o.quantity);
  await insertFolioCharge(tx, {
    propertyId: o.propertyId,
    bookingId: o.bookingId,
    chargeType: o.chargeType,
    description: o.description,
    quantity: o.quantity,
    unitAmount: o.unitAmount,
    taxRate: 0,
    taxAmount: M.of(0),
    totalAmount: lineTotal,
    chargeDate: o.chargeDate,
    sourceNightId: o.sourceNightId ?? null,
    postedBy: o.postedBy,
  });

  if (tax.taxInclusive) return lineTotal;

  const extras: string[] = [];
  if (tax.vatRate > 0) {
    const vat = M.pct(lineTotal, tax.vatRate);
    await insertFolioCharge(tx, {
      propertyId: o.propertyId,
      bookingId: o.bookingId,
      chargeType: 'tax',
      description: o.chargeType === 'adjustment' ? `VAT (${tax.vatRate}%) · no-show fee` : `VAT (${tax.vatRate}%)`,
      quantity: 1,
      unitAmount: M.of(0),
      taxRate: tax.vatRate,
      taxAmount: vat,
      totalAmount: vat,
      chargeDate: o.chargeDate,
      sourceNightId: null,
      postedBy: o.postedBy,
    });
    extras.push(vat);
  }
  if (o.chargeType === 'room' && tax.levyRate > 0) {
    const levy = M.pct(lineTotal, tax.levyRate);
    await insertFolioCharge(tx, {
      propertyId: o.propertyId,
      bookingId: o.bookingId,
      chargeType: 'levy',
      description: `Levy (${tax.levyRate}%)`,
      quantity: 1,
      unitAmount: M.of(0),
      taxRate: tax.levyRate,
      taxAmount: levy,
      totalAmount: levy,
      chargeDate: o.chargeDate,
      sourceNightId: null,
      postedBy: o.postedBy,
    });
    extras.push(levy);
  }
  return M.add(lineTotal, ...extras);
}

export interface PostedNightsSummary {
  nights: number;
  roomRevenue: string;
  totalRevenue: string;
}

/**
 * Post every unposted night for a stay date across the property's in-house
 * ledger, then resync the affected booking headers. Runs inside the caller's
 * transaction (the night audit itself).
 */
export async function postUnpostedNightsForDate(
  tx: Tx,
  o: { propertyId: string; stayDate: string; postedBy: string | null },
): Promise<PostedNightsSummary> {
  const nights = await postableNightsForDate(tx, o.propertyId, o.stayDate);
  if (nights.length === 0) return { nights: 0, roomRevenue: M.of(0), totalRevenue: M.of(0) };

  const labels = await roomLabels(tx, [...new Set(nights.map((n) => n.roomId))]);
  const roomTotals: string[] = [];
  const grandTotals: string[] = [];
  for (const night of nights) {
    const total = await postRoomChargeLines(tx, {
      propertyId: o.propertyId,
      bookingId: night.bookingId,
      chargeType: 'room',
      chargeDate: o.stayDate,
      description: `${labels.get(night.roomId) ?? 'Room'} · ${o.stayDate}`,
      quantity: 1,
      unitAmount: night.rate,
      sourceNightId: night.id,
      postedBy: o.postedBy,
    });
    roomTotals.push(night.rate);
    grandTotals.push(total);
  }
  await markNightsPosted(tx, nights.map((n) => n.id));
  for (const bookingId of new Set(nights.map((n) => n.bookingId))) {
    await syncTotalChargesToLedger(tx, bookingId);
  }
  return { nights: nights.length, roomRevenue: M.add(...roomTotals), totalRevenue: M.add(...grandTotals) };
}

export interface NoShowFeeOptions {
  propertyId: string;
  bookingId: string;
  chargeDate: string;
  feeNights: number;
  unitAmount: string;
  postedBy: string | null;
}

/** Book the no-show fee (N nights × first room rate) as a taxed adjustment. */
export async function postNoShowFee(tx: Tx, o: NoShowFeeOptions): Promise<string> {
  const total = await postRoomChargeLines(tx, {
    propertyId: o.propertyId,
    bookingId: o.bookingId,
    chargeType: 'adjustment',
    chargeDate: o.chargeDate,
    description: `No-show fee (${o.feeNights} night${o.feeNights === 1 ? '' : 's'})`,
    quantity: o.feeNights,
    unitAmount: o.unitAmount,
    sourceNightId: null,
    postedBy: o.postedBy,
  });
  await syncTotalChargesToLedger(tx, o.bookingId);
  return total;
}

// ─── Invoices ────────────────────────────────────────────────────────────────

/**
 * Issue an invoice for a booking. Posts every unposted room night to the folio
 * first (so the ledger holds the full stay), freezes the snapshot into
 * invoice_lines, and numbers it INV-<year>-NNNNNN gap-free. [§12.5]
 */
export async function issueInvoice(bookingId: string, actor: Actor): Promise<InvoiceView> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const booking = await lockBookingForFinance(tx, propertyId, bookingId);
    if (!booking) throw AppError.notFound('Booking not found');
    if (booking.status === 'cancelled' || booking.status === 'draft' || booking.status === 'no_show') {
      throw AppError.conflict('INVALID_TRANSITION', `A ${booking.status} booking cannot be invoiced`);
    }

    const tax = await readTaxSettings(tx);

    // 1. Post unposted nights (room charge per night + one VAT/levy line).
    const nights = await unpostedNights(tx, bookingId);
    if (nights.length > 0) {
      const labels = await roomLabels(tx, [...new Set(nights.map((n) => n.roomId))]);
      const nightlySubtotal = M.add(...nights.map((n) => n.rate));
      const firstNightDate = nights[0]!.stayDate;

      for (const night of nights) {
        await insertFolioCharge(tx, {
          propertyId,
          bookingId,
          chargeType: 'room',
          description: `${labels.get(night.roomId) ?? 'Room'} · ${night.stayDate}`,
          quantity: 1,
          unitAmount: night.rate,
          taxRate: 0,
          taxAmount: M.of(0),
          totalAmount: night.rate,
          chargeDate: night.stayDate,
          sourceNightId: night.id,
          postedBy: actor.id,
        });
      }
      if (!tax.taxInclusive) {
        if (tax.vatRate > 0) {
          const vat = M.pct(nightlySubtotal, tax.vatRate);
          await insertFolioCharge(tx, {
            propertyId,
            bookingId,
            chargeType: 'tax',
            description: `VAT (${tax.vatRate}%)`,
            quantity: 1,
            unitAmount: M.of(0),
            taxRate: tax.vatRate,
            taxAmount: vat,
            totalAmount: vat,
            chargeDate: firstNightDate,
            postedBy: actor.id,
          });
        }
        if (tax.levyRate > 0) {
          const levy = M.pct(nightlySubtotal, tax.levyRate);
          await insertFolioCharge(tx, {
            propertyId,
            bookingId,
            chargeType: 'levy',
            description: `Levy (${tax.levyRate}%)`,
            quantity: 1,
            unitAmount: M.of(0),
            taxRate: tax.levyRate,
            taxAmount: levy,
            totalAmount: levy,
            chargeDate: firstNightDate,
            postedBy: actor.id,
          });
        }
      }
      await markNightsPosted(tx, nights.map((n) => n.id));
      // The full stay is now on the ledger — the header cache is re-derived.
      await syncTotalChargesToLedger(tx, bookingId);
    }

    // 2. Freeze the live lines.
    const live = await liveFolioCharges(tx, bookingId);
    if (live.length === 0) {
      throw AppError.badRequest('VALIDATION_ERROR', 'There are no charges to invoice');
    }
    const totals = ledgerTotals(live);
    const amountPaid = await sumCompletedPayments(tx, bookingId);
    const status = invoiceStatusFor(totals.grandTotal, amountPaid);

    // 3. Bill-to snapshot — an issued invoice NEVER changes (§12.5).
    const [guest, property] = await Promise.all([
      findFinanceGuest(tx, booking.guestId),
      findFinanceProperty(tx, propertyId),
    ]);
    const year = today().slice(0, 4);
    const { reference } = await nextNumber(tx, propertyId, 'invoice', {
      prefix: `INV-${year}-`,
      period: year,
    });

    const invoice = await insertInvoice(tx, {
      propertyId,
      bookingId,
      invoiceNumber: reference,
      status,
      billToName: booking.guestNameSnapshot,
      billToAddress: guest?.address ?? property?.address ?? null,
      billToTaxPin: property?.taxPin ?? null,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      discountTotal: totals.discountTotal,
      grandTotal: totals.grandTotal,
      amountPaid,
      currency: property?.currency ?? 'KES',
      issuedBy: actor.id,
    });

    live.forEach((line, i) => {
      void insertInvoiceLine(tx, {
        invoiceId: invoice.id,
        chargeId: line.id,
        description: line.description,
        quantity: Number(line.quantity),
        unitAmount: line.unitAmount,
        taxRate: Number(line.taxRate),
        taxAmount: line.taxAmount,
        totalAmount: line.totalAmount,
        sortOrder: i,
      });
    });

    await eventBus.emit(BILLING_EVENTS.invoiceIssued, {
      bookingId,
      invoiceId: invoice.id,
      invoiceNumber: reference,
      grandTotal: totals.grandTotal,
      by: actor.email,
    });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'invoices.issue',
      entityType: 'invoice',
      entityId: invoice.id,
      summary: `Invoice ${reference} issued for ${totals.grandTotal}`,
    });

    const lines = await invoiceLinesForInvoice(tx, invoice.id);
    return toInvoiceView(invoice, lines.map(toInvoiceLineView));
  });
}

/**
 * Recompute every active invoice's amount_paid + status for a booking.
 * Runs inside the caller's transaction so it stays consistent with the
 * payment write (bookings module calls this in the same tx it records the
 * payment or reversal — cross-module service call, §5.1).
 */
export async function syncInvoicePayments(tx: Tx, bookingId: string): Promise<void> {
  const invoices = await invoicesForBooking(tx, bookingId);
  if (invoices.length === 0) return;
  const amountPaid = await sumCompletedPayments(tx, bookingId);
  for (const invoice of invoices) {
    await updateInvoicePayments(tx, invoice.id, amountPaid, invoiceStatusFor(invoice.grandTotal, amountPaid));
  }
}

export async function listInvoiceViews(
  filters: { status?: string; from?: string; to?: string; limit: number; offset: number },
  actor: Actor,
): Promise<{ data: InvoiceView[]; total: number }> {
  const propertyId = await scopeProperty(actor);
  return withDb(async (db) => {
    const rows = await listInvoices(db, { propertyId, ...filters });
    const total = await countInvoices(db, { propertyId, status: filters.status, from: filters.from, to: filters.to });
const data = await Promise.all(
        rows.map(async (row) => {
          const lines = await invoiceLinesForInvoice(db, row.id);
          return toInvoiceView(row, lines.map(toInvoiceLineView));
        }),
      );
    return { data, total };
  });
}

export async function getInvoice(invoiceId: string, actor: Actor): Promise<InvoiceView> {
  const propertyId = await scopeProperty(actor);
  const invoice = await withDb((db) => findInvoiceById(db, invoiceId));
  if (!invoice || invoice.propertyId !== propertyId) throw AppError.notFound('Invoice not found');
  const lines = await withDb((db) => invoiceLinesForInvoice(db, invoiceId));
  return toInvoiceView(invoice, lines.map(toInvoiceLineView));
}

/** Void an invoice (invoices.void + reason); the row stays forever. */
export async function voidInvoice(invoiceId: string, reason: string, actor: Actor): Promise<InvoiceView> {
  const propertyId = await scopeProperty(actor);
  return withTx(async (tx) => {
    const invoice = await findInvoiceById(tx, invoiceId);
    if (!invoice || invoice.propertyId !== propertyId) throw AppError.notFound('Invoice not found');
    if (invoice.status === 'void') {
      throw AppError.conflict('INVALID_TRANSITION', 'Invoice is already void');
    }

    const updated = await voidInvoiceRow(tx, invoiceId, reason);
    await eventBus.emit(BILLING_EVENTS.invoiceVoided, {
      bookingId: invoice.bookingId,
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      reason,
      by: actor.email,
    });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'invoices.void',
      entityType: 'invoice',
      entityId: invoiceId,
      summary: `Invoice ${invoice.invoiceNumber} voided: ${reason}`,
    });
    const lines = await invoiceLinesForInvoice(tx, invoiceId);
    return toInvoiceView(updated, lines.map(toInvoiceLineView));
  });
}

// ─── Documents (print views) ─────────────────────────────────────────────────

/** Inline HTML tax invoice (§12.5 "immediate HTML preview"; PDF via job+R2 later). */
export async function getInvoiceDocument(invoiceId: string, actor: Actor): Promise<string> {
  const propertyId = await scopeProperty(actor);
  return withDb(async (db) => {
    const invoice = await findInvoiceById(db, invoiceId);
    if (!invoice || invoice.propertyId !== propertyId) throw AppError.notFound('Invoice not found');
    const [lines, property, booking] = await Promise.all([
      invoiceLinesForInvoice(db, invoiceId),
      findFinanceProperty(db, propertyId),
      findBookingForFinance(db, invoice.bookingId),
    ]);
    const view = toInvoiceView(invoice, lines.map(toInvoiceLineView));
    const company = property?.legalName ?? property?.name ?? 'Hotel';
    const rows = view.lines
      .map(
        (l, i) => `<tr${i % 2 === 1 ? ' class="alt"' : ''}>
        <td>${esc(l.description)}</td><td class="num">${esc(l.quantity)}</td>
        <td class="num">${M.format(l.unitAmount, view.currency)}</td>
        <td class="num">${M.format(l.taxAmount, view.currency)}</td>
        <td class="num">${M.format(l.totalAmount, view.currency)}</td></tr>`,
      )
      .join('\n');
    return [
      '<!doctype html><html><head><meta charset="utf-8"><style>',
      '@page{size:A4;margin:18mm}', 'body{font:12px/1.45 ui-sans-serif,system-ui,sans-serif;color:#111;max-width:720px;margin:0 auto}',
      'h1{font-size:18px;margin:0}', '.muted{color:#666}', '.billto{float:right;text-align:right}', '.clear{clear:both}',
      'table{width:100%;border-collapse:collapse;margin-top:10px}', 'td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}',
      'tr.alt td{background:#fafafa}', 'td.num,th.num{text-align:right}', 'th{background:#f2f2f2;font-size:11px}',
      '.totals{width:45%;float:right;margin-top:10px}', '.totals td{padding:3px 8px;border:none}', '.grand td{font-weight:700;border-top:2px solid #111}',
      '.footer{margin-top:24px;font-size:10px;color:#666}',
      '</style></head><body>',
      `<h1>${esc(company)}</h1>`,
      `<div class="muted">${esc(property?.address ?? '')}</div>`,
      `<div class="billto"><strong>BILL TO</strong><br>${esc(view.billToName)}<br>${esc(view.billToAddress ?? '')}<br>${view.billToTaxPin ? `PIN: ${esc(view.billToTaxPin)}` : ''}</div>`,
      '<div class="clear"></div>',
      `<div><strong>INVOICE</strong> ${esc(view.invoiceNumber)}<br>`,
      `<span class="muted">Date ${esc(view.issuedAt ?? '')} · Status ${esc(view.status)} · Booking ${booking ? esc(booking.reference) : ''}</span></div>`,
      '<table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Tax</th><th class="num">Total</th></tr></thead><tbody>',
      rows,
      '</tbody></table>',
      '<table class="totals">',
      `<tr><td>Subtotal</td><td class="num">${M.format(view.subtotal, view.currency)}</td></tr>`,
      `<tr><td>Tax</td><td class="num">${M.format(view.taxTotal, view.currency)}</td></tr>`,
      `<tr><td>Discount</td><td class="num">${M.format(view.discountTotal, view.currency)}</td></tr>`,
      `<tr class="grand"><td>Grand total</td><td class="num">${M.format(view.grandTotal, view.currency)}</td></tr>`,
      `<tr><td>Paid</td><td class="num">${M.format(view.amountPaid, view.currency)}</td></tr>`,
      `<tr><td>Balance</td><td class="num">${M.format(view.balance, view.currency)}</td></tr>`,
      '</table>',
      `<div class="footer">${esc(company)} · ${esc(property?.taxPin ?? '')} · This is a system-generated document.</div>`,
      '</body></html>',
    ].join('');
  });
}

/** 80 mm thermal receipt for a payment (§12.5 thermals). */
export async function getPaymentReceipt(paymentId: string, actor: Actor): Promise<string> {
  const propertyId = await scopeProperty(actor);
  return withDb(async (db) => {
    const payment = await findPayment(db, paymentId);
    if (!payment || payment.propertyId !== propertyId) throw AppError.notFound('Payment not found');
    const [property, booking] = await Promise.all([
      findFinanceProperty(db, propertyId),
      payment.bookingId ? findBookingForFinance(db, payment.bookingId) : Promise.resolve(null),
    ]);
    const company = property?.name ?? 'Hotel';
    const methodLabel = String(payment.method).replace('_', ' ').toUpperCase();
    return [
      '<!doctype html><html><head><meta charset="utf-8"><style>',
      '@page{size:80mm auto;margin:4mm}', '@media print{.no-print{display:none}}',
      'body{font:11px/1.35 ui-monospace,Menlo,monospace;width:72mm;margin:0 auto;color:#000}',
      'h1{font-size:13px;text-align:center;margin:0}', '.center{text-align:center}', '.muted{color:#555}',
      'table{width:100%}', 'td{padding:1px 0}', '.right{text-align:right}',
      '.big{font-size:15px;font-weight:700}', 'button{margin-top:10px}',
      '</style></head><body>',
      `<h1>${esc(company)}</h1>`,
      `<div class="center muted">${esc(property?.address ?? '')}</div>`,
      `<div class="center muted">${esc(property?.phone ?? property?.email ?? '')}</div>`,
      '<hr>',
      '<div class="center">OFFICIAL RECEIPT</div>',
      `<div class="center"><strong>${esc(payment.receiptNumber)}</strong></div>`,
      `<div><table><tr><td>Date</td><td class="right">${esc(iso(payment.paidAt) ?? '')}</td></tr>`,
      `<tr><td>Booking</td><td class="right">${booking ? esc(booking.reference) : '—'}</td></tr>`,
      `<tr><td>Guest</td><td class="right">${booking ? esc(booking.guestNameSnapshot) : esc(payment.payerName ?? '')}</td></tr>`,
      `<tr><td>Method</td><td class="right">${esc(methodLabel)}</td></tr>`,
      payment.reference ? `<tr><td>Reference</td><td class="right">${esc(payment.reference)}</td></tr>` : '',
      '</table></div>',
      '<hr>',
      `<div class="center big">${M.format(payment.amount, property?.currency ?? 'KES')}</div>`,
      payment.status === 'reversed' ? '<div class="center">VOID / REVERSED</div>' : '',
      payment.notes ? `<div class="muted">${esc(payment.notes)}</div>` : '',
      '<hr>',
      '<div class="center muted">Thank you for choosing us</div>',
      '<div class="center no-print"><button onclick="window.print()">Print</button></div>',
      '</body></html>',
    ].join('');
  });
}

// ─── Internals ───────────────────────────────────────────────────────────────

function invoiceStatusFor(grandTotal: string, amountPaid: string): InvoiceStatusValue {
  if (M.cmp(amountPaid, grandTotal) >= 0) return 'paid';
  if (M.cmp(amountPaid, '0') > 0) return 'partially_paid';
  return 'issued';
}

function esc(v: string | null | undefined): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}