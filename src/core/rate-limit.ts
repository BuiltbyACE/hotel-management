/**
 * core/rate-limit.ts
 *
 * DB-backed rate limiting — multi-instance safe, no Redis.
 * The blueprint (§20.4) bans in-memory limiters because a restart forgets the
 * budget; `rate_limit_attempts` survives restarts and works across instances.
 *
 * Buckets: `login:<email>`, `login:ip:<ip>`, `mutate:<userId>`,
 * `report:<userId>`, `export:<userId>`. Swept hourly by purge-rate-limits.
 */
import { and, count, eq, gte, lt } from 'drizzle-orm';
import { AppError } from '@/core/api/errors';
import { rateLimitAttempts } from './db/infra';
import type { Db, Tx } from './db/index';
import { withDb } from './db/index';

export type RateLimitBucket =
  | `login:${string}`
  | `login:ip:${string}`
  | `mutate:${string}`
  | `report:${string}`
  | `export:${string}`;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  attempts: number;
}

/**
 * Record an attempt (call BEFORE returning 429 / before a failed login).
 */
export async function recordAttempt(
  db: Db,
  bucket: RateLimitBucket,
  at: Date = new Date(),
): Promise<void> {
  await db.insert(rateLimitAttempts).values({ bucket, attemptedAt: at });
}

/**
 * Count attempts in the last `windowSeconds`.
 */
export async function countAttempts(
  db: Db,
  bucket: RateLimitBucket,
  windowSeconds: number,
  at: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(at.getTime() - windowSeconds * 1000);
  const rows = await db
    .select({ n: count() })
    .from(rateLimitAttempts)
    .where(and(gte(rateLimitAttempts.attemptedAt, cutoff), eq(rateLimitAttempts.bucket, bucket)));
  return rows[0]?.n ?? 0;
}

/**
 * Check whether `bucket` is over `max` attempts in the last `windowSeconds`.
 * When limited, computes Retry-After from the oldest attempt still in the
 * window (the moment the oldest attempt ages out).
 */
export async function checkLimit(
  db: Db,
  bucket: RateLimitBucket,
  opts: { max: number; windowSeconds: number; at?: Date },
): Promise<RateLimitDecision> {
  const at = opts.at ?? new Date();
  const cutoff = new Date(at.getTime() - opts.windowSeconds * 1000);
  const attempts = await countAttempts(db, bucket, opts.windowSeconds, at);
  if (attempts < opts.max) {
    return { allowed: true, retryAfterSeconds: 0, attempts };
  }

  const rows = await db
    .select({ first: rateLimitAttempts.attemptedAt })
    .from(rateLimitAttempts)
    .where(and(gte(rateLimitAttempts.attemptedAt, cutoff), eq(rateLimitAttempts.bucket, bucket)))
    .orderBy(rateLimitAttempts.attemptedAt)
    .limit(1);
  const first = rows[0]?.first?.getTime() ?? at.getTime();
  const retryInMs = first + opts.windowSeconds * 1000 - at.getTime();
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(retryInMs / 1000)),
    attempts,
  };
}

/**
 * Same check usable with a transaction client.
 */
export function checkLimitTx(
  tx: Tx,
  bucket: RateLimitBucket,
  opts: { max: number; windowSeconds: number; at?: Date },
): Promise<RateLimitDecision> {
  return checkLimit(tx as unknown as Db, bucket, opts);
}

/**
 * Enforce a throttle in one turn: check the window, then record the attempt.
 * The check happens BEFORE the write so exactly `max` requests per window
 * succeed (check-then-record). On denial, throws a 429 AppError that carries
 * Retry-After (serialised by problemResponse).
 */
export async function enforceRateLimit(
  bucket: RateLimitBucket,
  opts: { max: number; windowSeconds: number; at?: Date },
): Promise<void> {
  await withDb(async (db) => {
    const decision = await checkLimit(db, bucket, opts);
    if (!decision.allowed) {
      throw AppError.tooMany('Rate limit exceeded. Try again later.', decision.retryAfterSeconds);
    }
    await recordAttempt(db, bucket);
  });
}

/**
 * Purge attempts older than `ttlHours` — the hourly sweep job. Returns the
 * number of rows removed.
 */
export async function purgeRateLimits(db: Db, ttlHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - ttlHours * 3600 * 1000);
  const rows = await db
    .delete(rateLimitAttempts)
    .where(lt(rateLimitAttempts.attemptedAt, cutoff))
    .returning({ id: rateLimitAttempts.id });
  return rows.length;
}