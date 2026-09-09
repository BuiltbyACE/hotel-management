/**
 * GET /api/v1/reports/profit-summary?from=&to= → reports.financial
 * Revenue − expenses with margin %, monthly, from frozen daily_stats (§18.2).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { profitSummaryReport } from '@/modules/reporting/service';
import { profitSummaryQuerySchema } from '@/modules/reporting/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.financial');
  const q = validateQuery(new URL(req.url), profitSummaryQuerySchema);
  return ok(await profitSummaryReport(q, actor));
});

export const runtime = 'nodejs';