/**
 * modules/audit/events.ts
 *
 * Notifications are created imperatively inside the same transaction as the
 * business write (see service.ts `notify`), not through the bus — mirroring
 * the audit rule. AUDIT_EVENTS exists for cross-module subscribers that want
 * to react AFTER a notification lands (e.g. the housekeeping board).
 */
export const AUDIT_EVENTS = {
  notificationCreated: 'notification.created',
} as const;

export type AuditEventName = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];