/**
 * modules/billing/events.ts
 *
 * Money-domain events (blueprint §15.3). Audit rides on these; nothing that
 * must survive a rollback is emitted here (that is the outbox's job).
 */
export const BILLING_EVENTS = {
  folioChargePosted: 'folio.charge_posted',
  folioChargeVoided: 'folio.charge_voided',
  invoiceIssued: 'invoice.issued',
  invoiceVoided: 'invoice.voided',
} as const;

export type BillingEventName = (typeof BILLING_EVENTS)[keyof typeof BILLING_EVENTS];