/**
 * modules/billing/schema.ts
 *
 * Money: folio charges, invoices, invoice lines, payments. Owned tables
 * (blueprint §5.1): folio_charges, invoices, invoice_lines, payments.
 * (number_sequences — used by billing for gap-free invoice numbering and by
 * bookings for references — lives in core/db/infra.ts, not here.)
 *
 * Mirror of drizzle/0001_full_schema.sql §7. Everything here is financial:
 * the migration REVOKEs DELETE from hms_app on these tables — voiding and
 * reversing, never deleting. Several partial unique indexes enforce needed
 * business rules (one posting per room-night, unique receipt numbers,
 * unique external references for completed payments).
 *
 * Cross-module FKs to bookings (booking_id), files (pdf_file_id) and the
 * self-referential payments.reversal_of are SQL-only in the migration.
 */
import { sql } from 'drizzle-orm';
import { boolean, char, check, date, index, numeric, pgEnum, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const chargeType = pgEnum('charge_type', ['room', 'tax', 'levy', 'extra', 'service', 'discount', 'adjustment']);
export const paymentType = pgEnum('payment_type', ['payment', 'deposit', 'refund']);
export const paymentMethod = pgEnum('payment_method', ['cash', 'mpesa', 'card', 'bank_transfer', 'cheque', 'other']);
export const paymentStatus = pgEnum('payment_status', ['pending', 'completed', 'failed', 'reversed']);
export const invoiceStatus = pgEnum('invoice_status', ['draft', 'issued', 'partially_paid', 'paid', 'void']);

export const folioCharges = pgTable(
  'folio_charges',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    bookingId: uuid('booking_id').notNull(),
    chargeType: chargeType('charge_type').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull().default('1'),
    unitAmount: numeric('unit_amount', { precision: 14, scale: 2 }).notNull(),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    chargeDate: date('charge_date', { mode: 'string' }).notNull(),
    sourceNightId: uuid('source_night_id'),
    isVoided: boolean('is_voided').notNull().default(false),
    voidedBy: uuid('voided_by'),
    voidedReason: text('voided_reason'),
    postedBy: uuid('posted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('folio_charges_quantity_gt0', sql`${t.quantity} > 0`),
    index('folio_booking_idx').on(t.bookingId).where(sql`NOT ${t.isVoided}`),
    index('folio_date_idx').on(t.propertyId, t.chargeDate).where(sql`NOT ${t.isVoided}`),
    uniqueIndex('folio_room_night_uq')
      .on(t.sourceNightId)
      .where(sql`${t.sourceNightId} IS NOT NULL AND NOT ${t.isVoided}`),
  ],
);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    bookingId: uuid('booking_id').notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    status: invoiceStatus('status').notNull().default('draft'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueDate: date('due_date', { mode: 'string' }),
    billToName: text('bill_to_name').notNull(),
    billToAddress: text('bill_to_address'),
    billToTaxPin: text('bill_to_tax_pin'),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 14, scale: 2 }).notNull().default('0'),
    discountTotal: numeric('discount_total', { precision: 14, scale: 2 }).notNull().default('0'),
    grandTotal: numeric('grand_total', { precision: 14, scale: 2 }).notNull().default('0'),
    amountPaid: numeric('amount_paid', { precision: 14, scale: 2 }).notNull().default('0'),
    currency: char('currency', { length: 3 }).notNull().default('KES'),
    pdfFileId: uuid('pdf_file_id'),
    voidReason: text('void_reason'),
    issuedBy: uuid('issued_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invoices_number_uq').on(t.propertyId, t.invoiceNumber),
    index('invoices_booking_idx').on(t.bookingId),
  ],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    invoiceId: uuid('invoice_id').notNull(),
    chargeId: uuid('charge_id'),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull(),
    unitAmount: numeric('unit_amount', { precision: 14, scale: 2 }).notNull(),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    sortOrder: smallint('sort_order').notNull().default(0),
  },
  (t) => [index('invoice_lines_invoice_idx').on(t.invoiceId)],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    bookingId: uuid('booking_id'),
    invoiceId: uuid('invoice_id'),
    receiptNumber: text('receipt_number').notNull(),
    paymentType: paymentType('payment_type').notNull().default('payment'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    method: paymentMethod('method').notNull(),
    status: paymentStatus('status').notNull().default('completed'),
    reference: text('reference'),
    payerName: text('payer_name'),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    notes: text('notes'),
    reversalOf: uuid('reversal_of'),
    reversedBy: uuid('reversed_by'),
    reversedReason: text('reversed_reason'),
    idempotencyKey: text('idempotency_key'),
    recordedBy: uuid('recorded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('payments_amount_gt0', sql`${t.amount} > 0`),
    uniqueIndex('payments_receipt_uq').on(t.propertyId, t.receiptNumber),
    uniqueIndex('payments_idempotency_uq')
      .on(t.propertyId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    uniqueIndex('payments_reference_uq')
      .on(t.propertyId, t.method, sql`upper(${t.reference})`)
      .where(sql`${t.reference} IS NOT NULL AND ${t.reference} <> '' AND ${t.status} = 'completed'`),
    index('payments_booking_idx').on(t.bookingId),
    index('payments_date_idx').on(t.propertyId, t.businessDate, t.method),
  ],
);