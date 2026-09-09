/**
 * POST /api/v1/bookings/{id}/charges → folio.post_charge
 * Body: { chargeType, description, quantity?, unitAmount }
 * Discounts additionally need folio.discount (enforced in the service).
 */
import { apiHandler, created, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { postCharge } from '@/modules/billing/service';
import { postChargeSchema } from '@/modules/billing/validation';

function idFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 3] ?? '';
}

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'folio.post_charge');
  const bookingId = idFromUrl(req.url);
  if (!bookingId) throw AppError.badRequest();
  const body = await validateBody(req, postChargeSchema);
  const charge = await postCharge(bookingId, body, actor);
  return created(charge, `/api/v1/bookings/${bookingId}/charges/${charge.id}`);
});

export const runtime = 'nodejs';