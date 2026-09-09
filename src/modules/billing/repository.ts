/**
 * modules/billing/repository.ts
 *
 * All SQL for money: folio charges, invoices, invoice lines, payments reads,
 * and the finance-facing booking/guest/property lookups (without importing
 * another module's repository — cross-module tables come from the core schema
 * barrel, exactly as §5.1 requires).
 *
 * Money is stored NUMERIC(14,2) and arrives from Drizzle as strings; the
 * arithmetic lives in core/money. Everything financial is append-only for
 * hms_app (§8.3): charges are voided, invoices voided, payments reversed —
 * never deleted.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db, type Tx } from '@/core/db';
import { chargeType } from './schema';

export type ChargeType = (typeof chargeType.enumValues)[number];
type PaymentType = 'payment' | 'deposit' | 'refund';
type PaymentMethod = 'cash' | 'mpesa' | 'card' | 'bank_transfer' | 'cheque' | 'other';

// ─── Finance-facing booking header ───────────────────────────────────────────

export interface FinanceBookingRecord {
  id: string;
  propertyId: string;
  reference: string;
  guestId: string;
  status: string;
  guestNameSnapshot: string;
  totalCharges: string;
  totalPaid: string;
  balance: string | null;
}

/** Lock the booking header while money concerns it (folio writes, issue). */
export async function lockBookingForFinance(tx: Tx, propertyId: string, bookingId: string): Promise<FinanceBookingRecord | null> {
  const rows = await tx.execute(sql`
    SELECT id, property_id AS "propertyId", reference, guest_id AS "guestId",
           status, guest_name_snapshot AS "guestNameSnapshot",
           total_charges AS "totalCharges", total_paid AS "totalPaid", balance
    FROM bookings
    WHERE id = ${bookingId} AND property_id = ${propertyId}
    FOR UPDATE
  `);
  return (rows.rows as unknown as FinanceBookingRecord[])[0] ?? null;
}

export async function findBookingForFinance(db: Db | Tx, bookingId: string): Promise<FinanceBookingRecord | null> {
  const rows = await db
    .select({
      id: schema.bookings.id,
      propertyId: schema.bookings.propertyId,
      reference: schema.bookings.reference,
      guestId: schema.bookings.guestId,
      status: schema.bookings.status,
      guestNameSnapshot: schema.bookings.guestNameSnapshot,
      totalCharges: schema.bookings.totalCharges,
      totalPaid: schema.bookings.totalPaid,
      balance: schema.bookings.balance,
    })
    .from(schema.bookings)
    .where(eq(schema.bookings.id, bookingId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Settings (tax rates are settings, never hardcoded) ─────────────────────

export interface TaxSettingsRecord {
  vatRate: number;
  levyRate: number;
  taxInclusive: boolean;
}

export async function readTaxSettings(db: Db | Tx): Promise<TaxSettingsRecord> {
  const keys = ['vat_rate', 'levy_rate', 'tax_inclusive_pricing'];
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys));
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));
  const num = (key: string, fallback: number): number => {
    const raw = map.get(key);
    if (raw === undefined || raw === null) return fallback;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = map.get(key);
    return typeof raw === 'boolean' ? raw : fallback;
  };
  return {
    vatRate: num('vat_rate', 16),
    levyRate: num('levy_rate', 0),
    taxInclusive: bool('tax_inclusive_pricing', false),
  };
}

// ─── Folio charges ───────────────────────────────────────────────────────────

export interface FolioChargeRecord {
  id: string;
  propertyId: string;
  bookingId: string;
  chargeType: ChargeType;
  description: string;
  quantity: string;
  unitAmount: string;
  taxRate: string;
  taxAmount: string;
  totalAmount: string;
  chargeDate: string;
  sourceNightId: string | null;
  isVoided: boolean;
  voidedBy: string | null;
  voidedReason: string | null;
  postedBy: string | null;
  createdAt: Date;
}

