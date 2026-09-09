/**
 * modules/housekeeping/validation.ts
 *
 * Route-facing Zod schemas for the housekeeping board (§13.4). The housekeeping
 * and condition enums are mirrored here from the rooms DDL so the module stays
 * boundary-clean — property's validation.ts is not importable cross-module.
 */
import { z } from 'zod';

const isoDate = z
  .string({ message: 'Date must be a string' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');

export const boardQuerySchema = z.object({
  date: isoDate.optional(),
});

export type BoardQuery = z.infer<typeof boardQuerySchema>;

export const updateHousekeepingSchema = z
  .object({
    housekeeping: z
      .enum(['clean', 'dirty', 'inspected', 'out_of_service'], { message: 'Invalid housekeeping status' })
      .optional(),
    condition: z
      .enum(['available', 'occupied', 'cleaning', 'maintenance', 'out_of_order'], { message: 'Invalid condition' })
      .optional(),
  })
  .strict()
  .refine((v) => v.housekeeping !== undefined || v.condition !== undefined, {
    message: 'Provide housekeeping and/or condition',
  });

export type UpdateHousekeepingInput = z.infer<typeof updateHousekeepingSchema>;