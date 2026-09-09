/**
 * GET /api/v1/activity-logs → audit.read
 * Scoped to the actor's property (admins without one see everything).
 */
import { apiHandler, offset, okPaginated, paginate, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { listActivityLogsRoute } from '@/modules/audit/service';
import { listActivityLogsQuerySchema } from '@/modules/audit/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'audit.read');
  const q = validateQuery(new URL(req.url), listActivityLogsQuerySchema);
  const { page, pageSize } = q;
  const result = await listActivityLogsRoute(
    {
      entityType: q.entityType,
      entityId: q.entityId,
      actorId: q.actorId,
      action: q.action,
      from: q.from,
      to: q.to,
      limit: pageSize,
      offset: offset({ page, pageSize }),
    },
    actor.propertyId,
  );
  return okPaginated(result.data, paginate(result.data, result.total, { page, pageSize }));
});

export const runtime = 'nodejs';