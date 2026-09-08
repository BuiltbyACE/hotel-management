/**
 * core/db/infra.ts
 *
 * Cross-cutting infrastructure TABLES that no business module owns:
 *   - files           (asset metadata; written by core/files, referenced by
 *                      properties.logo_file_id, room_types.photo_file_ids,
 *                      guest_documents, invoices.pdf_file_id, expenses.receipt_file_id)
 *   - job_queue       (the outbox; written by core/jobs)
 *   - number_sequences (gap-free reference/invoice numbering; written by core/db)
 *   - rate_limit_attempts (DB-backed rate limiting; written by core/rate-limit)
 *
 * These are defined here — NOT in a module — because core/ infra services write
 * them and the boundary rules forbid core from importing module schemas.
 * They live in core/db only for the Drizzle mirror; the real DDL is in
 * drizzle/0001_full_schema.sql (sections 5, 8, 9). [1:1 MIRROR]
 *
 * Enums file_visibility and job_status are shared by name across the whole
 * schema. Cross-module enum references are resolved by NAME at the Postgres
 * level; each schema that needs them declares its own pgEnum with identical
 * values (drizzle allows duplicate registrations).
 */
import { pgEnum, pgTable, uuid, text, timestamp, bigint, bigserial, smallint, jsonb, uniqueIndex, index, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const fileVisibility = pgEnum('file_visibility', ['public', 'private']);

export const jobStatus = pgEnum('job_status', ['pending', 'processing', 'completed', 'failed', 'dead']);

/**
 * files — metadata for uploaded objects (the blob itself lives in R2/core/files).
 * Mirrors drizzle/0001 §5. Cross-module references are SQL-only.
 */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    storageKey: text('storage_key').notNull(),
    visibility: fileVisibility('visibility').notNull().default('private'),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum'),
    thumbnailKey: text('thumbnail_key'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('files_entity_idx').on(t.entityType, t.entityId),
    index('files_property_idx').on(t.propertyId),
  ],
);

/**
 * job_queue — Postgres-backed outbox/queue. Skipped lock by core/jobs worker.
 * Mirrors drizzle/0001 §9.
 */
export const jobQueue = pgTable(
  'job_queue',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    propertyId: uuid('property_id'),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: jobStatus('status').notNull().default('pending'),
    priority: smallint('priority').notNull().default(5),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_queue_ready_idx').on(t.status, t.runAfter, t.priority).where(sql`status IN ('pending','processing')`),
    uniqueIndex('job_queue_dedupe_uq').on(t.dedupeKey).where(sql`dedupe_key IS NOT NULL AND status <> 'dead'`),
  ],
);

/**
 * number_sequences — gap-free per-property numbering under an advisory lock.
 * Mirrors drizzle/0001 §7. Composite PK mirrors the SQL primary key.
 */
export const numberSequences = pgTable(
  'number_sequences',
  {
    propertyId: uuid('property_id').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    period: text('period').notNull(),
    nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
  },
  (t) => [
    // mirrored `PRIMARY KEY (property_id, name, period)` — FK to properties is SQL-only
    primaryKey({ columns: [t.propertyId, t.name, t.period] }),
  ],
);

/**
 * rate_limit_attempts — DB-backed, multi-instance-safe rate limiting.
 * Buckets: `login:<email>`, `login:ip:<ip>`, `mutate:<userId>`, `report:<userId>`,
 * `export:<userId>` (blueprint §20.4). Swept hourly by the purge-rate-limits job.
 * Mirrors drizzle/0001 §4. Owned by core because core/rate-limit writes it and
 * core cannot import the identity module.
 */
export const rateLimitAttempts = pgTable(
  'rate_limit_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    bucket: text('bucket').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rate_limit_bucket_time_idx').on(t.bucket, t.attemptedAt)],
);