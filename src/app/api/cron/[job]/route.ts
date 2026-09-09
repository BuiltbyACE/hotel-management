/**
 * POST /api/cron/{job} (Authorization: Bearer $CRON_SECRET) — §15.4
 * Generic cron entrypoint. Each registered job is a plain function; the
 * scheduler (or a human) fires it by name. Overlaps are guarded by the jobs
 * themselves (night audit uses advisory locks; purge is idempotent).
 */
import { AppError } from '@/core/api';
import { addDays, today } from '@/core/dates';
import { withDb } from '@/core/db';
import { runCron } from '@/core/jobs';
import { purgeRateLimits } from '@/core/rate-limit';
import { SYSTEM_ACTOR } from '@/modules/audit/service';
import { runNightAudit } from '@/modules/frontdesk/service';

const JOBS: Record<string, () => Promise<unknown>> = {
  'night-audit': () => runNightAudit(addDays(today(), -1), SYSTEM_ACTOR),
  'purge-rate-limits': () => withDb((db) => purgeRateLimits(db)),
};

export const POST = async (req: Request) => {
  const parts = new URL(req.url).pathname.split('/');
  const name = decodeURIComponent(parts[parts.length - 1] ?? '');

  const run = JOBS[name];
  if (!run) throw AppError.notFound(`Unknown cron job: ${name}`);

  return runCron(req, name, run);
};

export const runtime = 'nodejs';