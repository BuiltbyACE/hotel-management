/**
 * GET/PATCH /api/v1/maintenance/{id} → maintenance.read / maintenance.update
 * GET returns the issue with its update trail. PATCH advances the flow; the
 * write perm doubles as: assigning → maintenance.assign, finalising
 * (resolved/closed) → maintenance.close. Transitions stay in the service.
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { AppError } from '@/core/api/errors';
import { requirePermission, can } from '@/modules/identity/auth-guard';
import { getIssue, updateIssue } from '@/modules/maintenance/service';
import { updateIssueSchema } from '@/modules/maintenance/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'maintenance.read');
  const id = idFromUrl(req);
  const issue = await getIssue(id, actor);
  return ok({ data: issue });
});

export const PATCH = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'maintenance.update');
  const id = idFromUrl(req);

  const body = await validateBody(req, updateIssueSchema);

  const assigning = body.assignedTo !== undefined || body.assignedUserId !== undefined;
  const finalising = body.status === 'resolved' || body.status === 'closed';
  if (assigning && !can(actor, 'maintenance.assign')) throw AppError.forbidden();
  if (finalising && !can(actor, 'maintenance.close')) throw AppError.forbidden();

  const issue = await updateIssue(id, body, actor);
  return ok({ data: issue });
});

function idFromUrl(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.length - 1];
  if (!id) throw AppError.badRequest('VALIDATION_ERROR', 'Issue id is required');
  return id;
}

export const runtime = 'nodejs';