/**
 * modules/audit/repository.ts
 *
 * Append-only activity_logs + user notifications. All INSERTs are plain DML —
 * the append-only RULES and hms_app grants are handled by the migration —
 * so `recordAudit` may run inside any service transaction.
 */
import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/core/db';
import { activityLogs, notifications, type userRole } from './schema';
import type { ActivityLogView, NotificationView } from './types';

type Role = (typeof userRole.enumValues)[number] | null;

export function insertActivityLog(tx: Tx, row: {
  propertyId: string | null;
  actorId: string | null;
  actorName: string;
  actorRole: Role;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  changes: Record<string, unknown> | null;
}): Promise<{ id: number }> {
  return tx
    .insert(activityLogs)
    .values({
      propertyId: row.propertyId,
      actorId: row.actorId,
      actorName: row.actorName,
      actorRole: row.actorRole ?? undefined,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      summary: row.summary,
      changes: row.changes,
    })
    .returning({ id: activityLogs.id })
    .then((rows) => rows[0]!);
}

export async function listActivityLogs(db: Db, q: {
  propertyId?: string | null;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}): Promise<{ data: ActivityLogView[]; total: number }> {
  const conds = [];
  if (q.propertyId) conds.push(eq(activityLogs.propertyId, q.propertyId));
  if (q.entityType) conds.push(eq(activityLogs.entityType, q.entityType));
  if (q.entityId) conds.push(eq(activityLogs.entityId, q.entityId));
  if (q.actorId) conds.push(eq(activityLogs.actorId, q.actorId));
  if (q.action) conds.push(eq(activityLogs.action, q.action));
  if (q.from) conds.push(gte(activityLogs.createdAt, new Date(q.from)));
  if (q.to) conds.push(lte(activityLogs.createdAt, new Date(q.to)));

  const where = conds.length ? and(...conds) : undefined;

  const [rows, total] = await Promise.all([
    db.select().from(activityLogs).where(where).orderBy(desc(activityLogs.id)).limit(q.limit).offset(q.offset),
    db.select({ n: count() }).from(activityLogs).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id,
      propertyId: r.propertyId,
      actorId: r.actorId,
      actorName: r.actorName,
      actorRole: r.actorRole,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      summary: r.summary,
      changes: r.changes as Record<string, unknown> | null,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
    total: total[0]?.n ?? 0,
  };
}

export function insertNotifications(tx: Tx, rows: {
  userId?: string | null;
  role?: Role;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
}[]): Promise<{ id: string }[]> {
  return tx
    .insert(notifications)
    .values(
      rows.map((r) => ({
        userId: r.userId ?? null,
        role: r.role ?? undefined,
        type: r.type,
        title: r.title,
        body: r.body ?? null,
        link: r.link ?? null,
      })),
    )
    .returning({ id: notifications.id });
}

export async function listNotifications(db: Db, userId: string, q: {
  includeRead: boolean;
  limit: number;
  offset: number;
}): Promise<{ data: NotificationView[]; total: number; unreadCount: number }> {
  const where = q.includeRead
    ? eq(notifications.userId, userId)
    : and(eq(notifications.userId, userId), sql`${notifications.readAt} IS NULL`);

  const [rows, total, unread] = await Promise.all([
    db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(q.limit).offset(q.offset),
    db.select({ n: count() }).from(notifications).where(where),
    db.select({ n: count() }).from(notifications).where(
      and(eq(notifications.userId, userId), sql`${notifications.readAt} IS NULL`),
    ),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      role: r.role,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    total: total[0]?.n ?? 0,
    unreadCount: unread[0]?.n ?? 0,
  };
}

export async function markNotificationRead(tx: Tx, userId: string, id: string): Promise<string | null> {
  const rows = await tx
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId), sql`${notifications.readAt} IS NULL`))
    .returning({ id: notifications.id });
  return rows[0]?.id ?? null;
}