/**
 * GET /api/v1/reports/exports/{fileId}/url → reports.export
 * Signed URL for a stored report export (§17.7). Private files are never
 * exposed by a direct URL; permission to view reports is checked here, and the
 * blob lives in the private bucket behind a 5-minute pre-signed URL.
 */
import { apiHandler, ok } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { withDb } from '@/core/db';
import { getFileRecord, getStorage } from '@/core/files';
import { requirePermission } from '@/modules/identity/auth-guard';

function fileIdFromUrl(url: string): string {
  const parts = new URL(url).pathname.split('/');
  const id = parts[parts.length - 2];
  if (!id) throw AppError.badRequest();
  return decodeURIComponent(id);
}

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.export');
  const file = await withDb((db) => getFileRecord(db, fileIdFromUrl(req.url)));
  if (!file || file.entityType !== 'report') {
    throw AppError.notFound('Export not found');
  }
  if (actor.propertyId && file.propertyId !== actor.propertyId) {
    throw AppError.forbidden('FORBIDDEN', 'Export belongs to another property');
  }
  return ok({ url: await getStorage().presignGet(file.storageKey), ttlSeconds: 300 });
});

export const runtime = 'nodejs';