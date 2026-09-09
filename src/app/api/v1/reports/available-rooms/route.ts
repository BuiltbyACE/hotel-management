/**
 * GET /api/v1/reports/available-rooms?date=YYYY-MM-DD → reports.operational
 * As-of available/occupied/out-of-order snapshot from the allocation ledger (§18.2).
 * Rate-limited to 20/min per user (bucket report:<userId>, §20.4).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { enforceRateLimit } from '@/core/rate-limit';
import { requirePermission } from '@/modules/identity/auth-guard';
import { availableRoomsSnapshot } from '@/modules/reporting/service';
import { availabilityQuerySchema } from '@/modules/reporting/validation';

const REPORT_MAX = 20;
const REPORT_WINDOW_SECONDS = 60;

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.operational');
  await enforceRateLimit(`report:${actor.id}`, { max: REPORT_MAX, windowSeconds: REPORT_WINDOW_SECONDS });
  const q = validateQuery(new URL(req.url), availabilityQuerySchema);
  return ok(await availableRoomsSnapshot(q, actor));
});

export const runtime = 'nodejs';