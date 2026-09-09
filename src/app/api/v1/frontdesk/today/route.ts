/**
 * GET /api/v1/frontdesk/today?date= → bookings.read
 * At-a-glance board: arrivals, departures, in-house, occupancy for a date.
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { today } from '@/core/dates';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getTodaySummary } from '@/modules/frontdesk/service';
import { dateQuerySchema } from '@/modules/frontdesk/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const q = validateQuery(new URL(req.url), dateQuerySchema);
  const summary = await getTodaySummary(q.date ?? today(), actor);
  return ok(summary);
});

export const runtime = 'nodejs';