/**
 * core/jobs/outbox.ts
 *
 * The outbox (blueprint §15.2). Side effects NEVER run inside a write
 * transaction — they are enqueued in the SAME transaction so they cannot be
 * lost and cannot fire for a rolled-back booking, then executed by the worker.
 *
 * `dedupeKey` rides the partial unique index (dedupe_key NOT NULL AND
 * status <> 'dead') so "send booking confirmation for BK-000412" can be
 * enqueued twice and delivered once.
 */
import { jobQueue } from '@/core/db/infra';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@/core/db';

export interface JobSpec {
  /** Registered handler name, e.g. 'booking.confirmation-email'. */
  jobType: string;
  payload: Record<string, unknown>;
  propertyId?: string;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
  /** Optional idempotency key — the queue dedupes on this (partial unique). */
  dedupeKey?: string;
}

/**
 * Insert jobs into the queue as part of the surrounding transaction.
 */
export async function enqueue(tx: Tx, jobs: JobSpec[]): Promise<number[]> {
  const rows = await tx
    .insert(jobQueue)
    .values(
      jobs.map((j) => ({
        jobType: j.jobType,
        payload: j.payload,
        propertyId: j.propertyId,
        priority: j.priority ?? 5,
        runAfter: j.runAfter,
        maxAttempts: j.maxAttempts ?? 5,
        dedupeKey: j.dedupeKey,
      })),
    )
    .onConflictDoNothing({ target: jobQueue.dedupeKey, where: dedupeTarget() })
    .returning({ id: jobQueue.id });

  return rows.map((r) => r.id);
}

function dedupeTarget(): SQL<unknown> {
  return sql`${jobQueue.dedupeKey} IS NOT NULL AND ${jobQueue.status} <> 'dead'`;
}

/**
 * Convenience: enqueue a single job.
 */
export function enqueueOne(tx: Tx, job: JobSpec): Promise<number[]> {
  return enqueue(tx, [job]);
}