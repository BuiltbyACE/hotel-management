/**
 * modules/audit/service.ts
 *
 * The audit trail + notifications facade (blueprint §6.5.8). `recordAudit` and
 * `notify` run inside the caller's transaction — same discipline as the outbox
 * — so an activity row can never describe rolled-back work and a notification
 * is never sent for a failed write.
 */
import { AppError } from '@/core/api';
import { withDb, withTx, type Tx } from '@/core/db';
import {
  insertActivityLog,
  insertNotifications,
  listActivityLogs,
  listNotifications,
  markNotificationRead as markNotificationReadRow,
} from './repository';
import type {
  AuditDraft,
  ActivityLogView,
  ListActivityLogsQuery,
  ListNotificationsQuery,
  NotificationView,
} from './types';

export { auditActor, SYSTEM_ACTOR } from './types';

/** Write one audit row inside `tx`. Must be called before tx commits. */
export async function recordAudit(tx: Tx, draft: AuditDraft): Promise<void> {
  await insertActivityLog(tx, {
    propertyId: draft.propertyId ?? null,
    actorId: draft.actor.id,
    actorName: draft.actor.name,
    actorRole: draft.actor.role,
    action: draft.action,
    entityType: draft.entityType,
    entityId: draft.entityId ?? null,
    summary: draft.summary,
    changes: draft.changes ?? null,
  });
}

/** Create one or more user notifications inside `tx`. */
export async function notify(tx: Tx, rows: {
  userId?: string;
  role?: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const inserted = await insertNotifications(tx, rows.map((r) => ({
    userId: r.userId ?? null,
    role: (r.role as 'admin' | 'manager' | 'receptionist' | null | undefined) ?? null,
    type: r.type,
    title: r.title,
    body: r.body ?? null,
    link: r.link ?? null,
  })));
  return inserted.map((r) => r.id);
}

/** List the scoped audit trail. Admins without a property see everything. */
export async function listActivityLogsRoute(q: ListActivityLogsQuery, propertyId: string | null): Promise<{ data: ActivityLogView[]; total: number }> {
  return withDb((db) =>
    listActivityLogs(db, {
      propertyId,
      entityType: q.entityType,
      entityId: q.entityId,
      actorId: q.actorId,
      action: q.action,
      from: q.from,
      to: q.to,
      limit: q.limit,
      offset: q.offset,
    }),
  );
}

export async function listMyNotifications(userId: string, q: ListNotificationsQuery): Promise<{ data: NotificationView[]; total: number; unreadCount: number }> {
  return withDb((db) => listNotifications(db, userId, q));
}

export async function markNotificationRead(id: string, userId: string): Promise<{ id: string; readAt: string }> {
  return withTx(async (tx) => {
    const updated = await markNotificationReadRow(tx, userId, id);
    if (!updated) throw AppError.notFound('Notification not found');
    return { id, readAt: new Date().toISOString() };
  });
}