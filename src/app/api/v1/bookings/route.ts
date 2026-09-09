/**
 * GET  /api/v1/bookings → bookings.read (?status=&search=&page=&pageSize=)
 * POST /api/v1/bookings → bookings.create (idempotent via idempotencyKey)
 */
import { apiHandler, created, okPaginated, offset, paginate, validateBody, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { createBooking, listBookingViews } from '@/modules/bookings/service';
import { createBookingSchema, listBookingsQuerySchema } from '@/modules/bookings/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const q = validateQuery(new URL(req.url), listBookingsQuerySchema);
  const { page, pageSize } = q;
  const result = await listBookingViews(
    { search: q.search ?? undefined, status: q.status ?? undefined, limit: pageSize, offset: offset({ page, pageSize }) },
    actor,
  );
  return okPaginated(result.data, paginate(result.data, result.total, { page, pageSize }));
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.create');
  const body = await validateBody(req, createBookingSchema);
  const booking = await createBooking(body, actor);
  return created(booking, `/api/v1/bookings/${booking.id}`);
});

export const runtime = 'nodejs';