const FOLIO_COLUMNS = {
  id: schema.folioCharges.id,
  propertyId: schema.folioCharges.propertyId,
  bookingId: schema.folioCharges.bookingId,
  chargeType: schema.folioCharges.chargeType,
  description: schema.folioCharges.description,
  quantity: schema.folioCharges.quantity,
  unitAmount: schema.folioCharges.unitAmount,
  taxRate: schema.folioCharges.taxRate,
  taxAmount: schema.folioCharges.taxAmount,
  totalAmount: schema.folioCharges.totalAmount,
  chargeDate: schema.folioCharges.chargeDate,
  sourceNightId: schema.folioCharges.sourceNightId,
  isVoided: schema.folioCharges.isVoided,
  voidedBy: schema.folioCharges.voidedBy,
  voidedReason: schema.folioCharges.voidedReason,
  postedBy: schema.folioCharges.postedBy,
  createdAt: schema.folioCharges.createdAt,
};

export interface InsertFolioChargeValues {
  propertyId: string;
  bookingId: string;
  chargeType: ChargeType;
  description: string;
  quantity: number;
  unitAmount: string;
  taxRate: number;
  /** Pre-rounded tax amount for this line ("0.00" when untaxed). */
  taxAmount: string;
  totalAmount: string;
  chargeDate: string;
  sourceNightId?: string | null;
  postedBy: string;
}

export function insertFolioCharge(tx: Tx, v: InsertFolioChargeValues): Promise<FolioChargeRecord> {
  return tx
    .insert(schema.folioCharges)
    .values({
      propertyId: v.propertyId,
      bookingId: v.bookingId,
      chargeType: v.chargeType,
      description: v.description,
      quantity: v.quantity.toString(),
      unitAmount: v.unitAmount,
      taxRate: v.taxRate.toString(),
      taxAmount: v.taxAmount,
      totalAmount: v.totalAmount,
      chargeDate: v.chargeDate,
      sourceNightId: v.sourceNightId ?? null,
      postedBy: v.postedBy,
    })
    .returning(FOLIO_COLUMNS)
    .then((rows) => rows[0]!);
}

export async function folioChargesForBooking(db: Db | Tx, bookingId: string): Promise<FolioChargeRecord[]> {
  return db
    .select(FOLIO_COLUMNS)
    .from(schema.folioCharges)
    .where(eq(schema.folioCharges.bookingId, bookingId))
    .orderBy(asc(schema.folioCharges.createdAt), asc(schema.folioCharges.id));
}

/** Non-voided lines only — the live ledger an invoice freezes. */
export async function liveFolioCharges(db: Db | Tx, bookingId: string): Promise<FolioChargeRecord[]> {
  return db
    .select(FOLIO_COLUMNS)
    .from(schema.folioCharges)
    .where(and(eq(schema.folioCharges.bookingId, bookingId), eq(schema.folioCharges.isVoided, false)))
    .orderBy(asc(schema.folioCharges.createdAt), asc(schema.folioCharges.id));
}

