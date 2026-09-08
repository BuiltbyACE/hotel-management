/**
 * GET  /api/v1/guests/{id}/documents              → guests.read
 * POST /api/v1/guests/{id}/documents              → guests.update
 *      body: { fileId, docType } — the blob itself is uploaded through the
 *      core files surface (private bucket); this ties it to the guest profile.
 */
import { apiHandler, created, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { attachDocument, listDocuments } from '@/modules/guests/service';
import { attachDocumentSchema } from '@/modules/guests/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.read');
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 2];
  if (!id) throw AppError.badRequest();

  const list = await listDocuments(id, actor);
  return ok(list);
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.update');
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 2];
  if (!id) throw AppError.badRequest();

  const body = await validateBody(req, attachDocumentSchema);
  const doc = await attachDocument(id, body, actor);
  return created(doc, `/api/v1/guests/${id}/documents/${doc.id}/url`);
});

export const runtime = 'nodejs';