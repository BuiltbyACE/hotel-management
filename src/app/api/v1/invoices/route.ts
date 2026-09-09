/**
 * GET  /api/v1/invoices → invoices.read (?status=&from=&to=&page=&pageSize=)
 * POST /api/v1/invoices → invoices.issue  { bookingId }
 */
import { apiHandler, created, okPaginated, offset, paginate, validateBody, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { issueInvoice, listInvoiceViews } from '@/modules/billing/service';
import { issueInvoiceSchema, listInvoicesQuerySchema } from '@/modules/billing/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'invoices.read');
  const q = validateQuery(new URL(req.url), listInvoicesQuerySchema);
  const { page, pageSize } = q;
  const result = await listInvoiceViews(
    {
      status: q.status ?? undefined,
      from: q.from ?? undefined,
      to: q.to ?? undefined,
      limit: pageSize,
      offset: offset({ page, pageSize }),
    },
    actor,
  );
  return okPaginated(result.data, paginate(result.data, result.total, { page, pageSize }));
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'invoices.issue');
  const body = await validateBody(req, issueInvoiceSchema);
  const invoice = await issueInvoice(body.bookingId, actor);
  return created(invoice, `/api/v1/invoices/${invoice.id}`);
});

export const runtime = 'nodejs';