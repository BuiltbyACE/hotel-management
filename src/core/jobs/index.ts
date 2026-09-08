/**
 * core/jobs/index.ts
 *
 * Job surface: the outbox, the in-process worker, and the cron endpoint
 * helper. Modules enqueue from inside their transactions; the identity phase
 * registers handlers; routes under /api/cron use handleCron.
 */
import { AppError } from '@/core/api/errors';
import { env } from '@/core/config/env';

export { enqueue, enqueueOne } from './outbox';
export type { JobSpec } from './outbox';
export {
  registerHandler,
  runWorkerPass,
  startWorker,
  queueDepth,
} from './worker';
export type { JobHandler, JobContext, ClaimedJob } from './worker';

/**
 * Guard a cron route. `POST /api/cron/:name` with
 * `Authorization: Bearer $CRON_SECRET` (blueprint §15.4). Throws
 * AppError.unauthorized if the secret is wrong or missing.
 */
export function assertCronAuthorized(req: Request): void {
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${env.CRON_SECRET}`;
  if (header !== expected) {
    throw AppError.unauthorized('Invalid or missing cron secret');
  }
}

/**
 * Wrap a cron job body. Runs the handler, returns a small 200 envelope.
 */
export async function runCron(
  req: Request,
  name: string,
  fn: () => Promise<unknown>,
): Promise<Response> {
  assertCronAuthorized(req);
  const result = await fn();
  return Response.json({ ok: true, job: name, result });
}