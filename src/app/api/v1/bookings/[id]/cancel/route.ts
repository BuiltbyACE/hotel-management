/**
 * POST /api/v1/bookings/{id}/cancel → bookings.cancel
 * Body: { reason }
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { cancelBooking } from '@/modules/bookings/service';
import { cancelBookingSchema } from '@/modules/bookings/validation';

function idFromUrl(url: string): string {
  const id = new URL(url).pathname.split('/').pop();
  if (!id) throw AppError.badRequest();
  return id;
}

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.cancel');
  const body = await validateBody(req, cancelBookingSchema);
  const booking = await cancelBooking(idFromUrl(req.url), body, actor);
  return ok(booking);
});

export const runtime = 'nodejs';