/**
 * GET /api/v1/reports/arrivals-departures?date= → reports.operational
 * Expected arrivals and departures for one business date (§18.2).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { today } from '@/core/dates';
import { requirePermission } from '@/modules/identity/auth-guard';
import { arrivalsDeparturesReport } from '@/modules/reporting/service';
import { dateQuerySchema } from '@/modules/reporting/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.operational');
  const q = validateQuery(new URL(req.url), dateQuerySchema);
  return ok(await arrivalsDeparturesReport(q.date ?? today(), actor));
});

export const runtime = 'nodejs';