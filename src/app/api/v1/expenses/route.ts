/**
 * GET/POST /api/v1/expenses → expenses.read / expenses.create
 * Expense list (filterable) and record-expense flow (§14.2, spec A11/A12).
 */
import { apiHandler, created, okPaginated, validateBody, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { createExpense, listExpensesService } from '@/modules/expenses/service';
import { createExpenseSchema, listExpensesQuerySchema } from '@/modules/expenses/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'expenses.read');
  const q = validateQuery(new URL(req.url), listExpensesQuerySchema);
  const { data, total } = await listExpensesService(q, actor);
  return okPaginated({ data }, { page: q.page, pageSize: q.pageSize, total });
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'expenses.create');
  const input = await validateBody(req, createExpenseSchema);
  const expense = await createExpense(input, actor);
  return created({ data: expense });
});

export const runtime = 'nodejs';