/**
 * GET /api/v1/reports/{name}/export?format=xlsx|csv&from=&to=&... → reports.export
 * Queues an async export; the worker renders and stores it, the user is
 * notified, and downloads via /v1/reports/exports/{fileId}/url (§18.3).
 * Never synchronous — 202 with { jobId }. Rate-limited to 5/hr per user
 * (bucket export:<userId>, §20.4).
 */
import { apiHandler, validateQuery } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { withTx } from '@/core/db';
import { enqueue } from '@/core/jobs';
import { enforceRateLimit } from '@/core/rate-limit';
import { requirePermission } from '@/modules/identity/auth-guard';
import {
  exportPropertyId,
  schemaForExport,
  validateExportName,
} from '@/modules/reporting/service';

const EXPORT_MAX = 5;
const EXPORT_WINDOW_SECONDS = 60 * 60;

function nameFromUrl(url: string): string {
  const parts = new URL(url).pathname.split('/');
  const name = parts[parts.length - 2];
  if (!name) throw AppError.badRequest();
  return decodeURIComponent(name);
}

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.export');
  await enforceRateLimit(`export:${actor.id}`, { max: EXPORT_MAX, windowSeconds: EXPORT_WINDOW_SECONDS });
  const name = validateExportName(nameFromUrl(req.url));
  const url = new URL(req.url);
  const format = url.searchParams.get('format');
  if (format && format !== 'xlsx' && format !== 'csv') {
    throw AppError.badRequest('VALIDATION_ERROR', 'format must be xlsx or csv');
  }
  const query = validateQuery(url, schemaForExport(name));
  const propertyId = await exportPropertyId(actor);

  const jobId = await withTx((tx) =>
    enqueue(tx, [{
      jobType: 'export.report',
      propertyId,
      dedupeKey: `export.report:${actor.id}:${name}:${JSON.stringify({ format: format ?? 'xlsx', query })}`,
      payload: {
        name,
        format: format ?? 'xlsx',
        propertyId,
        requestedBy: { id: actor.id, name: actor.name, email: actor.email, role: actor.role },
        params: query,
      },
    }]).then((ids) => ids[0] ?? null),
  );

  return Response.json(
    { data: { jobId, status: jobId ? 'queued' : 'already_queued' } },
    { status: 202 },
  );
});

export const runtime = 'nodejs';