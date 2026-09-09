/**
 * PATCH /api/v1/notifications/{id}/read → mark one of your notifications read.
 */
import { apiHandler, ok } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requireActor } from '@/modules/identity/auth-guard';
import { markNotificationRead } from '@/modules/audit/service';

export const PATCH = apiHandler(async (req) => {
  const actor = await requireActor(req);
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 2];
  if (!id) throw AppError.badRequest();

  const updated = await markNotificationRead(id, actor.id);
  return ok(updated);
});

export const runtime = 'nodejs';