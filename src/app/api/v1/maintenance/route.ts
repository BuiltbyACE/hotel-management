/**
 * GET/POST /api/v1/maintenance → maintenance.read / maintenance.report
 * Issue list (filterable) and the report-issue flow (§14.1, spec A10/A15).
 */
import { apiHandler, created, okPaginated, validateBody, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { reportIssue, listIssuesService } from '@/modules/maintenance/service';
import { reportIssueSchema, listIssuesQuerySchema } from '@/modules/maintenance/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'maintenance.read');
  const q = validateQuery(new URL(req.url), listIssuesQuerySchema);
  const { data, total } = await listIssuesService(q, actor);
  return okPaginated({ data }, { page: q.page, pageSize: q.pageSize, total });
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'maintenance.report');
  const input = await validateBody(req, reportIssueSchema);
  const issue = await reportIssue(input, actor);
  return created({ data: issue });
});

export const runtime = 'nodejs';