/**
 * GET /api/v1/guests/{id}/documents/{docId}/url → guests.view_documents
 * Returns a 5-minute presigned URL; the object itself is never public.
 */
import { apiHandler, ok } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { documentUrl } from '@/modules/guests/service';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.view_documents');
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 4];
  const docId = parts[parts.length - 2];
  if (!id || !docId) throw AppError.badRequest();

  const result = await documentUrl(id, docId, actor);
  return ok(result);
});

export const runtime = 'nodejs';