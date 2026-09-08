/**
 * POST /api/v1/availability/quote → bookings.read
 * Server-side price quote. The client price is a suggestion, never a fact —
 * the booking transaction recomputes it with quoteStay().
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { quoteStayForActor } from '@/modules/availability/service';
import { quoteBodySchema } from '@/modules/availability/validation';

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'bookings.read');
  const body = await validateBody(req, quoteBodySchema);
  const quote = await quoteStayForActor(
    {
      roomTypeId: body.roomTypeId,
      arrival: body.arrival,
      departure: body.departure,
      adults: body.adults,
      children: body.children,
    },
    actor,
  );
  return ok(quote);
});

export const runtime = 'nodejs';