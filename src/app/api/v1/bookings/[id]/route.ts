/**
 * GET /api/v1/bookings/{id} → bookings.read (booking + allocations + payments)
 */
import { apiHandler, ok } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getBookingDetail } from '@/modules/bookings/service';

function idFromUrl(url: string): string {
  const id = new URL(url).pathname.split('/').pop();
  if (!id) throw AppError.badRequest();
  return id;
}

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const detail = await getBookingDetail(idFromUrl(req.url), actor);
  return ok(detail);
});

export const runtime = 'nodejs';