/**
 * modules/audit/types.ts
 *
 * Audit trail + user notification shapes (blueprint §6.5.8, §15.3). The audit
 * row is written INSIDE the triggering transaction (`recordAudit`) — same
 * discipline as the outbox — because activity_logs is append-only and must
 * never record work that rolled back.
 */
import type { Actor } from '@/modules/identity/auth-guard';

export type AuditRole = 'admin' | 'manager' | 'receptionist' | null;

export interface AuditActor {
  id: string | null;
  name: string;
  role: AuditRole;
}

/**
 * Build the audit identity from a signed-in actor. `name` is always present in
 * our user model; fall back to email defensively.
 */
export function auditActor(actor: Actor): AuditActor {
  return { id: actor.id, name: actor.name || actor.email, role: actor.role };
}

/** System actors (cron jobs, worker passes) that have no signed-in user. */
export const SYSTEM_ACTOR: AuditActor = { id: null, name: 'System', role: null };

export interface AuditDraft {
  actor: AuditActor;
  propertyId?: string | null;
  /** dotted action, e.g. 'bookings.create' */
  action: string;
  /** aggregate name, e.g. 'booking' */
  entityType: string;
  entityId?: string | null;
  summary: string;
  changes?: Record<string, unknown> | null;
}

export interface ActivityLogView {
  id: number;
  propertyId: string | null;
  actorId: string | null;
  actorName: string;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  changes: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface NotificationView {
  id: string;
  userId: string | null;
  role: string | null;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ListActivityLogsQuery {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export interface ListNotificationsQuery {
  includeRead: boolean;
  limit: number;
  offset: number;
}