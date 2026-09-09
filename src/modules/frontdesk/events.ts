/**
 * modules/frontdesk/events.ts
 *
 * Front-desk lifecycle events (blueprint §13.3 night audit).
 */
export const FRONTDESK_EVENTS = {
  nightAuditCompleted: 'frontdesk.night_audit_completed',
} as const;