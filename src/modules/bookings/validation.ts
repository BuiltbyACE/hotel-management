/**
 * modules/bookings/validation.ts
 *
 * Route-facing Zod schemas. Handlers validate here; the service re-enforces
 * business rules (transition guards, room locking, server-side pricing).
 */
import { z } from 'zod';

const uuid = z.string().uuid('A valid id is required');
const isoDate = z
  .string({ message: 'Date must be a string' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');
const optionalText = (max: number, label = 'text') =>
  z.string({ message: `${label} must be a string` }).trim().max(max, `${label} too long`).nullish();

const SOURCES = ['walk_in', 'phone', 'email', 'front_desk', 'online', 'ota', 'corporate'] as const;
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

export const createBookingSchema = z
  .object({
    guest: z.object({
      fullName: z.string().trim().min(1, 'Full name is required').max(120, 'Full name too long'),
      phone: z.string().trim().min(7, 'Phone number looks too short').max(30, 'Phone number too long').optional(),
      email: z.string().trim().email('A valid email is required').max(120, 'Email too long').optional(),
      idType: z.string().trim().max(30).optional(),
      idNumber: optionalText(40, 'ID number'),
    }),
    source: z.enum(SOURCES, { message: 'Invalid booking source' }).default('front_desk'),
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
  })
  .refine((v) => v.rooms.every((r) => r.departure > r.arrival), {
    message: 'departure must be after arrival',
    path: ['rooms'],
  });

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const listBookingsQuerySchema = z.object({
  search: optionalText(120, 'Search'),
  status: z.enum(['draft', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const cancelBookingSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(5, 'A reason of at least 5 characters is required')
      .max(500, 'Reason too long'),
  })
  .strict();

export const checkInBodySchema = z
  .object({
    overrideDepositReason: optionalText(200, 'Override reason'),
  })
  .strict();

export const checkoutBodySchema = z
  .object({
    earlyDeparture: isoDate.nullish(),
  })
  .strict();

export const recordPaymentSchema = paymentSchema
  .extend({
    idempotencyKey: optionalText(120, 'Idempotency key'),
  })
  .strict();

export const reversePaymentSchema = z
  .object({
    reason: z.string().trim().min(5, 'A reason of at least 5 characters is required').max(500, 'Reason too long'),
  })
  .strict();