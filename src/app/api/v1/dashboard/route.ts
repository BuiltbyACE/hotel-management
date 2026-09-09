/**
 * GET /api/v1/dashboard → reports.operational (role-shaped payload, §18.4).
 * Receptionists get the operational board; managers/admins the financial KPIs.
 */
import { apiHandler, ok } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { dashboard } from '@/modules/reporting/service';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.operational');
  return ok(await dashboard(actor));
});

export const runtime = 'nodejs';