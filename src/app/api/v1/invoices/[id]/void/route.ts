/**
 * POST /api/v1/invoices/{id}/void → invoices.void  { reason }
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { voidInvoice } from '@/modules/billing/service';
import { voidInvoiceSchema } from '@/modules/billing/validation';

function idFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 2] ?? '';
}

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'invoices.void');
  const invoiceId = idFromUrl(req.url);
  if (!invoiceId) throw AppError.badRequest();
  const body = await validateBody(req, voidInvoiceSchema);
  return ok(await voidInvoice(invoiceId, body.reason, actor));
});

export const runtime = 'nodejs';