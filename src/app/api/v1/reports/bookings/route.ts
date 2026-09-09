/**
 * GET /api/v1/reports/bookings?from=&to=&groupBy=day|week|month|source → reports.financial
 * Realized bookings by arrival period or source (§18.2).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { bookingsReport } from '@/modules/reporting/service';
import { bookingsQuerySchema } from '@/modules/reporting/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.financial');
  const q = validateQuery(new URL(req.url), bookingsQuerySchema);
  return ok(await bookingsReport(q, actor));
});

export const runtime = 'nodejs';