export async function findFolioCharge(db: Db | Tx, id: string): Promise<FolioChargeRecord | null> {
  const rows = await db.select(FOLIO_COLUMNS).from(schema.folioCharges).where(eq(schema.folioCharges.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function voidFolioCharge(tx: Tx, id: string, byId: string, reason: string): Promise<FolioChargeRecord> {
  return tx
    .update(schema.folioCharges)
    .set({ isVoided: true, voidedBy: byId, voidedReason: reason })
    .where(eq(schema.folioCharges.id, id))
    .returning(FOLIO_COLUMNS)
    .then((rows) => rows[0]!);
}

/** Cash-position cache: `total_charges = Σ(non-voided folio)` (§12.1 rule 5). */
export async function syncTotalChargesToLedger(tx: Tx, bookingId: string): Promise<void> {
  await tx.update(schema.bookings).set({ totalCharges: sql`(
    SELECT COALESCE(SUM(total_amount), 0)::numeric(14,2)
    FROM folio_charges
    WHERE booking_id = ${bookingId} AND NOT is_voided
  )` }).where(eq(schema.bookings.id, bookingId));
}

/** Apply a signed delta (manual charge/void) to the cached total_charges. */
export async function applyTotalChargesDelta(tx: Tx, bookingId: string, delta: string): Promise<void> {
  await tx.execute(sql`
    UPDATE bookings
    SET total_charges = (COALESCE(total_charges, 0) + ${delta})::numeric(14,2),
        updated_at = now()
    WHERE id = ${bookingId}
  `);
}

// ─── Room nights → folio posting (at invoice issue) ──────────────────────────

export interface UnpostedNightRecord {
  id: string;
  bookingId: string;
  roomId: string;
  roomTypeId: string;
  stayDate: string;
  rate: string;
}

/** Nights not yet charged to the folio (folio_room_night_uq guards one shot). */
export async function unpostedNights(tx: Tx, bookingId: string): Promise<UnpostedNightRecord[]> {
  const n = schema.bookingNights;
  return tx
    .select({
      id: n.id,
      bookingId: n.bookingId,
      roomId: n.roomId,
      roomTypeId: n.roomTypeId,
      stayDate: n.stayDate,
      rate: n.rate,
    })
    .from(n)
    .where(and(eq(n.bookingId, bookingId), eq(n.isPosted, false)))
    .orderBy(asc(n.stayDate));
}

export async function markNightsPosted(tx: Tx, nightIds: string[]): Promise<void> {
  if (nightIds.length === 0) return;
  await tx
    .update(schema.bookingNights)
    .set({ isPosted: true })
    .where(inArray(schema.bookingNights.id, nightIds));
}

/** room id → human label for auto-posted room charges ("Deluxe · 201"). */
export async function roomLabels(tx: Tx, roomIds: string[]): Promise<Map<string, string>> {
  if (roomIds.length === 0) return new Map();
  const rows = await tx.execute(sql`
    SELECT r.id AS id, r.room_number AS "roomNumber",
           COALESCE(rt.name, rt.code, 'Room') AS "typeName"
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.id IN (${roomIds.map((id) => sql`${id}`)})
  `);
  const out = new Map<string, string>();
  for (const row of rows.rows as { id: string; roomNumber: string; typeName: string }[]) {
    out.set(row.id, `${row.typeName} · ${row.roomNumber}`);
  }
  return out;
}

// ─── Payments (reads only — recording stays in the bookings module) ──────────

export interface PaymentReadRecord {
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
}

const PAYMENT_READ_COLUMNS = {
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
};

export async function findPayment(db: Db | Tx, id: string): Promise<PaymentReadRecord | null> {
  const rows = await db.select(PAYMENT_READ_COLUMNS).from(schema.payments).where(eq(schema.payments.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function paymentsForBooking(db: Db | Tx, bookingId: string): Promise<PaymentReadRecord[]> {
  return db
    .select(PAYMENT_READ_COLUMNS)
    .from(schema.payments)
    .where(eq(schema.payments.bookingId, bookingId))
    .orderBy(asc(schema.payments.createdAt));
}

/** Net paid = Σ completed rows, refunds negative, reversal rows excluded. */
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

// ─── Invoices ─────────────────────────────────────────────────────────────────

export interface InvoiceRecord {
  id: string;
  propertyId: string;
  bookingId: string;
  invoiceNumber: string;
  status: string;
  issuedAt: Date | null;
  dueDate: string | null;
  billToName: string;
  billToAddress: string | null;
  billToTaxPin: string | null;
  subtotal: string;
  taxTotal: string;
  discountTotal: string;
  grandTotal: string;
  amountPaid: string;
  currency: string;
  pdfFileId: string | null;
  voidReason: string | null;
  issuedBy: string | null;
  createdAt: Date;
}

const INVOICE_COLUMNS = {
  id: schema.invoices.id,
  propertyId: schema.invoices.propertyId,
  bookingId: schema.invoices.bookingId,
  invoiceNumber: schema.invoices.invoiceNumber,
  status: schema.invoices.status,
  issuedAt: schema.invoices.issuedAt,
  dueDate: schema.invoices.dueDate,
  billToName: schema.invoices.billToName,
  billToAddress: schema.invoices.billToAddress,
  billToTaxPin: schema.invoices.billToTaxPin,
  subtotal: schema.invoices.subtotal,
  taxTotal: schema.invoices.taxTotal,
  discountTotal: schema.invoices.discountTotal,
  grandTotal: schema.invoices.grandTotal,
  amountPaid: schema.invoices.amountPaid,
  currency: schema.invoices.currency,
  pdfFileId: schema.invoices.pdfFileId,
  voidReason: schema.invoices.voidReason,
  issuedBy: schema.invoices.issuedBy,
  createdAt: schema.invoices.createdAt,
};

export interface InsertInvoiceValues {
  propertyId: string;
  bookingId: string;
  invoiceNumber: string;
  status: string;
  billToName: string;
  billToAddress: string | null;
  billToTaxPin: string | null;
  subtotal: string;
  taxTotal: string;
  discountTotal: string;
  grandTotal: string;
  amountPaid: string;
  currency: string;
  issuedBy: string;
}

export function insertInvoice(tx: Tx, v: InsertInvoiceValues): Promise<InvoiceRecord> {
  return tx
    .insert(schema.invoices)
    .values({
      propertyId: v.propertyId,
      bookingId: v.bookingId,
      invoiceNumber: v.invoiceNumber,
      status: v.status as never,
      issuedAt: new Date(),
      billToName: v.billToName,
      billToAddress: v.billToAddress,
      billToTaxPin: v.billToTaxPin,
      subtotal: v.subtotal,
      taxTotal: v.taxTotal,
      discountTotal: v.discountTotal,
      grandTotal: v.grandTotal,
      amountPaid: v.amountPaid,
      currency: v.currency,
      issuedBy: v.issuedBy,
    })
    .returning(INVOICE_COLUMNS)
    .then((rows) => rows[0]!);
}

export type InvoiceStatusValue = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void';

export async function updateInvoiceStatus(tx: Tx, id: string, status: InvoiceStatusValue): Promise<InvoiceRecord> {
  return tx
    .update(schema.invoices)
    .set({ status })
    .where(eq(schema.invoices.id, id))
    .returning(INVOICE_COLUMNS)
    .then((rows) => rows[0]!);
}

export async function voidInvoice(tx: Tx, id: string, reason: string): Promise<InvoiceRecord> {
  return tx
    .update(schema.invoices)
    .set({ status: 'void', voidReason: reason })
    .where(eq(schema.invoices.id, id))
    .returning(INVOICE_COLUMNS)
    .then((rows) => rows[0]!);
}

export async function findInvoiceById(db: Db | Tx, id: string): Promise<InvoiceRecord | null> {
  const rows = await db.select(INVOICE_COLUMNS).from(schema.invoices).where(eq(schema.invoices.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Active (non-void, non-draft) invoices for a booking — status is payment-driven. */
export async function invoicesForBooking(db: Db | Tx, bookingId: string): Promise<InvoiceRecord[]> {
  return db
    .select(INVOICE_COLUMNS)
    .from(schema.invoices)
    .where(and(eq(schema.invoices.bookingId, bookingId), sql`${schema.invoices.status} NOT IN ('void','draft')`));
}

/** Refresh an invoice's cash position + derived status after a payment change. */
export async function updateInvoicePayments(
  tx: Tx,
  id: string,
  amountPaid: string,
  status: InvoiceStatusValue,
): Promise<InvoiceRecord> {
  return tx
    .update(schema.invoices)
    .set({ amountPaid, status })
    .where(eq(schema.invoices.id, id))
    .returning(INVOICE_COLUMNS)
    .then((rows) => rows[0]!);
}

export type InvoiceListRow = Omit<InvoiceRecord, 'pdfFileId'>;

export async function listInvoices(db: Db, f: { propertyId: string; status?: string; from?: string; to?: string; limit: number; offset: number }): Promise<InvoiceListRow[]> {
  const conds = [eq(schema.invoices.propertyId, f.propertyId)];
  if (f.status) conds.push(eq(schema.invoices.status, f.status as never));
  if (f.from) conds.push(sql`${schema.invoices.issuedAt}::date >= ${f.from}`);
  if (f.to) conds.push(sql`${schema.invoices.issuedAt}::date <= ${f.to}`);
  return db
    .select({
      id: schema.invoices.id,
      propertyId: schema.invoices.propertyId,
      bookingId: schema.invoices.bookingId,
      invoiceNumber: schema.invoices.invoiceNumber,
      status: schema.invoices.status,
      issuedAt: schema.invoices.issuedAt,
      dueDate: schema.invoices.dueDate,
      billToName: schema.invoices.billToName,
      billToAddress: schema.invoices.billToAddress,
      billToTaxPin: schema.invoices.billToTaxPin,
      subtotal: schema.invoices.subtotal,
      taxTotal: schema.invoices.taxTotal,
      discountTotal: schema.invoices.discountTotal,
      grandTotal: schema.invoices.grandTotal,
      amountPaid: schema.invoices.amountPaid,
      currency: schema.invoices.currency,
      voidReason: schema.invoices.voidReason,
      issuedBy: schema.invoices.issuedBy,
      createdAt: schema.invoices.createdAt,
    })
    .from(schema.invoices)
    .where(and(...conds))
    .orderBy(desc(schema.invoices.createdAt))
    .limit(f.limit)
    .offset(f.offset);
}

export async function countInvoices(db: Db, f: { propertyId: string; status?: string; from?: string; to?: string }): Promise<number> {
  const conds = [eq(schema.invoices.propertyId, f.propertyId)];
  if (f.status) conds.push(eq(schema.invoices.status, f.status as never));
  if (f.from) conds.push(sql`${schema.invoices.issuedAt}::date >= ${f.from}`);
  if (f.to) conds.push(sql`${schema.invoices.issuedAt}::date <= ${f.to}`);
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.invoices)
    .where(and(...conds));
  return rows[0]?.n ?? 0;
}

export interface InvoiceLineRecord {
  id: string;
  invoiceId: string;
  chargeId: string | null;
  description: string;
  quantity: string;
  unitAmount: string;
  taxRate: string;
  taxAmount: string;
  totalAmount: string;
  sortOrder: number;
}

const INVOICE_LINE_COLUMNS = {
  id: schema.invoiceLines.id,
  invoiceId: schema.invoiceLines.invoiceId,
  chargeId: schema.invoiceLines.chargeId,
  description: schema.invoiceLines.description,
  quantity: schema.invoiceLines.quantity,
  unitAmount: schema.invoiceLines.unitAmount,
  taxRate: schema.invoiceLines.taxRate,
  taxAmount: schema.invoiceLines.taxAmount,
  totalAmount: schema.invoiceLines.totalAmount,
  sortOrder: schema.invoiceLines.sortOrder,
};

export interface InsertInvoiceLineValues {
  invoiceId: string;
  chargeId: string | null;
  description: string;
  quantity: number;
  unitAmount: string;
  taxRate: number;
  taxAmount: string;
  totalAmount: string;
  sortOrder: number;
}

export function insertInvoiceLine(tx: Tx, v: InsertInvoiceLineValues): Promise<InvoiceLineRecord> {
  return tx
    .insert(schema.invoiceLines)
    .values({
      invoiceId: v.invoiceId,
      chargeId: v.chargeId ?? null,
      description: v.description,
      quantity: v.quantity.toString(),
      unitAmount: v.unitAmount,
      taxRate: v.taxRate.toString(),
      taxAmount: v.taxAmount,
      totalAmount: v.totalAmount,
      sortOrder: v.sortOrder,
    })
    .returning(INVOICE_LINE_COLUMNS)
    .then((rows) => rows[0]!);
}

export async function invoiceLinesForInvoice(db: Db | Tx, invoiceId: string): Promise<InvoiceLineRecord[]> {
  return db
    .select(INVOICE_LINE_COLUMNS)
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(schema.invoiceLines.sortOrder), asc(schema.invoiceLines.id));
}

// ─── Bill-to snapshot lookups ────────────────────────────────────────────────

export interface FinanceGuestRecord {
  id: string;
  propertyId: string;
  fullName: string;
  address: string | null;
  company: string | null;
}

export async function findFinanceGuest(db: Db | Tx, id: string): Promise<FinanceGuestRecord | null> {
  const rows = await db
    .select({
      id: schema.guests.id,
      propertyId: schema.guests.propertyId,
      fullName: schema.guests.fullName,
      address: schema.guests.address,
      company: schema.guests.company,
    })
    .from(schema.guests)
    .where(eq(schema.guests.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface FinancePropertyRecord {
  id: string;
  name: string;
  legalName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  currency: string;
  taxPin: string | null;
}

export async function findFinanceProperty(db: Db | Tx, id: string): Promise<FinancePropertyRecord | null> {
  const rows = await db
    .select({
      id: schema.properties.id,
      name: schema.properties.name,
      legalName: schema.properties.legalName,
      address: schema.properties.address,
      phone: schema.properties.phone,
      email: schema.properties.email,
      currency: schema.properties.currency,
      taxPin: schema.properties.taxPin,
    })
    .from(schema.properties)
    .where(eq(schema.properties.id, id))
    .limit(1);
  return rows[0] ?? null;
}