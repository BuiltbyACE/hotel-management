/**
 * Integration test: outbox enqueue + in-process worker (SKIP LOCKED claim).
 * Requires a running Postgres (docker-compose up -d).
 *
 * job_queue is DELETE-revoked for hms_app, so cleanup runs as the migration
 * role with a dedicated pool.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeMigratorPool, runAsMigrator, withDb, withTx } from '@/core/db';
import { jobQueue } from '@/core/db/infra';
import { enqueue, type JobSpec } from '@/core/jobs';
import { registerHandler, runWorkerPass } from '@/core/jobs/worker';

const suffix = Date.now().toString(36);
const jobType = `it.${suffix}`;
const jobTypeFail = `it.fail.${suffix}`;

// The app role cannot DELETE job_queue rows; clean up as the migration role.
beforeAll(async () => {
  registerHandler(jobType, async (payload) => {
    handledPayloads.push(payload);
  });
  registerHandler(jobTypeFail, async () => {
    throw new Error('boom');
  });
  // The bookings suites run in parallel workers and enqueue real jobs for
  // these types. Register no-ops so they complete instead of re-queuing and
  // starving the queue while this file's single-threaded passes are running.
  registerHandler('email.booking_confirmation', async () => {});
  registerHandler('realtime.broadcast', async () => {});
});

afterAll(async () => {
  await runAsMigrator(`DELETE FROM job_queue WHERE job_type = $1 OR job_type = $2`, [jobType, jobTypeFail]);
  await closeMigratorPool();
});

const handledPayloads: Record<string, unknown>[] = [];

/**
 * Parallel suites (bookings) keep enqueueing jobs while this file runs, and one
 * worker pass claims a fixed batch. Instead of asserting on a single pass, pump
 * passes until `done()` is satisfied or we exhaust a generous budget.
 */
async function pumpUntil(done: () => Promise<boolean>, maxPasses = 200): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxPasses; i++) {
    processed += await withDb((db) => runWorkerPass(db));
    if (await done()) break;
  }
  return processed;
}

describe('outbox + worker', () => {
  it('enqueues, claims exactly once, runs the handler, marks completed', async () => {
    const spec: JobSpec = { jobType, payload: { a: 1 }, propertyId: undefined };
    const ids = await withTx((tx) => enqueue(tx, [spec]));

    const done = async () => {
      const r = await withDb((db) => db.select({ status: jobQueue.status }).from(jobQueue).where(eq(jobQueue.id, ids[0]!)));
      return r[0]?.status === 'completed';
    };
    const processed = await pumpUntil(done);

    const rows = await withDb((db) =>
      db.select().from(jobQueue).where(eq(jobQueue.id, ids[0]!)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(handledPayloads.some((p) => p.a === 1)).toBe(true);
  });

  it('dedupes on dedupe_key via the partial unique index', async () => {
    const spec: JobSpec = {
      jobType,
      payload: { ref: 'X1' },
      dedupeKey: `it.${suffix}.send-1`,
    };
    await withTx((tx) => enqueue(tx, [spec]));
    await withTx((tx) => enqueue(tx, [spec]));

    const count = await withDb((db) =>
      db.select({ id: jobQueue.id }).from(jobQueue).where(eq(jobQueue.dedupeKey, spec.dedupeKey!)),
    );
    expect(count).toHaveLength(1);
  });

  it('failing handler schedules a retry with backoff then goes dead', async () => {
    const id = Date.now().toString(36);
    const failSpec: JobSpec = { jobType: jobTypeFail, payload: { id }, maxAttempts: 2 };

    const [jobId] = await withTx((tx) => enqueue(tx, [failSpec]));

    // attempt 1 → fails → pending, attempts=1, run_after pushed ~2s out
    const rowFor = () => withDb((db) => db.select().from(jobQueue).where(eq(jobQueue.id, jobId!)));
    const claimed = async () => (await rowFor())[0]?.attempts !== undefined && (await rowFor())[0]!.attempts >= 1;
    await pumpUntil(claimed);

    let row = await rowFor();
    expect(row[0]?.status).toBe('pending');
    expect(row[0]?.attempts).toBe(1);
    expect(row[0]?.runAfter!.getTime()).toBeGreaterThan(Date.now());
    expect(row[0]?.lastError).toContain('boom');

    // attempt 2 (force run_after to now) → dead
    await withDb((db) =>
      db.update(jobQueue).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(jobQueue.id, jobId!)),
    );
    const dead = async () => (await rowFor())[0]?.status === 'dead';
    await pumpUntil(dead);
    row = await rowFor();
    expect(row[0]?.status).toBe('dead');
    expect(row[0]?.attempts).toBe(2);
  });
});