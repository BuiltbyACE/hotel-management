/**
 * GET /api/v1/bookings/{id}/folio → folio.read
 * The running bill: every charge (voided lines flagged), payments, totals.
 */
import { apiHandler, ok } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getFolioView } from '@/modules/billing/service';

function idFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 2] ?? '';
}

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'folio.read');
  const bookingId = idFromUrl(req.url);
  if (!bookingId) throw AppError.badRequest();
  return ok(await getFolioView(bookingId, actor));
});

export const runtime = 'nodejs';