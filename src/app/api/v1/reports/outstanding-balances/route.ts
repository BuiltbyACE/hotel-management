/**
 * GET /api/v1/reports/outstanding-balances → reports.financial
 * Every booking that still owes money, aged by days past departure (§18.2).
 */
import { apiHandler, ok } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { outstandingBalancesReport } from '@/modules/reporting/service';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'reports.financial');
  return ok(await outstandingBalancesReport(actor));
});

export const runtime = 'nodejs';