/**
 * GET /api/v1/frontdesk/in-house → bookings.read
 * Rooms occupied right now (checked-in allocations).
 */
import { apiHandler, ok } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { inHouseOn } from '@/modules/frontdesk/service';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const rows = await inHouseOn(actor);
  return ok({ data: rows });
});

export const runtime = 'nodejs';