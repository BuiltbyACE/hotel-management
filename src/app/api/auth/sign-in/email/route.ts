/**
 * Login throttle (§20.1, §20.4): DB-backed guard in front of Better Auth's
 * intrinsic sign-in handler. Bad credentials cost the attempt; 5 failures in
 * 15 min lock BOTH the email and the source IP (buckets login:<email> and
 * login:ip:<ip>). In-memory limiters are banned by the blueprint — the
 * verdict comes from rate_limit_attempts (multi-instance safe, swept hourly
 * by purge-rate-limits).
 */
import { z } from 'zod';
import { apiHandler, AppError, problemResponse, validateBody } from '@/core/api';
import { auth } from '@/core/auth/config';
import { getDb } from '@/core/db';
import { checkLimit, recordAttempt } from '@/core/rate-limit';

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60;

const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string().min(1),
});

function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export const POST = apiHandler(async (req) => {
  const { email, password } = await validateBody(req, loginBodySchema);

  const db = getDb();
  const ip = clientIp(req);
  const [byEmail, byIp] = await Promise.all([
    checkLimit(db, `login:${email}`, { max: MAX_ATTEMPTS, windowSeconds: WINDOW_SECONDS }),
    checkLimit(db, `login:ip:${ip}`, { max: MAX_ATTEMPTS, windowSeconds: WINDOW_SECONDS }),
  ]);

  if (!byEmail.allowed || !byIp.allowed) {
    const retryAfterSeconds = Math.max(byEmail.retryAfterSeconds, byIp.retryAfterSeconds);
    const response = problemResponse(AppError.tooMany('Too many sign-in attempts. Try again later.'), {
      instance: '/api/auth/sign-in/email',
    });
    response.headers.set('Retry-After', String(retryAfterSeconds));
    return response;
  }

  // Forward to Better Auth; its Response already carries the Set-Cookie.
  const forwarded = await auth.api.signInEmail({
    body: { email, password },
    headers: req.headers,
    asResponse: true,
  });

  // Only genuine credential failures (401) count against the budget.
  if (!forwarded.ok && forwarded.status === 401) {
    await Promise.all([
      recordAttempt(db, `login:${email}`),
      recordAttempt(db, `login:ip:${ip}`),
    ]);
  }

  return forwarded;
});