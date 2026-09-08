/**
 * POST /api/v1/users/{id}/reset-password  → users.reset_password
 * Admin drops a temporary password; forces a change + revokes all sessions.
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission } from '@/modules/identity/auth-guard';
import { resetPassword } from '@/modules/identity/service';
import { resetPasswordSchema } from '@/modules/identity/validation';

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'users.reset_password');
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 2];
  if (!id) throw AppError.badRequest();

  const body = await validateBody(req, resetPasswordSchema);
  const user = await resetPassword(id, body, actor);
  return ok(user);
});

export const runtime = 'nodejs';