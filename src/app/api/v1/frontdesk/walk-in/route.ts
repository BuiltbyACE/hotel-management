/**
 * POST /api/v1/frontdesk/walk-in → frontdesk.check_in
 * Body: guest + rooms + optional payment (+ optional overrideDepositReason).
 * Creates the guest + booking and checks the guest in (§13.1, §16.3).
 */
import { apiHandler, created, validateBody } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { walkIn } from '@/modules/frontdesk/service';
import { walkInSchema } from '@/modules/frontdesk/validation';

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'frontdesk.check_in');
  const body = await validateBody(req, walkInSchema);
  const booking = await walkIn(body, actor);
  return created(booking);
});

export const runtime = 'nodejs';