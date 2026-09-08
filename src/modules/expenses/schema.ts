/**
 * modules/expenses/schema.ts
 *
 * Expense tracking (the cost side of the ledger). Owned tables (blueprint
 * §5.1): expense_categories, expenses.
 *
 * Mirror of drizzle/0001_full_schema.sql §8. payment_method is re-declared
 * here (same name/values as billing's) because the module boundary rules
 * forbid this module from importing billing's schema — Postgres resolves the
 * shared type by name. receipt_file_id → files and the user FKs are SQL-only.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const expenseStatus = pgEnum('expense_status', ['recorded', 'approved', 'rejected']);
export const paymentMethod = pgEnum('payment_method', ['cash', 'mpesa', 'card', 'bank_transfer', 'cheque', 'other']);

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('expense_categories_uq')
      .on(sql`${t.propertyId}, lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    reference: text('reference').notNull(),
    categoryId: uuid('category_id').notNull(),
    maintenanceIssueId: uuid('maintenance_issue_id'),
    description: text('description').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    expenseDate: date('expense_date', { mode: 'string' }).notNull(),
    method: paymentMethod('method').notNull(),
    referenceNumber: text('reference_number'),
    vendor: text('vendor'),
    status: expenseStatus('status').notNull().default('recorded'),
    receiptFileId: uuid('receipt_file_id'),
    recordedBy: uuid('recorded_by').notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('expenses_amount_gt0', sql`${t.amount} > 0`),
    uniqueIndex('expenses_reference_uq').on(t.propertyId, t.reference),
    index('expenses_date_idx').on(t.propertyId, t.expenseDate, t.categoryId).where(sql`${t.deletedAt} IS NULL`),
    index('expenses_maintenance_idx').on(t.maintenanceIssueId).where(sql`${t.maintenanceIssueId} IS NOT NULL`),
  ],
);