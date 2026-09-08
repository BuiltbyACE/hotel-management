/**
 * core/mail/index.ts
 *
 * Email adapter behind a small interface. Resend in production; a logging
 * no-op when RESEND_API_KEY is absent (dev). No module depends on Resend
 * directly — they depend on `sendMail`.
 */
import { Resend } from 'resend';
import { env } from '@/core/config/env';
import { createLogger } from '@/core/logger';

export interface MailMessage {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

const logger = createLogger('mail');

class ResendMailer implements Mailer {
  private client: Resend;

  constructor() {
    this.client = new Resend(env.RESEND_API_KEY!);
  }

  async send({ to, subject, html, text }: MailMessage): Promise<void> {
    const res = await this.client.emails.send({
      from: env.MAIL_FROM!,
      to,
      subject,
      html: html ?? text ?? '',
      text,
    });
    if (res.error) throw new Error(`Resend error: ${res.error.message}`);
  }
}

class NoopMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    logger.info({ to: message.to, subject: message.subject }, 'mail (no-op): set RESEND_API_KEY to enable');
  }
}

let activeMailer: Mailer = env.RESEND_API_KEY && env.MAIL_FROM
  ? new ResendMailer()
  : new NoopMailer();

/** Send an email with the configured mailer. Swappable via setMailer in tests. */
export function sendMail(message: MailMessage): Promise<void> {
  return activeMailer.send(message);
}

/** Test seam. */
export function setMailer(m: Mailer): void {
  activeMailer = m;
}