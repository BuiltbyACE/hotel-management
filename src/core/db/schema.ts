/**
 * core/db/schema.ts
 *
 * The app-side schema barrel — the single `schema` map handed to
 * `drizzle(pool, { schema })` in core/db/client.ts. Re-exports every table
 * owned by every module (the schema is the union of the modules' Drizzle
 * mirrors plus the cross-cutting infra tables).
 *
 * ⚠️ This file is the ONE place core may touch module schemas. The migration
 * (drizzle/0001_full_schema.sql) is the source of truth; these mirrors exist so
 * queries are typed. Every table here must match a CREATE TABLE there.
 *
 * Enums are deliberately NOT re-exported here: modules import their own enums
 * from their own schema.ts, and cross-module enum sharing happens through
 * service re-exports — never by importing another module's schema.
 */
import { accounts, sessions, twoFactors, verifications } from './auth-schema';
import { files, jobQueue, numberSequences, rateLimitAttempts } from './infra';

import { userPermissionOverrides, users } from '@/modules/identity/schema';
import { properties, rateRules, roomTypes, rooms, settings } from '@/modules/property/schema';
import { guestDocuments, guests } from '@/modules/guests/schema';
import { roomAllocations } from '@/modules/availability/schema';
import { bookingGuests, bookingNights, bookings } from '@/modules/bookings/schema';
import { folioCharges, invoiceLines, invoices, payments } from '@/modules/billing/schema';
import { maintenanceIssues, maintenanceUpdates } from '@/modules/maintenance/schema';
import { expenseCategories, expenses } from '@/modules/expenses/schema';
import { dailyStats, maintenanceCostView } from '@/modules/reporting/schema';
import { activityLogs, notifications } from '@/modules/audit/schema';

export const schema = {
  sessions,
  accounts,
  verifications,
  twoFactors,
  files,
  jobQueue,
  numberSequences,
  rateLimitAttempts,
  users,
  userPermissionOverrides,
  properties,
  settings,
  roomTypes,
  rooms,
  rateRules,
  guests,
  guestDocuments,
  roomAllocations,
  bookings,
  bookingNights,
  bookingGuests,
  folioCharges,
  invoices,
  invoiceLines,
  payments,
  maintenanceIssues,
  maintenanceUpdates,
  expenseCategories,
  expenses,
  dailyStats,
  maintenanceCostView,
  activityLogs,
  notifications,
};