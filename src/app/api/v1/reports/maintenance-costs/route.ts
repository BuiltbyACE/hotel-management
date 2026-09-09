/**
 * GET /api/v1/reports/maintenance-costs?from=&to= → reports.financial
 * Estimated vs actual cost per issue from the maintenance cost view (§18.2).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { maintenanceCostsReport } from '@/modules/reporting/service';
import { maintenanceCostsQuerySchema } from '@/modules/reporting/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.financial');
  const q = validateQuery(new URL(req.url), maintenanceCostsQuerySchema);
  return ok(await maintenanceCostsReport(q, actor));
});

export const runtime = 'nodejs';