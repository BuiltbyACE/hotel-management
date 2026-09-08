/**
 * modules/guests/schema.ts
 *
 * Guest profiles and documents. Owned tables (blueprint §5.1): guests,
 * guest_documents. Mirror of drizzle/0001_full_schema.sql §5.
 *
 * Trigram search (guests_name_trgm) and the dedupe index on ID number are
 * partial indexes enforced by the migration. Cross-module FKs to users
 * (created_by / uploaded_by) are SQL-only.
 */
import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const idDocumentType = pgEnum('id_document_type', ['national_id', 'passport', 'driving_licence', 'military', 'other']);

export const guests = pgTable(
  'guests',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    email: text('email'),
    idType: idDocumentType('id_type'),
    idNumber: text('id_number'),
    nationality: text('nationality'),
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    address: text('address'),
    company: text('company'),
    notes: text('notes'),
    isBlacklisted: boolean('is_blacklisted').notNull().default(false),
    blacklistReason: text('blacklist_reason'),
    stayCount: integer('stay_count').notNull().default(0),
    lifetimeValue: numeric('lifetime_value', { precision: 14, scale: 2 }).notNull().default('0'),
    lastStayDate: date('last_stay_date', { mode: 'string' }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('guests_id_number_uq')
      .on(sql`${t.propertyId}, ${t.idType}, upper(${t.idNumber})`)
      .where(sql`${t.idNumber} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    index('guests_name_trgm').using('gin', sql`${t.fullName} gin_trgm_ops`),
    index('guests_phone_idx').on(t.propertyId, t.phone).where(sql`${t.phone} IS NOT NULL`),
    index('guests_email_idx').on(sql`${t.propertyId}, lower(${t.email})`).where(sql`${t.email} IS NOT NULL`),
  ],
);

export const guestDocuments = pgTable(
  'guest_documents',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    guestId: uuid('guest_id').notNull(),
    fileId: uuid('file_id').notNull(),
    docType: idDocumentType('doc_type').notNull(),
    uploadedBy: uuid('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('guest_documents_guest_idx').on(t.guestId)],
);