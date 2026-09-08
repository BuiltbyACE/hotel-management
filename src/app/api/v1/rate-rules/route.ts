/**
 * GET  /api/v1/rate-rules → rates.read    (list — [P2] but the API is live)
 * POST /api/v1/rate-rules → rates.update  (create)
 */
import { apiHandler, created, ok, validateBody } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { createRateRule, listRateRules } from '@/modules/property/service';
import { rateRuleCreateSchema } from '@/modules/property/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'rates.read');
  const list = await listRateRules(actor);
  return ok(list);
});

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'rates.update');
  const body = await validateBody(req, rateRuleCreateSchema);
  const rule = await createRateRule(body, actor);
  return created(rule, `/api/v1/rate-rules/${rule.id}`);
});

export const runtime = 'nodejs';