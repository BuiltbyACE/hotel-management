/**
 * modules/audit/schema.ts
 *
 * The audit trail and user notifications. Owned tables (blueprint §5.1):
 * activity_logs, notifications.
 *
 * Mirror of drizzle/0001_full_schema.sql §9. activity_logs is APPEND-ONLY:
 * the migration adds `no_update`/`no_delete` RULES AND revokes DML grants from
 * hms_app. Inserts only, forever. user_role is re-declared here (audit needs
 * the actor's role; sharing by name with identity — see sqlite note in the
 * module's validation.ts).
 */
import { sql } from 'drizzle-orm';
import { bigserial, index, inet, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['admin', 'manager', 'receptionist']);

export const activityLogs = pgTable(
  'activity_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    propertyId: uuid('property_id'),
    actorId: uuid('actor_id'),
    actorName: text('actor_name').notNull(),
    actorRole: userRole('actor_role'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    summary: text('summary').notNull(),
    changes: jsonb('changes'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('activity_entity_idx').on(t.entityType, t.entityId, t.createdAt),
    index('activity_actor_idx').on(t.actorId, t.createdAt),
    index('activity_action_idx').on(t.action, t.createdAt),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    userId: uuid('user_id'),
    role: userRole('role'),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_unread_idx').on(t.userId, t.createdAt).where(sql`read_at IS NULL`)],
);