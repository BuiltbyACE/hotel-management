/**
 * modules/expenses/repository.ts
 *
 * SQL for the expense module. Owned tables: expense_categories, expenses.
 * The maintenance_issues read (for a linked expense's reference) and the
 * settings read go through the schema barrel like every other module.
 */
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { type Db, type Tx } from '@/core/db';
import { schema } from '@/core/db';
import type { ExpenseMethod, ExpenseStatus } from './types';

/** The spec's 11 seeded categories (blueprint Appendix D). */
export const DEFAULT_CATEGORIES = [
  'Maintenance and Repairs',
  'Electricity and Utilities',
  'Water',
  'Internet and Communication',
  'Cleaning Supplies',
  'Hotel Supplies',
  'Furniture and Equipment',
  'Transport',
  'Marketing',
  'Licenses and Administration',
  'Miscellaneous Expenses',
] as const;

/** Approval setting lives in `settings` (Appendix B: expense_approval_threshold). */
export async function readApprovalThreshold(db: Db | Tx): Promise<number> {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, 'expense_approval_threshold'));
  const raw = row?.value;
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function listCategoryNames(db: Db | Tx, propertyId: string): Promise<string[]> {
  const rows = await db
    .select({ name: schema.expenseCategories.name })
    .from(schema.expenseCategories)
    .where(and(eq(schema.expenseCategories.propertyId, propertyId), isNull(schema.expenseCategories.deletedAt)));
  return rows.map((r) => r.name);
}

export async function ensureCategory(
  tx: Tx,
  row: { propertyId: string; name: string; description: string | null },
): Promise<string> {
  const [existing] = await tx
    .select({ id: schema.expenseCategories.id })
    .from(schema.expenseCategories)
    .where(
      and(
        eq(schema.expenseCategories.propertyId, row.propertyId),
        sql`lower(${schema.expenseCategories.name}) = lower(${row.name})`,
        isNull(schema.expenseCategories.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const rows = await tx
    .insert(schema.expenseCategories)
    .values({ ...row, description: row.description ?? null })
    .returning({ id: schema.expenseCategories.id });
  return rows[0]!.id;
}

export async function findCategoryById(db: Db | Tx, id: string) {
  const rows = await db.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.deletedAt !== null) return undefined;
  return row;
}

export async function listCategories(db: Db, propertyId: string) {
  return db
    .select()
    .from(schema.expenseCategories)
    .where(and(eq(schema.expenseCategories.propertyId, propertyId), isNull(schema.expenseCategories.deletedAt)))
    .orderBy(schema.expenseCategories.name);
}

export interface ExpenseRow {
  id: string;
  propertyId: string;
  reference: string;
  categoryId: string;
  maintenanceIssueId: string | null;
  description: string;
  amount: string;
  expenseDate: string;
  method: ExpenseMethod;
  referenceNumber: string | null;
  vendor: string | null;
  status: ExpenseStatus;
  receiptFileId: string | null;
  recordedBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export async function insertExpense(
  tx: Tx,
  row: {
    propertyId: string;
    reference: string;
    categoryId: string;
    maintenanceIssueId: string | null;
    description: string;
    amount: string;
    expenseDate: string;
    method: ExpenseMethod;
    referenceNumber: string | null;
    vendor: string | null;
    status: ExpenseStatus;
    receiptFileId: string | null;
    recordedBy: string;
  },
): Promise<ExpenseRow> {
  const rows = await tx.insert(schema.expenses).values(row).returning();
  return rows[0]!;
}

export async function findExpenseById(db: Db | Tx, id: string): Promise<ExpenseRow | undefined> {
  const rows = await db
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.id, id), isNull(schema.expenses.deletedAt)))
    .limit(1);
  return rows[0];
}

export async function lockExpenseForUpdate(tx: Tx, id: string): Promise<ExpenseRow | undefined> {
  const rows = await tx
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.id, id), isNull(schema.expenses.deletedAt)))
    .for('update')
    .limit(1);
  return rows[0];
}

