/**
 * POST /api/v1/guests/merge → guests.merge { keepId, mergeIds[] }
 * Fold duplicate profiles into the keeper (references re-pointed, merged
 * guests soft-deleted, lifetime stats aggregated).
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { mergeGuests } from '@/modules/guests/service';
import { mergeGuestsSchema } from '@/modules/guests/validation';

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.merge');
  const body = await validateBody(req, mergeGuestsSchema);
  const guest = await mergeGuests(body, actor);
  return ok(guest);
});

export const runtime = 'nodejs';