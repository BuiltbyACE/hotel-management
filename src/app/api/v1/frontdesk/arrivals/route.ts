/**
 * GET /api/v1/frontdesk/arrivals?date= → bookings.read
 * Bookings whose rooms are expected to check in on `date`.
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { today } from '@/core/dates';
import { requirePermission } from '@/modules/identity/auth-guard';
import { arrivalsOn } from '@/modules/frontdesk/service';
import { dateQuerySchema } from '@/modules/frontdesk/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const q = validateQuery(new URL(req.url), dateQuerySchema);
  const rows = await arrivalsOn(q.date ?? today(), actor);
  return ok({ data: rows });
});

export const runtime = 'nodejs';