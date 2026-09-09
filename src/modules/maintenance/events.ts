/**
 * modules/maintenance/events.ts
 *
 * Maintenance domain events (blueprint §14). Emitted through the event bus
 * inside the writer's transaction; subscribers (notifications, realtime) react
 * after commit.
 */
export const MAINTENANCE_EVENTS = {
  issueReported: 'maintenance.issue_reported',
  issueAssigned: 'maintenance.issue_assigned',
  issueStatusChanged: 'maintenance.issue_status_changed',
  issueResolved: 'maintenance.issue_resolved',
} as const;

export interface MaintenanceIssueEvent {
  issueId: string;
  reference: string;
  title: string;
  propertyId: string;
  roomId: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  by: string;
}