/**
 * POST /api/v1/night-audit → frontdesk.night_audit
 * Manual night-audit pass for every active property (§13.3). Defaults to
 * yesterday; `{"date":"YYYY-MM-DD"}` selects a specific target date.
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { addDays, today } from '@/core/dates';
import { requirePermission } from '@/modules/identity/auth-guard';
import { runNightAudit } from '@/modules/frontdesk/service';
import { nightAuditBodySchema } from '@/modules/frontdesk/validation';

export const POST = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'frontdesk.night_audit');
  const input = await validateBody(req, nightAuditBodySchema);
  const targetDate = input.date ?? addDays(today(), -1);
  const results = await runNightAudit(targetDate, {
    id: actor.id,
    name: actor.name || actor.email,
    role: actor.role,
  });
  return ok({ ran: true, targetDate, properties: results });
});

export const runtime = 'nodejs';