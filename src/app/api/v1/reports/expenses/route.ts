/**
 * GET /api/v1/reports/expenses?from=&to=&groupBy=category|month → reports.financial
 * Expenses by category with MoM change against the prior window (§18.2).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { expensesReport } from '@/modules/reporting/service';
import { expensesQuerySchema } from '@/modules/reporting/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.financial');
  const q = validateQuery(new URL(req.url), expensesQuerySchema);
  return ok(await expensesReport(q, actor));
});

export const runtime = 'nodejs';