/**
 * POST /api/v1/bookings/{id}/charges/{chargeId}/void → folio.void_charge
 * Body: { reason }
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { voidCharge } from '@/modules/billing/service';
import { voidChargeSchema } from '@/modules/billing/validation';

function segments(url: string, fromEnd: number): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts[parts.length - 1 - fromEnd] ?? '';
}

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'folio.void_charge');
  const bookingId = segments(req.url, 3);
  const chargeId = segments(req.url, 1);
  if (!bookingId || !chargeId) throw AppError.badRequest();
  const body = await validateBody(req, voidChargeSchema);
  return ok(await voidCharge(bookingId, chargeId, body.reason, actor));
});

export const runtime = 'nodejs';