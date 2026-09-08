/**
 * modules/availability/validation.ts
 *
 * Route-facing Zod schemas for the four read/quote endpoints.
 * `arrival < departure` is enforced so the ledger overlap test is well-formed.
 */
import { z } from 'zod';

const isoDate = z
  .string({ message: 'Date must be a string' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');

function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
}

const rangeRules = z.object({
  arrival: isoDate,
  departure: isoDate,
});

export const findRoomsQuerySchema = rangeRules
  .extend({
    roomTypeId: z.uuid('Invalid room type id').optional(),
    occupancy: z.coerce.number().int().min(1).max(20).optional(),
    excludeBookingId: z.uuid('Invalid booking id').optional(),
  })
  .refine((v) => nightsBetween(v.arrival, v.departure) > 0 && nightsBetween(v.arrival, v.departure) <= 366, {
    message: 'departure must be after arrival (and within 366 nights)',
    path: ['departure'],
  });

export type FindRoomsInput = z.infer<typeof findRoomsQuerySchema>;

export const calendarQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    roomTypeId: z.uuid('Invalid room type id').optional(),
  })
  .refine((v) => nightsBetween(v.from, v.to) > 0 && nightsBetween(v.from, v.to) <= 366, {
    message: 'to must be after from (and within 366 nights)',
    path: ['to'],
  });

export type CalendarInput = z.infer<typeof calendarQuerySchema>;

export const tapeQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
  })
  .refine((v) => nightsBetween(v.from, v.to) > 0 && nightsBetween(v.from, v.to) <= 366, {
    message: 'to must be after from (and within 366 nights)',
    path: ['to'],
  });

export type TapeInput = z.infer<typeof tapeQuerySchema>;

export const quoteBodySchema = z
  .object({
    roomTypeId: z.uuid('Invalid room type id'),
    arrival: isoDate,
    departure: isoDate,
    adults: z.coerce.number().int().min(1).max(20).default(1),
    children: z.coerce.number().int().min(0).max(20).default(0),
  })
  .refine((v) => nightsBetween(v.arrival, v.departure) > 0 && nightsBetween(v.arrival, v.departure) <= 366, {
    message: 'departure must be after arrival (and within 366 nights)',
    path: ['departure'],
  });

export type QuoteBodyInput = z.infer<typeof quoteBodySchema>;