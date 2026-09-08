/**
 * GET /api/v1/availability/rooms → bookings.read
 * Which rooms are free for [arrival, departure)? Optional roomTypeId,
 * minimum occupancy, and excludeBookingId (self when editing).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { findAvailableRooms } from '@/modules/availability/service';
import { findRoomsQuerySchema } from '@/modules/availability/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const q = validateQuery(new URL(req.url), findRoomsQuerySchema);
  const rooms = await findAvailableRooms(
    {
      arrival: q.arrival,
      departure: q.departure,
      roomTypeId: q.roomTypeId,
      occupancy: q.occupancy,
      excludeBookingId: q.excludeBookingId,
    },
    actor,
  );
  return ok({ data: rooms });
});

export const runtime = 'nodejs';