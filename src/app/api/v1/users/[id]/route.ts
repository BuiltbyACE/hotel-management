/**
 * PATCH /api/v1/users/{id}      → users.update  (edit name/phone/role/status/propertyId)
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { updateUser } from '@/modules/identity/service';
import { updateUserSchema } from '@/modules/identity/validation';

export const PATCH = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'users.update');
  const id = new URL(req.url).pathname.split('/').pop();
  if (!id) throw AppError.badRequest();

  const body = await validateBody(req, updateUserSchema);
  const user = await updateUser(id, body, actor);
  return ok(user);
});

export const runtime = 'nodejs';