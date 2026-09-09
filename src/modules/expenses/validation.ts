/**
 * modules/expenses/validation.ts
 *
 * Route-facing Zod schemas for expenses (§14.2, spec A11/A12). The amount vs
 * approval-threshold rule lives in the service so it can read the setting.
 */
import { z } from 'zod';

const uuid = z.uuid('A valid id is required');
const isoDate = z
  .string({ message: 'Date must be a string' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');
const optionalText = (max: number, label = 'text') =>
  z.string({ message: `${label} must be a string` }).trim().max(max, `${label} too long`).nullish();
const amount = z
  .string({ message: 'Amount is required' })
  .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal like 18500.00')
  .refine((v) => Number(v) > 0, 'Amount must be positive');

const METHODS = ['cash', 'mpesa', 'card', 'bank_transfer', 'cheque', 'other'] as const;

export const createExpenseSchema = z
  .object({
    description: z
      .string({ message: 'Description is required' })
      .trim()
      .min(1, 'Description is required')
      .max(500, 'Description too long'),
    amount,
    expenseDate: isoDate.optional(),
    method: z.enum(METHODS).optional(),
    referenceNumber: optionalText(80, 'Reference number'),
    vendor: optionalText(200, 'Vendor'),
    categoryId: uuid.optional(),
    categoryName: optionalText(120, 'Category name'),
    maintenanceIssueId: uuid.optional(),
    receiptFileId: uuid.optional(),
  })
  .refine((v) => v.categoryId !== undefined || v.categoryName !== undefined, {
    message: 'A categoryId or categoryName is required',
    path: ['categoryId'],
  });

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = z
  .object({
    description: z.string().trim().min(1, 'Description is required').max(500, 'Description too long').optional(),
    amount: amount.optional(),
    expenseDate: isoDate.optional(),
    method: z.enum(METHODS).optional(),
    referenceNumber: optionalText(80, 'Reference number'),
    vendor: optionalText(200, 'Vendor'),
    categoryId: uuid.optional(),
    receiptFileId: uuid.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update', path: ['amount'] });

export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

const approveSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved') }),
  z.object({
    status: z.literal('rejected'),
    rejectionReason: z.string({ message: 'A rejection reason is required' }).trim().min(1, 'A rejection reason is required').max(500, 'Rejection reason too long'),
  }),
]);

export const approveExpenseSchema = approveSchema;
export type ApproveExpenseInput = z.infer<typeof approveExpenseSchema>;

/** One PATCH body for expenses: either an approval/rejection or an edit. */
export const expensePatchSchema = z.union([approveSchema, updateExpenseSchema]);
export type ExpensePatchInput = z.infer<typeof expensePatchSchema>;

export const listExpensesQuerySchema = z.object({
  status: z.enum(['recorded', 'approved', 'rejected'] as const).optional(),
  categoryId: uuid.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;