/**
 * core/jobs/worker.ts
 *
 * In-process job worker (blueprint §15.2). Polls job_queue with
 * `FOR UPDATE SKIP LOCKED` — the reason we don't need Redis — claims up to
 * 10 jobs, runs their registered handlers, then marks each done/failed.
 *
 * Retries: exponential backoff `2^attempts` minutes, up to `max_attempts`,
 * then `dead`. A dead-letter list is visible in Settings → System.
 */
import { eq, or, sql } from 'drizzle-orm';
import { jobQueue } from '@/core/db/infra';
import { withDb, type Db } from '@/core/db';
import { createLogger } from '@/core/logger';

export interface JobContext {
  jobId: number;
  propertyId: string | null;
  requestId?: string;
}

export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

export interface ClaimedJob {
  id: number;
  jobType: string;
  payload: Record<string, unknown>;
  propertyId: string | null;
  attempts: number;
  maxAttempts: number;
}

const handlers = new Map<string, JobHandler>();

/**
 * Register a handler for a JobSpec.jobType. Called once at module load or in
 * the worker bootstrap.
 */
export function registerHandler(jobType: string, handler: JobHandler): void {
  handlers.set(jobType, handler);
}

/** Run a single worker pass (poll → execute → record). */
export async function runWorkerPass(db: Db, batchSize = 10): Promise<number> {
  const claimed = await claimJobs(db, batchSize);
  for (const job of claimed) {
    await processClaimed(job);
  }
  return claimed.length;
}

async function claimJobs(db: Db, limit: number): Promise<ClaimedJob[]> {
  const rows = await db.execute(sql`
    UPDATE job_queue
    SET status = 'processing',
        locked_at = now(),
        locked_by = ${workerName()},
        attempts = attempts + 1,
        run_after = now()
    WHERE id IN (
      SELECT id FROM job_queue
      WHERE status IN ('pending', 'processing')
        AND run_after <= now()
      ORDER BY priority, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, job_type AS "jobType", payload, property_id AS "propertyId",
              attempts, max_attempts AS "maxAttempts"
  `);

  return rows.rows as unknown as ClaimedJob[];
}

async function processClaimed(job: ClaimedJob): Promise<void> {
  const logger = createLogger(`job:${job.id}`);
  const handler = handlers.get(job.jobType);

  if (!handler) {
    logger.warn({ jobType: job.jobType, jobId: job.id }, 'no handler registered for job type');
    await markFailed(job, new Error(`No handler registered for "${job.jobType}"`));
    return;
  }

  try {
    await handler(job.payload, {
      jobId: job.id,
      propertyId: job.propertyId,
      requestId: job.payload.requestId as string | undefined,
    });
    await markCompleted(job.id);
  } catch (e) {
    logger.error({ jobType: job.jobType, jobId: job.id, err: e instanceof Error ? e : undefined }, 'job failed');
    await markFailed(job, e instanceof Error ? e : new Error(String(e)));
  }
}

async function markCompleted(jobId: number): Promise<void> {
  await withDb((db) =>
    db
      .update(jobQueue)
      .set({ status: 'completed', completedAt: new Date(), lockedAt: null, lockedBy: null })
      .where(eq(jobQueue.id, jobId)),
  );
}

async function markFailed(job: ClaimedJob, error: Error): Promise<void> {
  const attempts = job.attempts; // already incremented at claim
  const overdue = attempts >= job.maxAttempts;
  await withDb((db) =>
    db
      .update(jobQueue)
      .set({
        status: overdue ? 'dead' : 'pending',
        lastError: error.message.slice(0, 2000),
        runAfter: overdue ? undefined : new Date(Date.now() + backoffMs(attempts)),
        lockedAt: null,
        lockedBy: null,
      })
      .where(eq(jobQueue.id, job.id)),
  );
}

function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, 24 * 3600_000); // 2^attempts minutes, cap 24h
}

/**
 * Start the poll loop. Returns a stop() function. In Next.js the worker runs
 * in-process when JOB_WORKER_ENABLED; in production it can be extracted.
 *
 * The loop is self-scheduling: a pass finishes before the next is scheduled,
 * so overlapping polls never double-claim (SKIP LOCKED would make it safe
 * anyway).
 */
export function startWorker(opts: { intervalMs?: number; batchSize?: number } = {}) {
  const intervalMs = opts.intervalMs ?? 2000;
  const batchSize = opts.batchSize ?? 10;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pump = async () => {
    if (stopped) return;
    try {
      await withDb((db) => runWorkerPass(db, batchSize));
    } catch (e) {
      const logger = createLogger('job-worker');
      logger.error({ err: e instanceof Error ? e : undefined }, 'worker pass failed');
    }
    if (!stopped) timer = setTimeout(pump, intervalMs);
  };

  timer = setTimeout(pump, intervalMs);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

let workerNameCache: string | undefined;
function workerName(): string {
  if (!workerNameCache) {
    workerNameCache = `${process.env.NODE_ENV ?? 'dev'}:${process.pid}`;
  }
  return workerNameCache;
}

/**
 * Count pending+processing depth for /api/metrics.
 */
export async function queueDepth(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(jobQueue)
    .where(or(eq(jobQueue.status, 'pending'), eq(jobQueue.status, 'processing')));
  return rows[0]?.n ?? 0;
}