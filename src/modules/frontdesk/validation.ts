/**
 * modules/frontdesk/validation.ts
 *
 * Route-facing Zod schemas for the front desk (§16.3 Front desk). The walk-in
 * schema is re-declared here (not imported from bookings) so the module stays
 * boundary-clean; source is forced to walk_in and the check-in override reason
 * rides alongside the standard booking payload.
 */
import { z } from 'zod';

const uuid = z.uuid('A valid id is required');
const isoDate = z
  .string({ message: 'Date must be a string' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');
const optionalText = (max: number, label = 'text') =>
  z.string({ message: `${label} must be a string` }).trim().max(max, `${label} too long`).nullish();

const METHODS = ['cash', 'mpesa', 'card', 'bank_transfer', 'cheque', 'other'] as const;

const paymentSchema = z
  .object({
    amount: z
      .string({ message: 'Amount is required' })
      .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal like 12500.00'),
    method: z.enum(METHODS, { message: 'Invalid payment method' }),
    reference: optionalText(80, 'Reference'),
    notes: optionalText(300, 'Notes'),
  })
  .refine((v) => Number(v.amount) > 0, { message: 'Amount must be positive', path: ['amount'] });

export const dateQuerySchema = z.object({
  date: isoDate.optional(),
});
export type DateQuery = z.infer<typeof dateQuerySchema>;

export const walkInSchema = z
  .object({
    guest: z.object({
      fullName: z.string().trim().min(1, 'Full name is required').max(120, 'Full name too long'),
      phone: z.string().trim().min(7, 'Phone number looks too short').max(30, 'Phone number too long').optional(),
      email: z.string().trim().email('A valid email is required').max(120, 'Email too long').optional(),
      idType: z.string().trim().max(30).optional(),
      idNumber: optionalText(40, 'ID number'),
    }),
    rooms: z
      .array(
        z.object({
          roomId: uuid,
          arrival: isoDate,
          departure: isoDate,
          adults: z.coerce.number().int().min(1, 'At least one adult').max(20),
          children: z.coerce.number().int().min(0).max(20).default(0),
          overrideRate: z.coerce.number().nonnegative().max(999999999).optional(),
        }),
      )
      .min(1, 'Book at least one room')
      .max(20, 'Too many rooms'),
    specialRequests: optionalText(500, 'Special requests'),
    internalNotes: optionalText(1000, 'Internal notes'),
    payment: paymentSchema.nullish(),
    overrideDepositReason: optionalText(200, 'Override reason'),
  })
  .refine((v) => v.rooms.every((r) => r.departure > r.arrival), {
    message: 'departure must be after arrival',
    path: ['rooms'],
  });

export type WalkInInput = z.infer<typeof walkInSchema>;

export const nightAuditBodySchema = z.object({
  /** Target business date; defaults to yesterday when omitted. */
  date: isoDate.optional(),
});
export type NightAuditInput = z.infer<typeof nightAuditBodySchema>;