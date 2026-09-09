/**
 * PATCH /api/v1/housekeeping/rooms/{id} → housekeeping.update
 * Body: { housekeeping?, condition? } — one tap flips the board tile.
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { updateHousekeeping } from '@/modules/housekeeping/service';
import { updateHousekeepingSchema } from '@/modules/housekeeping/validation';

export const PATCH = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'housekeeping.update');
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 2];
  if (!id) throw AppError.badRequest('VALIDATION_ERROR', 'Room id is required');

  const body = await validateBody(req, updateHousekeepingSchema);
  const room = await updateHousekeeping(id, body, actor);
  return ok(room);
});

export const runtime = 'nodejs';