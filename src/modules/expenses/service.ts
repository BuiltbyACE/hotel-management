/**
 * modules/expenses/service.ts
 *
 * Expense tracking (§14.2, spec A11/A12). Categories are seeded on first use
 * (the spec's 11 from Appendix D). Approval is a setting-gated workflow:
 * when `expense_approval_threshold` is 0, expenses are approved on record;
 * at/above the threshold they sit `recorded` until a manager approves or
 * rejects. Expenses feed maintenance_cost_view actual_cost via the optional
 * maintenanceIssueId link and are never mixed into revenue.
 */
import { eq } from 'drizzle-orm';
import { withDb, withTx, type Db, type Tx } from '@/core/db';
import { schema } from '@/core/db';
import { AppError } from '@/core/api';
import { nextNumberFast } from '@/core/db/sequence';
import { today } from '@/core/dates';
import { eventBus } from '@/core/events';
import { recordAudit, auditActor } from '@/modules/audit/service';
import type { Actor } from '@/modules/identity/auth-guard';
import type { CreateExpenseInput, UpdateExpenseInput, ListExpensesQuery, ApproveExpenseInput } from './validation';
import type { ExpenseStatus } from './types';
import {
  countExpenses,
  DEFAULT_CATEGORIES,
  ensureCategory,
  findCategoryById,
  findExpenseById,
  findMaintenanceIssue,
  findMaintenanceIssueReference,
  insertExpense,
  listCategories,
  listExpenses,
  lockExpenseForUpdate,
  readApprovalThreshold,
  softDeleteExpense,
  updateExpenseRow,
} from './repository';
import { EXPENSE_EVENTS } from './events';

export async function listExpenseCategories(actor: Actor) {
  const propertyId = requireProperty(actor);
  await withTx((tx) => seedDefaultCategories(tx, propertyId));
  return withDb((db) => listCategories(db, propertyId));
}

async function seedDefaultCategories(tx: Tx, propertyId: string): Promise<void> {
  for (const name of DEFAULT_CATEGORIES) {
    await ensureCategory(tx, { propertyId, name, description: null });
  }
}

async function resolveCategory(
  tx: Tx,
  input: { categoryId?: string; categoryName?: string | null },
  propertyId: string,
): Promise<string> {
  if (input.categoryId) {
    const cat = await findCategoryById(tx, input.categoryId);
    if (!cat) throw AppError.notFound('Expense category not found');
    if (cat.propertyId !== propertyId) throw AppError.badRequest('VALIDATION_ERROR', 'Category does not belong to this property');
    return cat.id;
  }
  const name = input.categoryName?.trim();
  if (!name) throw AppError.badRequest('VALIDATION_ERROR', 'A categoryId or categoryName is required');
  await seedDefaultCategories(tx, propertyId);
  return ensureCategory(tx, { propertyId, name, description: null });
}

export async function createExpense(input: CreateExpenseInput, actor: Actor) {
  const propertyId = requireProperty(actor);

  const { reference } = await nextNumberFast(propertyId, 'expense', {
    prefix: 'EX-',
    period: today().slice(0, 4),
  });

  const expenseId = await withTx(async (tx) => {
    if (input.maintenanceIssueId) {
      const issue = await findMaintenanceIssue(tx, input.maintenanceIssueId);
      if (!issue || issue.propertyId !== propertyId) {
        throw AppError.badRequest('VALIDATION_ERROR', 'Maintenance issue not found for this property');
      }
    }

    const categoryId = await resolveCategory(tx, input, propertyId);

    const threshold = await readApprovalThreshold(tx);
    const status: ExpenseStatus = threshold > 0 && Number(input.amount) >= threshold ? 'recorded' : 'approved';

    const expense = await insertExpense(tx, {
      propertyId,
      reference,
      categoryId,
      maintenanceIssueId: input.maintenanceIssueId ?? null,
      description: input.description,
      amount: input.amount,
      expenseDate: input.expenseDate ?? today(),
      method: input.method ?? 'cash',
      referenceNumber: input.referenceNumber ?? null,
      vendor: input.vendor ?? null,
      status,
      receiptFileId: input.receiptFileId ?? null,
      recordedBy: actor.id,
    });

    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'expense.create',
      entityType: 'expense',
      entityId: expense.id,
      summary: `Expense ${reference} of ${expense.amount} recorded${input.maintenanceIssueId ? ' (maintenance)' : ''}`,
    });

    await eventBus.emit(EXPENSE_EVENTS.expenseCreated, {
      expenseId: expense.id,
      reference,
      propertyId,
      amount: expense.amount,
      status,
      by: actor.email,
    });

    return expense.id;
  });

  return getExpense(expenseId, actor);
}

export async function updateExpense(id: string, input: UpdateExpenseInput, actor: Actor) {
  const propertyId = requireProperty(actor);

  await withTx(async (tx) => {
    const expense = await lockExpenseForUpdate(tx, id);
    if (!expense || expense.propertyId !== propertyId) throw AppError.notFound('Expense not found');
    if (expense.status === 'approved') {
      throw AppError.badRequest('INVALID_TRANSITION', 'Approved expenses cannot be edited');
    }

    let categoryId = input.categoryId;
    if (input.categoryId) {
      categoryId = await resolveCategory(tx, { categoryId: input.categoryId }, propertyId);
    }

    await updateExpenseRow(tx, id, {
      categoryId,
      description: input.description,
      amount: input.amount,
      expenseDate: input.expenseDate,
      method: input.method,
      referenceNumber: input.referenceNumber ?? expense.referenceNumber,
      vendor: input.vendor ?? expense.vendor,
      receiptFileId: input.receiptFileId ?? expense.receiptFileId,
    });

    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'expense.update',
      entityType: 'expense',
      entityId: expense.id,
      summary: `Expense ${expense.reference} updated`,
    });

    await eventBus.emit(EXPENSE_EVENTS.expenseUpdated, {
      expenseId: expense.id,
      reference: expense.reference,
      propertyId,
      amount: input.amount ?? expense.amount,
      by: actor.email,
    });
  });

  return getExpense(id, actor);
}

