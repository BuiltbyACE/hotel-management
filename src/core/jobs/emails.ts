/**
 * core/jobs/emails.ts
 *
 * Email job handlers (blueprint §15.2). Transactional email is a [P2] delivery
 * concern: RESEND_API_KEY is optional and dev/test has no SMTP, so these
 * handlers RESTORE their payloads and complete no-op. Swap the no-op for a
 * Resend call behind a feature flag when the delivery pipeline lands.
 */
import { createLogger } from '@/core/logger';
import { registerHandler } from './worker';

const EMAIL_JOBS = [
  'email.booking_confirmation',
  'email.night_audit_summary',
  'email.payment_receipt',
] as const;

/** Register no-op email handlers so enqueued jobs complete instead of dead-lettering. */
export function registerEmailJobHandlers(): void {
  for (const jobType of EMAIL_JOBS) {
    registerHandler(jobType, async () => {
      createLogger(jobType).debug('email delivery is not configured; skipping');
    });
  }
}