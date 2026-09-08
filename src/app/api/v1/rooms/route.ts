/**
 * GET  /api/v1/rooms     → rooms.read   (?typeId=&condition=&floor=&search=&page=&pageSize=)
 * POST /api/v1/rooms     → rooms.create
 */
import { apiHandler, created, okPaginated, offset, paginate, validateBody, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { createRoom, listRooms } from '@/modules/property/service';
import { listRoomsQuerySchema, roomCreateSchema } from '@/modules/property/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'rooms.read');
  const q = validateQuery(new URL(req.url), listRoomsQuerySchema);
  const { page, pageSize } = q;
  const result = await listRooms(
    {
      typeId: q.typeId,
      condition: q.condition,
      floor: q.floor,
      search: q.search,
      limit: pageSize,
      offset: offset({ page, pageSize }),
    },
    actor,
  );
  return okPaginated(result.data, paginate(result.data, result.total, { page, pageSize }));
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'rooms.create');
  const body = await validateBody(req, roomCreateSchema);
  const room = await createRoom(body, actor);
  return created(room, `/api/v1/rooms/${room.id}`);
});

export const runtime = 'nodejs';