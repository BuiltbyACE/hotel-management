/**
 * GET /api/v1/notifications → own notifications for the signed-in user.
 * Returns { data, pagination, unreadCount } — the unread badge is part of the
 * same read the front desk needs.
 */
import { apiHandler, offset, paginate, validateQuery } from '@/core/api';
import { requireActor } from '@/modules/identity/auth-guard';
import { listMyNotifications } from '@/modules/audit/service';
import { listNotificationsQuerySchema } from '@/modules/audit/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requireActor(req);
  const q = validateQuery(new URL(req.url), listNotificationsQuerySchema);
  const { page, pageSize } = q;
  const { data, total, unreadCount } = await listMyNotifications(actor.id, {
    includeRead: q.includeRead,
    limit: pageSize,
    offset: offset({ page, pageSize }),
  });
  return Response.json({
    data,
    pagination: paginate(data, total, { page, pageSize }),
    unreadCount,
  });
});

export const runtime = 'nodejs';