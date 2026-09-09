/**
 * GET /api/v1/reports/occupancy?from=&to=&groupBy=day|week|month → reports.financial
 * Occupancy %, rooms sold, ADR, RevPAR from frozen daily_stats (§18.2).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { occupancyReport } from '@/modules/reporting/service';
import { occupancyQuerySchema } from '@/modules/reporting/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.financial');
  const q = validateQuery(new URL(req.url), occupancyQuerySchema);
  return ok(await occupancyReport(q, actor));
});

export const runtime = 'nodejs';