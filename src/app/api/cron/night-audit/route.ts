/**
 * POST /api/cron/night-audit (Authorization: Bearer $CRON_SECRET)
 * Scheduled night audit (§13.3 / §22 Phase 7). Runs for yesterday (the frozen
 * day) across every property under the system actor; each property's pass is
 * serialised by its advisory lock, so overlaps with a manual run never
 * double-post.
 */
import { runCron } from '@/core/jobs';
import { addDays, today } from '@/core/dates';
import { SYSTEM_ACTOR } from '@/modules/audit/service';
import { runNightAudit } from '@/modules/frontdesk/service';

export const POST = (req: Request) =>
  runCron(req, 'night-audit', async () => runNightAudit(addDays(today(), -1), SYSTEM_ACTOR));

export const runtime = 'nodejs';