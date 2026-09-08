/**
 * GET /api/v1/availability/tape → bookings.read
 * The rooms × dates grid: every room's status for [from, to).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getTape } from '@/modules/availability/service';
import { tapeQuerySchema } from '@/modules/availability/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const q = validateQuery(new URL(req.url), tapeQuerySchema);
  const rows = await getTape(q.from, q.to, actor);
  return ok({ data: rows });
});

export const runtime = 'nodejs';