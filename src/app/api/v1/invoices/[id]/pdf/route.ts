/**
 * GET /api/v1/invoices/{id}/pdf → invoices.read
 * Inline HTML print document (the §12.5 "immediate HTML preview" — the async
 * PDF job + R2 signed-URL path is a later slice).
 */
import { apiHandler } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getInvoiceDocument } from '@/modules/billing/service';

function idFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 2] ?? '';
}

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'invoices.read');
  const invoiceId = idFromUrl(req.url);
  if (!invoiceId) throw AppError.badRequest();
  const html = await getInvoiceDocument(invoiceId, actor);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

export const runtime = 'nodejs';