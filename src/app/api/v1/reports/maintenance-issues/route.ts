/**
 * GET /api/v1/reports/maintenance-issues?from=&to= → reports.financial
 * Open/closed issues, by priority, with mean time-to-resolve (§18.2).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { maintenanceIssuesReport } from '@/modules/reporting/service';
import { maintenanceIssuesQuerySchema } from '@/modules/reporting/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.financial');
  const q = validateQuery(new URL(req.url), maintenanceIssuesQuerySchema);
  return ok(await maintenanceIssuesReport(q, actor));
});

export const runtime = 'nodejs';