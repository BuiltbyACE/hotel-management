/**
 * GET  /api/v1/guests → guests.read   (?search=&page=&pageSize= — name/phone/ID search)
 * POST /api/v1/guests → guests.create (deduped on ID document + phone)
 */
import { apiHandler, created, okPaginated, offset, paginate, validateBody, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { createGuest, listGuests } from '@/modules/guests/service';
import { guestCreateSchema, listGuestsQuerySchema } from '@/modules/guests/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.read');
  const q = validateQuery(new URL(req.url), listGuestsQuerySchema);
  const { page, pageSize } = q;
  const result = await listGuests({ search: q.search, limit: pageSize, offset: offset({ page, pageSize }) }, actor);
  return okPaginated(result.data, paginate(result.data, result.total, { page, pageSize }));
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.create');
  const body = await validateBody(req, guestCreateSchema);
  const guest = await createGuest(body, actor);
  return created(guest, `/api/v1/guests/${guest.id}`);
});

export const runtime = 'nodejs';