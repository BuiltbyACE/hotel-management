/**
 * PATCH  /api/v1/rooms/{id} → rooms.update
 * DELETE /api/v1/rooms/{id} → rooms.delete (soft; blocked if live allocations)
 */
import { apiHandler, ok, noContent, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { deleteRoom, updateRoom } from '@/modules/property/service';
import { roomUpdateSchema } from '@/modules/property/validation';

function idFromUrl(url: string): string {
  const id = new URL(url).pathname.split('/').pop();
  if (!id) throw AppError.badRequest();
  return id;
}

export const PATCH = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'rooms.update');
  const body = await validateBody(req, roomUpdateSchema);
  const room = await updateRoom(idFromUrl(req.url), body, actor);
  return ok(room);
});

export const DELETE = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'rooms.delete');
  await deleteRoom(idFromUrl(req.url), actor);
  return noContent();
});

export const runtime = 'nodejs';