export async function approveExpense(id: string, input: ApproveExpenseInput, actor: Actor) {
  const propertyId = requireProperty(actor);

  await withTx(async (tx) => {
    const expense = await lockExpenseForUpdate(tx, id);
    if (!expense || expense.propertyId !== propertyId) throw AppError.notFound('Expense not found');
    if (expense.status !== 'recorded') {
      throw AppError.badRequest('INVALID_TRANSITION', `Cannot approve an expense that is ${expense.status}`);
    }

    await updateExpenseRow(tx, id, {
      status: input.status,
      approvedBy: actor.id,
      approvedAt: new Date(),
      rejectionReason: input.status === 'rejected' ? ('rejectionReason' in input ? input.rejectionReason : null) : null,
    });

    const rejectionReason = 'rejectionReason' in input ? input.rejectionReason : null;

    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: input.status === 'approved' ? 'expense.approve' : 'expense.reject',
      entityType: 'expense',
      entityId: expense.id,
      summary: `Expense ${expense.reference} ${input.status}${rejectionReason ? `: ${rejectionReason}` : ''}`,
    });

    await eventBus.emit(
      input.status === 'approved' ? EXPENSE_EVENTS.expenseApproved : EXPENSE_EVENTS.expenseRejected,
      {
        expenseId: expense.id,
        reference: expense.reference,
        propertyId,
        amount: expense.amount,
        status: input.status,
        by: actor.email,
      },
    );
  });

  return getExpense(id, actor);
}

export async function deleteExpense(id: string, actor: Actor) {
  const propertyId = requireProperty(actor);

  await withTx(async (tx) => {
    const expense = await lockExpenseForUpdate(tx, id);
    if (!expense || expense.propertyId !== propertyId) throw AppError.notFound('Expense not found');

    await softDeleteExpense(tx, id);

    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'expense.delete',
      entityType: 'expense',
      entityId: expense.id,
      summary: `Expense ${expense.reference} deleted`,
    });

    await eventBus.emit(EXPENSE_EVENTS.expenseDeleted, {
      expenseId: expense.id,
      reference: expense.reference,
      propertyId,
      amount: expense.amount,
      by: actor.email,
    });
  });
}

export async function getExpense(id: string, actor: Actor) {
  const propertyId = requireProperty(actor);
  return withDb(async (db) => {
    const expense = await findExpenseById(db, id);
    if (!expense || expense.propertyId !== propertyId) throw AppError.notFound('Expense not found');
    return toExpenseView(db, expense);
  });
}

async function toExpenseView(db: Db, expense: NonNullable<Awaited<ReturnType<typeof findExpenseById>>>) {
  const [category] = await db
    .select({ name: schema.expenseCategories.name })
    .from(schema.expenseCategories)
    .where(eq(schema.expenseCategories.id, expense.categoryId));
  const maintenanceReference = expense.maintenanceIssueId
    ? await findMaintenanceIssueReference(db, expense.maintenanceIssueId)
    : null;
  return {
    id: expense.id,
    reference: expense.reference,
    categoryId: expense.categoryId,
    categoryName: category?.name ?? 'Unknown',
    maintenanceIssueId: expense.maintenanceIssueId,
    maintenanceReference,
    description: expense.description,
    amount: expense.amount,
    expenseDate: expense.expenseDate,
    method: expense.method,
    referenceNumber: expense.referenceNumber,
    vendor: expense.vendor,
    status: expense.status,
    receiptFileId: expense.receiptFileId,
    recordedBy: expense.recordedBy,
    approvedBy: expense.approvedBy,
    approvedAt: expense.approvedAt?.toISOString() ?? null,
    rejectionReason: expense.rejectionReason,
    createdAt: expense.createdAt.toISOString(),
  };
}

export interface ExpenseListResult {
  data: Awaited<ReturnType<typeof getExpense>>[];
  total: number;
}

export async function listExpensesService(query: ListExpensesQuery, actor: Actor): Promise<ExpenseListResult> {
  const propertyId = requireProperty(actor);
  const filters = {
    propertyId,
    status: query.status,
    categoryId: query.categoryId,
    fromDate: query.fromDate,
    toDate: query.toDate,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
  const [rows, total] = await Promise.all([
    withDb((db) => listExpenses(db, filters)),
    withDb((db) => countExpenses(db, filters)),
  ]);
  const data: Awaited<ReturnType<typeof getExpense>>[] = rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    maintenanceIssueId: r.maintenanceIssueId,
    maintenanceReference: r.maintenanceReference,
    description: r.description,
    amount: r.amount,
    expenseDate: r.expenseDate,
    method: r.method,
    referenceNumber: r.referenceNumber,
    vendor: r.vendor,
    status: r.status,
    receiptFileId: r.receiptFileId,
    recordedBy: r.recordedBy,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    rejectionReason: r.rejectionReason,
    createdAt: r.createdAt.toISOString(),
  }));
  return { data, total };
}

function requireProperty(actor: Actor): string {
  if (!actor.propertyId) throw AppError.forbidden('FORBIDDEN', 'Actor is not bound to a property');
  return actor.propertyId;
}