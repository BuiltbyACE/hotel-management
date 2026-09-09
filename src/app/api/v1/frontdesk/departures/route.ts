/**
 * GET /api/v1/frontdesk/departures?date= → bookings.read
 * Rooms due out on `date` (still in-house or already checked out today).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { today } from '@/core/dates';
import { requirePermission } from '@/modules/identity/auth-guard';
import { departuresOn } from '@/modules/frontdesk/service';
import { dateQuerySchema } from '@/modules/frontdesk/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const q = validateQuery(new URL(req.url), dateQuerySchema);
  const rows = await departuresOn(q.date ?? today(), actor);
  return ok({ data: rows });
});

export const runtime = 'nodejs';