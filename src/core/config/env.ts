/**
 * core/config/env.ts
 *
 * Zod-parsed environment that throws at import time.
 * If any required variable is missing, the process refuses to boot.
 * This is deliberate — fail closed, never silently degrade.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  APP_URL: z.string().url().default('http://localhost:3000'),

  // Database — two roles, two URLs
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MIGRATION_DATABASE_URL: z.string().min(1, 'MIGRATION_DATABASE_URL is required'),
  REQUIRE_MIGRATIONS: z.coerce.boolean().default(false),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url(),

  // Hotel
  HOTEL_TIMEZONE: z.string().default('Africa/Nairobi'),
  DEFAULT_CURRENCY: z.string().default('KES'),

  // Storage (Cloudflare R2)
  R2_ACCOUNT_ID: z.string().min(1, 'R2_ACCOUNT_ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2_ACCESS_KEY_ID is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2_SECRET_ACCESS_KEY is required'),
  R2_BUCKET_PRIVATE: z.string().min(1, 'R2_BUCKET_PRIVATE is required'),
  R2_BUCKET_PUBLIC: z.string().min(1, 'R2_BUCKET_PUBLIC is required'),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),

  // Email (Resend) — optional in dev
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),

  // Jobs & cron
  CRON_SECRET: z.string().min(32, 'CRON_SECRET must be at least 32 characters'),
  JOB_WORKER_ENABLED: z.coerce.boolean().default(true),
  NIGHT_AUDIT_HOUR: z.coerce.number().int().min(0).max(23).default(3),

  // Observability
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
}).refine(
  (data) => {
    // In production, SENTRY_DSN and RESEND_API_KEY are required.
    // `next build` sets NODE_ENV=production too, so exempt the compile phase
    // (NEXT_PHASE='phase-production-build') — these are runtime-only concerns.
    const isBuild = process.env.NEXT_PHASE === 'phase-production-build';
    if (data.NODE_ENV === 'production' && !isBuild) {
      return !!data.SENTRY_DSN && !!data.RESEND_API_KEY;
    }
    return true;
  },
  {
    message: 'SENTRY_DSN and RESEND_API_KEY are required in production',
  },
);

function loadEnv() {
  // In Next.js, env is loaded automatically from .env files.
  // For scripts/test runners, we use dotenv-cli.
  return EnvSchema.parse(process.env);
}

export const env = loadEnv();
