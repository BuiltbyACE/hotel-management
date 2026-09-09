/**
 * POST /api/v1/bookings/{id}/check-out → frontdesk.check_out
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { checkOutBooking } from '@/modules/bookings/service';
import { checkoutBodySchema } from '@/modules/bookings/validation';

function idFromUrl(url: string): string {
  const id = new URL(url).pathname.split('/').pop();
  if (!id) throw AppError.badRequest();
  return id;
}

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'frontdesk.check_out');
  await validateBody(req, checkoutBodySchema);
  const booking = await checkOutBooking(idFromUrl(req.url), actor);
  return ok(booking);
});

export const runtime = 'nodejs';