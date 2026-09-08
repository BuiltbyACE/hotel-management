/**
 * GET    /api/v1/room-types/{id} → roomtypes.read   (single)
 * PATCH  /api/v1/room-types/{id} → roomtypes.update
 * DELETE /api/v1/room-types/{id} → roomtypes.delete (soft; blocked if rooms exist)
 */
import { apiHandler, ok, noContent, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { deleteRoomType, getRoomType, updateRoomType } from '@/modules/property/service';
import { roomTypeUpdateSchema } from '@/modules/property/validation';

function idFromUrl(url: string): string {
  const id = new URL(url).pathname.split('/').pop();
  if (!id) throw AppError.badRequest();
  return id;
}

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'roomtypes.read');
  const roomType = await getRoomType(idFromUrl(req.url), actor);
  return ok(roomType);
});

export const PATCH = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'roomtypes.update');
  const body = await validateBody(req, roomTypeUpdateSchema);
  const roomType = await updateRoomType(idFromUrl(req.url), body, actor);
  return ok(roomType);
});

export const DELETE = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'roomtypes.delete');
  await deleteRoomType(idFromUrl(req.url), actor);
  return noContent();
});

export const runtime = 'nodejs';