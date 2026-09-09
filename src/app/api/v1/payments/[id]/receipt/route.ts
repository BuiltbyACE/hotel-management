/**
 * GET /api/v1/payments/{id}/receipt → payments.read
 * 80 mm thermal print receipt (§12.5). HTML with an @media print stylesheet.
 */
import { apiHandler } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getPaymentReceipt } from '@/modules/billing/service';

function idFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 2] ?? '';
}

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'payments.read');
  const paymentId = idFromUrl(req.url);
  if (!paymentId) throw AppError.badRequest();
  const html = await getPaymentReceipt(paymentId, actor);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

export const runtime = 'nodejs';