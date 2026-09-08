/**
 * modules/maintenance/schema.ts
 *
 * Maintenance issues and their update trail. Owned tables (blueprint §5.1):
 * maintenance_issues, maintenance_updates. The cost-to-issue view
 * (maintenance_cost_view) is owned by modules/reporting (read model).
 *
 * Mirror of drizzle/0001_full_schema.sql §8. room_id → rooms, assigned_user_id
 * → users, and reported_by → users are SQL-only FKs.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const maintenancePriority = pgEnum('maintenance_priority', ['low', 'medium', 'high', 'urgent']);
export const maintenanceStatus = pgEnum('maintenance_status', ['reported', 'pending', 'in_progress', 'resolved', 'closed']);

export const maintenanceIssues = pgTable(
  'maintenance_issues',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    reference: text('reference').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    roomId: uuid('room_id'),
    location: text('location'),
    priority: maintenancePriority('priority').notNull().default('medium'),
    status: maintenanceStatus('status').notNull().default('reported'),
    assignedTo: text('assigned_to'),
    assignedUserId: uuid('assigned_user_id'),
    estimatedCost: numeric('estimated_cost', { precision: 14, scale: 2 }),
    takesRoomOffline: boolean('takes_room_offline').notNull().default(false),
    reportedBy: uuid('reported_by').notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    resolutionNotes: text('resolution_notes'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('maintenance_est_cost_check', sql`estimated_cost IS NULL OR estimated_cost >= 0`),
    check('maintenance_location_check', sql`room_id IS NOT NULL OR location IS NOT NULL`),
    uniqueIndex('maintenance_reference_uq').on(t.propertyId, t.reference),
    index('maintenance_open_idx').on(t.propertyId, t.status, t.priority).where(sql`status NOT IN ('resolved','closed')`),
    index('maintenance_room_idx').on(t.roomId),
  ],
);

export const maintenanceUpdates = pgTable(
  'maintenance_updates',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    issueId: uuid('issue_id').notNull(),
    fromStatus: maintenanceStatus('from_status'),
    toStatus: maintenanceStatus('to_status'),
    note: text('note'),
    fileIds: uuid('file_ids').array().notNull().default(sql`'{}'`),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('maintenance_updates_issue_idx').on(t.issueId)],
);