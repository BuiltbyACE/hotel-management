/**
 * GET /api/v1/reports/revenue?from=&to=&breakdown=roomType|source|method → reports.financial
 * Revenue by day (daily_stats) or by room type / booking source / payment method (§18.2).
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { revenueReport } from '@/modules/reporting/service';
import { revenueQuerySchema } from '@/modules/reporting/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.financial');
  const q = validateQuery(new URL(req.url), revenueQuerySchema);
  return ok(await revenueReport(q, actor));
});

export const runtime = 'nodejs';