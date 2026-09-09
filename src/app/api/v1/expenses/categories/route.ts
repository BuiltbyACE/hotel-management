/**
 * GET /api/v1/expenses/categories → expenses.read
 * The expense category picker; the spec's 11 defaults are seeded on first use.
 */
import { apiHandler, ok } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { listExpenseCategories } from '@/modules/expenses/service';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'expenses.read');
  const categories = await listExpenseCategories(actor);
  return ok({ data: categories });
});

export const runtime = 'nodejs';