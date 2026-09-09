/**
 * GET /api/v1/invoices/{id} → invoices.read  (full detail incl. lines)
 */
import { apiHandler, ok } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getInvoice } from '@/modules/billing/service';

function idFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'invoices.read');
  const invoiceId = idFromUrl(req.url);
  if (!invoiceId) throw AppError.badRequest();
  return ok(await getInvoice(invoiceId, actor));
});

export const runtime = 'nodejs';