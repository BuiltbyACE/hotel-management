/**
 * POST   /api/v1/guests/{id}/blacklist → guests.blacklist { reason }
 * DELETE /api/v1/guests/{id}/blacklist → guests.blacklist (lift)
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { blacklistGuest, unblacklistGuest } from '@/modules/guests/service';
import { blacklistGuestSchema } from '@/modules/guests/validation';

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.blacklist');
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 2];
  if (!id) throw AppError.badRequest();

  const body = await validateBody(req, blacklistGuestSchema);
  const guest = await blacklistGuest(id, body.reason, actor);
  return ok(guest);
});

export const DELETE = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.blacklist');
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 2];
  if (!id) throw AppError.badRequest();

  const guest = await unblacklistGuest(id, actor);
  return ok(guest);
});

export const runtime = 'nodejs';