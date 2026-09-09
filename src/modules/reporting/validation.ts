/**
 * modules/reporting/validation.ts
 *
 * Query-parameter schemas for the report endpoints (§18.2). All date params
 * are YYYY-MM-DD; `from` must not be after `to`. Defaults (rolling windows)
 * live in the service, not in the schema, so the API stays explicit.
 */
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');

/** A bounded from/to window. Both optional; from ≤ to when both given. */
export const rangeQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'from must not be after to',
    path: ['from'],
  });
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

export const occupancyQuerySchema = rangeQuerySchema.extend({
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
});
export type OccupancyQuery = z.infer<typeof occupancyQuerySchema>;

export const revenueQuerySchema = rangeQuerySchema.extend({
  breakdown: z.enum(['roomType', 'source', 'method']).optional(),
});
export type RevenueQuery = z.infer<typeof revenueQuerySchema>;

export const dateQuerySchema = z.object({
  date: isoDate.optional(),
});
export type DateQuery = z.infer<typeof dateQuerySchema>;

export const expensesQuerySchema = rangeQuerySchema.extend({
  groupBy: z.enum(['category', 'month']).default('category'),
});
export type ExpensesQuery = z.infer<typeof expensesQuerySchema>;

export const maintenanceCostsQuerySchema = rangeQuerySchema;
export type MaintenanceCostsQuery = z.infer<typeof maintenanceCostsQuerySchema>;

export const profitSummaryQuerySchema = rangeQuerySchema;
export type ProfitSummaryQuery = z.infer<typeof profitSummaryQuerySchema>;