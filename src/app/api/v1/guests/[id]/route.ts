/**
 * GET    /api/v1/guests/{id} → guests.read
 * PATCH  /api/v1/guests/{id} → guests.update
 * DELETE /api/v1/guests/{id} → guests.delete (soft; blocked if bookings exist)
 */
import { apiHandler, ok, noContent, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { deleteGuest, getGuest, updateGuest } from '@/modules/guests/service';
import { guestUpdateSchema } from '@/modules/guests/validation';

function idFromUrl(url: string): string {
  const id = new URL(url).pathname.split('/').pop();
  if (!id) throw AppError.badRequest();
  return id;
}

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.read');
  const guest = await getGuest(idFromUrl(req.url), actor);
  return ok(guest);
});

export const PATCH = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.update');
  const body = await validateBody(req, guestUpdateSchema);
  const guest = await updateGuest(idFromUrl(req.url), body, actor);
  return ok(guest);
});

export const DELETE = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'guests.delete');
  await deleteGuest(idFromUrl(req.url), actor);
  return noContent();
});

export const runtime = 'nodejs';