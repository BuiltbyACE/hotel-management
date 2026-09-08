/**
 * PATCH /api/v1/rooms/{id}/condition → rooms.change_condition
 * Body: { condition, note? } — condition transitions are their own operation.
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { changeRoomCondition } from '@/modules/property/service';
import { changeConditionSchema } from '@/modules/property/validation';

export const PATCH = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'rooms.change_condition');
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 2];
  if (!id) throw AppError.badRequest();

  const body = await validateBody(req, changeConditionSchema);
  const room = await changeRoomCondition(id, body, actor);
  return ok(room);
});

export const runtime = 'nodejs';