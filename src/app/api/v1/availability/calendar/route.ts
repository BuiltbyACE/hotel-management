/**
 * GET /api/v1/availability/calendar → bookings.read
 * Per room-type per-day availability counts for [from, to).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getCalendar } from '@/modules/availability/service';
import { calendarQuerySchema } from '@/modules/availability/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const q = validateQuery(new URL(req.url), calendarQuerySchema);
  const rows = await getCalendar(q.from, q.to, q.roomTypeId, actor);
  return ok({ data: rows });
});

export const runtime = 'nodejs';