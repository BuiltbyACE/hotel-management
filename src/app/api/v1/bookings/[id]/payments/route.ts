/**
 * POST /api/v1/bookings/{id}/payments → payments.record
 * Body: { amount, method, reference?, notes?, idempotencyKey? }
 */
import { apiHandler, created, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { recordPayment } from '@/modules/bookings/service';
import { recordPaymentSchema } from '@/modules/bookings/validation';

function idFromUrl(url: string): string {
  const path = new URL(url).pathname;
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 2] ?? '';
}

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'payments.record');
  const bookingId = idFromUrl(req.url);
  if (!bookingId) throw AppError.badRequest();
  const body = await validateBody(req, recordPaymentSchema);
  const payment = await recordPayment(bookingId, body, actor);
  return created(payment, `/api/v1/bookings/${bookingId}/payments/${payment.id}`);
});

export const runtime = 'nodejs';