export async function updateExpenseRow(
  tx: Tx,
  id: string,
  patch: {
    categoryId?: string;
    description?: string;
    amount?: string;
    expenseDate?: string;
    method?: ExpenseMethod;
    referenceNumber?: string | null;
    vendor?: string | null;
    receiptFileId?: string | null;
    status?: ExpenseStatus;
    approvedBy?: string | null;
    approvedAt?: Date | null;
    rejectionReason?: string | null;
  },
): Promise<ExpenseRow> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) safe[key] = value;
  }
  const rows = await tx.update(schema.expenses).set(safe as never).where(eq(schema.expenses.id, id)).returning();
  return rows[0]!;
}

export async function softDeleteExpense(tx: Tx, id: string): Promise<void> {
  await tx.update(schema.expenses).set({ deletedAt: new Date() }).where(eq(schema.expenses.id, id));
}

export interface ExpenseFilters {
  propertyId: string;
  status?: ExpenseStatus;
  categoryId?: string;
  fromDate?: string;
  toDate?: string;
  limit: number;
  offset: number;
}

function expenseWhere(f: ExpenseFilters): SQL[] {
  const clauses: SQL[] = [
    eq(schema.expenses.propertyId, f.propertyId),
    isNull(schema.expenses.deletedAt),
  ];
  if (f.status) clauses.push(eq(schema.expenses.status, f.status));
  if (f.categoryId) clauses.push(eq(schema.expenses.categoryId, f.categoryId));
  if (f.fromDate) clauses.push(gte(schema.expenses.expenseDate, f.fromDate));
  if (f.toDate) clauses.push(lte(schema.expenses.expenseDate, f.toDate));
  return clauses;
}

export interface ExpenseListRow {
  id: string;
  reference: string;
  categoryId: string;
  categoryName: string;
  maintenanceIssueId: string | null;
  maintenanceReference: string | null;
  description: string;
  amount: string;
  expenseDate: string;
  method: ExpenseMethod;
  referenceNumber: string | null;
  vendor: string | null;
  status: ExpenseStatus;
  receiptFileId: string | null;
  recordedBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
}

const listColumns = {
  id: schema.expenses.id,
  reference: schema.expenses.reference,
  categoryId: schema.expenses.categoryId,
  categoryName: schema.expenseCategories.name,
  maintenanceIssueId: schema.expenses.maintenanceIssueId,
  maintenanceReference: schema.maintenanceIssues.reference,
  description: schema.expenses.description,
  amount: schema.expenses.amount,
  expenseDate: schema.expenses.expenseDate,
  method: schema.expenses.method,
  referenceNumber: schema.expenses.referenceNumber,
  vendor: schema.expenses.vendor,
  status: schema.expenses.status,
  receiptFileId: schema.expenses.receiptFileId,
  recordedBy: schema.expenses.recordedBy,
  approvedBy: schema.expenses.approvedBy,
  approvedAt: schema.expenses.approvedAt,
  rejectionReason: schema.expenses.rejectionReason,
  createdAt: schema.expenses.createdAt,
};

export async function listExpenses(db: Db, f: ExpenseFilters): Promise<ExpenseListRow[]> {
  return db
    .select(listColumns)
    .from(schema.expenses)
    .innerJoin(schema.expenseCategories, eq(schema.expenseCategories.id, schema.expenses.categoryId))
    .leftJoin(schema.maintenanceIssues, eq(schema.maintenanceIssues.id, schema.expenses.maintenanceIssueId))
    .where(and(...expenseWhere(f)))
    .orderBy(desc(schema.expenses.expenseDate), desc(schema.expenses.createdAt))
    .limit(f.limit)
    .offset(f.offset);
}

export async function countExpenses(db: Db, f: ExpenseFilters): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.expenses)
    .where(and(...expenseWhere(f)));
  return rows[0]?.n ?? 0;
}

export async function findMaintenanceIssue(db: Db | Tx, id: string) {
  const rows = await db.select().from(schema.maintenanceIssues).where(eq(schema.maintenanceIssues.id, id)).limit(1);
  return rows[0];
}

export async function findMaintenanceIssueReference(db: Db | Tx, id: string): Promise<string | null> {
  const rows = await db
    .select({ reference: schema.maintenanceIssues.reference })
    .from(schema.maintenanceIssues)
    .where(eq(schema.maintenanceIssues.id, id))
    .limit(1);
  return rows[0]?.reference ?? null;
}