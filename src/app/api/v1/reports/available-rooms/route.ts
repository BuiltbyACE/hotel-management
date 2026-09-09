/**
 * GET /api/v1/reports/available-rooms?date=YYYY-MM-DD → reports.operational
 * As-of available/occupied/out-of-order snapshot from the allocation ledger (§18.2).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { availableRoomsSnapshot } from '@/modules/reporting/service';
import { availabilityQuerySchema } from '@/modules/reporting/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.operational');
  const q = validateQuery(new URL(req.url), availabilityQuerySchema);
  return ok(await availableRoomsSnapshot(q, actor));
});

export const runtime = 'nodejs';