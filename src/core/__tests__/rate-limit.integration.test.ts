/**
 * Integration test: DB-backed rate limiting (multi-instance safe).
 * Requires a running Postgres (docker-compose up -d).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withDb } from '@/core/db';
import { rateLimitAttempts } from '@/core/db/infra';
import {
  checkLimit,
  countAttempts,
  purgeRateLimits,
  recordAttempt,
  type RateLimitBucket,
} from '@/core/rate-limit';

const bucket: RateLimitBucket = `mutate:${'it-' + Date.now().toString(36)}`;

afterEach(async () => {
  await withDb((db) =>
    db.delete(rateLimitAttempts).where(eq(rateLimitAttempts.bucket, bucket)),
  );
});

describe('rate-limit (DB-backed)', () => {
  it('counts attempts inside the window and ignores older ones', async () => {
    await withDb((db) => recordAttempt(db, bucket, new Date(Date.now() - 120_000))); // 2 min ago
    await withDb((db) => recordAttempt(db, bucket)); // now

    expect(await withDb((db) => countAttempts(db, bucket, 60))).toBe(1);
    expect(await withDb((db) => countAttempts(db, bucket, 300))).toBe(2);
  });

  it('allows under the limit then blocks with a Retry-After', async () => {
    const before = await withDb((db) => checkLimit(db, bucket, { max: 2, windowSeconds: 60 }));
    expect(before.allowed).toBe(true);

    await withDb((db) => recordAttempt(db, bucket, new Date(Date.now() - 40_000)));
    await withDb((db) => recordAttempt(db, bucket, new Date(Date.now() - 10_000)));

    const blocked = await withDb((db) => checkLimit(db, bucket, { max: 2, windowSeconds: 60 }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.attempts).toBe(2);
    // Oldest attempt (40s ago) ages out 20s from now → Retry-After ≈ 20
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(19);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(21);
  });

  it('purges old rows and leaves recent ones', async () => {
    const oldBucket: RateLimitBucket = `${bucket}:old`;
    await withDb((db) =>
      db.insert(rateLimitAttempts).values([
        { bucket, attemptedAt: new Date(Date.now() - 25 * 3600_000) },
        { bucket, attemptedAt: new Date() },
      ]),
    );
    await withDb((db) => purgeRateLimits(db, 24));

    const remaining = await withDb((db) =>
      db.select({ n: rateLimitAttempts.id }).from(rateLimitAttempts)
        .where(and(eq(rateLimitAttempts.bucket, bucket))),
    );
    expect(remaining).toHaveLength(1);
    await withDb((db) =>
      db.delete(rateLimitAttempts).where(and(eq(rateLimitAttempts.bucket, bucket), eq(rateLimitAttempts.bucket, oldBucket))),
    );
  });
});