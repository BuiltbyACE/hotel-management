/**
 * POST /api/v1/bookings/{id}/check-in → frontdesk.check_in
 * Body: { overrideDepositReason?: string }
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { checkInBooking } from '@/modules/bookings/service';
import { checkInBodySchema } from '@/modules/bookings/validation';

function idFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 2] ?? '';
}

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'frontdesk.check_in');
  const body = await validateBody(req, checkInBodySchema);
  const booking = await checkInBooking(idFromUrl(req.url), actor, body.overrideDepositReason ?? null);
  return ok(booking);
});

export const runtime = 'nodejs';