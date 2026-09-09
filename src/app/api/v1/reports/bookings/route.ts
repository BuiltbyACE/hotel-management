/**
 * GET /api/v1/reports/bookings?from=&to=&groupBy=day|week|month|source → reports.financial
 * Realized bookings by arrival period or source (§18.2). Rate-limited to
 * 20/min per user (bucket report:<userId>, §20.4).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { enforceRateLimit } from '@/core/rate-limit';
import { requirePermission } from '@/modules/identity/auth-guard';
import { bookingsReport } from '@/modules/reporting/service';
import { bookingsQuerySchema } from '@/modules/reporting/validation';

const REPORT_MAX = 20;
const REPORT_WINDOW_SECONDS = 60;

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.financial');
  await enforceRateLimit(`report:${actor.id}`, { max: REPORT_MAX, windowSeconds: REPORT_WINDOW_SECONDS });
  const q = validateQuery(new URL(req.url), bookingsQuerySchema);
  return ok(await bookingsReport(q, actor));
});

export const runtime = 'nodejs';