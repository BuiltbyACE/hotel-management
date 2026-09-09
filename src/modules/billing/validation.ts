/**
 * modules/billing/validation.ts
 *
 * Route-facing Zod schemas for folio, invoices and receipts. Money enters as a
 * string ("1250.00", negative for discounts) — never a JS number (core/money).
 */
import { z } from 'zod';

const uuid = z.string().uuid('A valid id is required');

export const CHARGE_TYPES = ['room', 'tax', 'levy', 'extra', 'service', 'discount', 'adjustment'] as const;
export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'void'] as const;

const signedMoney = z
  .string({ message: 'Amount must be a decimal like 1250.00' })
  .regex(/^-?\d+(\.\d{1,2})?$/, 'Amount must be a decimal like 1250.00');

export const postChargeSchema = z
  .object({
    chargeType: z.enum(CHARGE_TYPES, { message: 'Invalid charge type' }),
    description: z.string({ message: 'Description is required' }).trim().min(1, 'Description is required').max(200, 'Description too long'),
    quantity: z.coerce.number().positive('Quantity must be positive').max(99999).default(1),
    unitAmount: signedMoney.refine((v) => Number(v) !== 0, { message: 'Unit amount cannot be zero' }),
  })
  .refine((v) => v.chargeType === 'discount' || v.chargeType === 'adjustment' || Number(v.unitAmount) >= 0, {
    message: 'Unit amount must be non-negative for this charge type',
    path: ['unitAmount'],
  })
  .strict();

export const voidChargeSchema = z
  .object({
    reason: z.string().trim().min(3, 'A reason is required').max(500, 'Reason too long'),
  })
  .strict();

export const listInvoicesQuerySchema = z.object({
  status: z.enum(INVOICE_STATUSES).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const issueInvoiceSchema = z
  .object({
    bookingId: uuid,
  })
  .strict();

export const voidInvoiceSchema = z
  .object({
    reason: z.string().trim().min(3, 'A reason is required').max(500, 'Reason too long'),
  })
  .strict();