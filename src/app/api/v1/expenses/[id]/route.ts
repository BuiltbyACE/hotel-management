/**
 * GET/PATCH/DELETE /api/v1/expenses/{id} → expenses.read / update|approve /
 * delete. PATCH with a `status` is the manager approval path (expenses.approve);
 * anything else edits (expenses.update). Expense rows are soft-deleted so
 * maintenance_cost_view and reports keep their audit history.
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { approveExpense, deleteExpense, getExpense, updateExpense } from '@/modules/expenses/service';
import { expensePatchSchema } from '@/modules/expenses/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'expenses.read');
  const expense = await getExpense(idFromUrl(req), actor);
  return ok({ data: expense });
});

export const PATCH = apiHandler(async (req) => {
  const id = idFromUrl(req);
  const patch = await validateBody(req, expensePatchSchema);
  if ('status' in patch) {
    const actor = await requirePermission(req, 'expenses.approve');
    const expense = await approveExpense(id, patch, actor);
    return ok({ data: expense });
  }
  const actor = await requirePermission(req, 'expenses.update');
  const expense = await updateExpense(id, patch, actor);
  return ok({ data: expense });
});

export const DELETE = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'expenses.delete');
  await deleteExpense(idFromUrl(req), actor);
  return ok({ data: { deleted: true } });
});

function idFromUrl(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 1];
  if (!id) throw AppError.badRequest('VALIDATION_ERROR', 'Expense id is required');
  return id;
}

export const runtime = 'nodejs';