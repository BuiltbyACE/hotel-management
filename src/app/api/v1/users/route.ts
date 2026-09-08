/**
 * GET  /api/v1/users            → users.read   (list, filters) [blueprint §16]
 * POST /api/v1/users            → users.create (staff account)
 */
import { apiHandler, created, okPaginated, offset, paginate, validateBody, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { createUser, listUsers } from '@/modules/identity/service';
import { createUserSchema, listUsersQuerySchema } from '@/modules/identity/validation';

type QueryUserStatus = 'active' | 'suspended' | 'disabled';

export const GET = apiHandler(async (req) => {
  await requirePermission(req, 'users.read');
  const q = validateQuery(new URL(req.url), listUsersQuerySchema);
  const { page, pageSize } = q;
  const result = await listUsers({
    search: q.search,
    role: q.role as 'admin' | 'manager' | 'receptionist',
    status: q.status as QueryUserStatus,
    limit: pageSize,
    offset: offset({ page, pageSize }),
  });
  return okPaginated(result.data, paginate(result.data, result.total, { page, pageSize }));
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'users.create');
  const body = await validateBody(req, createUserSchema);
  const user = await createUser(body, actor);
  return created(user, `/api/v1/users/${user.id}`);
});

export const runtime = 'nodejs';