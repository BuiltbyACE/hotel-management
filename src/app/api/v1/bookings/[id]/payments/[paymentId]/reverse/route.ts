/**
 * POST /api/v1/bookings/{id}/payments/{paymentId}/reverse → payments.reverse
 * Body: { reason }
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { reversePayment } from '@/modules/bookings/service';
import { reversePaymentSchema } from '@/modules/bookings/validation';

function idsFromUrl(url: string): { bookingId: string; paymentId: string } {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return { bookingId: segments[segments.length - 4] ?? '', paymentId: segments[segments.length - 2] ?? '' };
}

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'payments.reverse');
  const { bookingId, paymentId } = idsFromUrl(req.url);
  if (!bookingId || !paymentId) throw AppError.badRequest();
  const body = await validateBody(req, reversePaymentSchema);
  const payment = await reversePayment(bookingId, paymentId, body, actor);
  return ok(payment);
});

export const runtime = 'nodejs';