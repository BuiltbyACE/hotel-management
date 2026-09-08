/**
 * GET  /api/v1/room-types     → roomtypes.read   (list: ?active=&search=)
 * POST /api/v1/room-types     → roomtypes.create
 */
import { apiHandler, created, ok, validateBody, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { createRoomType, listRoomTypes } from '@/modules/property/service';
import { listRoomTypesQuerySchema, roomTypeCreateSchema } from '@/modules/property/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'roomtypes.read');
  const q = validateQuery(new URL(req.url), listRoomTypesQuerySchema);
  const list = await listRoomTypes({ active: q.active, search: q.search }, actor);
  return ok(list);
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'roomtypes.create');
  const body = await validateBody(req, roomTypeCreateSchema);
  const roomType = await createRoomType(body, actor);
  return created(roomType, `/api/v1/room-types/${roomType.id}`);
});

export const runtime = 'nodejs';