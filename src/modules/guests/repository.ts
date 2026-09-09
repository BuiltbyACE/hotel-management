/**
 * modules/guests/repository.ts
 *
 * All SQL for the guest context. No business rules — queries.
 * Cross-module reads (bookings/booking_guests for the delete guard and the
 * merge re-point) go through the core schema barrel, mirroring the property
 * module's allocation-ledger read — the sanctioned path for read-only joins
 * to tables owned by other modules.
 */
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { schema, type Db, type Tx } from '@/core/db';
import { guestDocuments, guests } from './schema';
import type { IdDocumentType } from './types';

export interface GuestRecord {
  id: string;
  propertyId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  idType: IdDocumentType | null;
  idNumber: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  address: string | null;
  company: string | null;
  notes: string | null;
  isBlacklisted: boolean;
  blacklistReason: string | null;
  stayCount: number;
  lifetimeValue: string;
  lastStayDate: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface GuestDocumentRecord {
  id: string;
  guestId: string;
  fileId: string;
  docType: IdDocumentType;
  uploadedBy: string | null;
  createdAt: Date;
}

const GUEST_COLUMNS = {
  id: guests.id,
  propertyId: guests.propertyId,
  fullName: guests.fullName,
  phone: guests.phone,
  email: guests.email,
  idType: guests.idType,
  idNumber: guests.idNumber,
  nationality: guests.nationality,
  dateOfBirth: guests.dateOfBirth,
  address: guests.address,
  company: guests.company,
  notes: guests.notes,
  isBlacklisted: guests.isBlacklisted,
  blacklistReason: guests.blacklistReason,
  stayCount: guests.stayCount,
  lifetimeValue: guests.lifetimeValue,
  lastStayDate: guests.lastStayDate,
  createdBy: guests.createdBy,
  createdAt: guests.createdAt,
  updatedAt: guests.updatedAt,
  deletedAt: guests.deletedAt,
};

const DOCUMENT_COLUMNS = {
  id: guestDocuments.id,
  guestId: guestDocuments.guestId,
  fileId: guestDocuments.fileId,
  docType: guestDocuments.docType,
  uploadedBy: guestDocuments.uploadedBy,
  createdAt: guestDocuments.createdAt,
};

const ACTIVE_GUEST = sql`${guests.deletedAt} IS NULL`;

// ─── Scope ───────────────────────────────────────────────────────────────────

/** actor.propertyId, or the single active property when the actor is unbound. */
export async function resolvePropertyId(db: Db, preferred: string | null): Promise<string | null> {
  if (preferred) return preferred;
  const rows = await db
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(eq(schema.properties.isActive, true))
    .orderBy(asc(schema.properties.name))
    .limit(1);
  return rows[0]?.id ?? null;
}

// ─── Guests ──────────────────────────────────────────────────────────────────

export async function findGuestById(db: Db, id: string): Promise<GuestRecord | null> {
  const rows = await db.select(GUEST_COLUMNS).from(guests).where(and(eq(guests.id, id), ACTIVE_GUEST)).limit(1);
  return rows[0] ?? null;
}

/** Dedupe on identity document: case-insensitive id_number within a property. */
export async function findGuestByIdNumber(
  db: Db | Tx,
  propertyId: string,
  idType: IdDocumentType,
  idNumber: string,
): Promise<GuestRecord | null> {
  const rows = await db
    .select(GUEST_COLUMNS)
    .from(guests)
    .where(
      and(eq(guests.propertyId, propertyId), eq(guests.idType, idType), sql`upper(${guests.idNumber}) = upper(${idNumber})`, ACTIVE_GUEST),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Dedupe on phone (exact match, property-scoped), returning the newest first. */
export async function findGuestByPhone(db: Db | Tx, propertyId: string, phone: string): Promise<GuestRecord | null> {
  const rows = await db
    .select(GUEST_COLUMNS)
    .from(guests)
    .where(and(eq(guests.propertyId, propertyId), sql`${guests.phone} = ${phone}`, ACTIVE_GUEST))
    .orderBy(sql`${guests.createdAt} DESC`)
    .limit(1);
  return rows[0] ?? null;
}

export interface GuestListFilters {
  propertyId: string;
  search?: string;
  limit: number;
  offset: number;
}

export type GuestListFilterCore = Omit<GuestListFilters, 'limit' | 'offset'>;

export function guestFilters(f: GuestListFilterCore) {
  const search = f.search?.trim();
  return and(
    eq(guests.propertyId, f.propertyId),
    ACTIVE_GUEST,
    search
      ? or(
          ilike(guests.fullName, `%${search}%`),
          ilike(guests.phone, `%${search}%`),
          ilike(guests.idNumber, `%${search}%`),
          ilike(guests.email, `%${search}%`),
        )
      : undefined,
  );
}

export async function listGuests(db: Db, filters: GuestListFilters): Promise<GuestRecord[]> {
  return db
    .select(GUEST_COLUMNS)
    .from(guests)
    .where(guestFilters(filters))
    .orderBy(asc(guests.fullName))
    .limit(filters.limit)
    .offset(filters.offset);
}

export async function countGuests(db: Db, filters: GuestListFilterCore): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(guests).where(guestFilters(filters));
  return rows[0]?.n ?? 0;
}

export function insertGuest(tx: Tx, input: {
  propertyId: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  idType?: IdDocumentType | null;
  idNumber?: string | null;
  nationality?: string | null;
  dateOfBirth?: string | null;
  address?: string | null;
  company?: string | null;
  notes?: string | null;
  createdBy: string | null;
}): Promise<GuestRecord> {
  return tx
    .insert(guests)
    .values({
      propertyId: input.propertyId,
      fullName: input.fullName,
      phone: input.phone ?? null,
      email: input.email ?? null,
      idType: input.idType ?? null,
      idNumber: input.idNumber ?? null,
      nationality: input.nationality ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      address: input.address ?? null,
      company: input.company ?? null,
      notes: input.notes ?? null,
      createdBy: input.createdBy,
    })
    .returning(GUEST_COLUMNS)
    .then((rows) => rows[0]!);
}

export function updateGuestById(tx: Tx, id: string, patch: {
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  idType?: IdDocumentType | null;
  idNumber?: string | null;
  nationality?: string | null;
  dateOfBirth?: string | null;
  address?: string | null;
  company?: string | null;
  notes?: string | null;
}): Promise<GuestRecord> {
  const values: Record<string, unknown> = {};
  if (patch.fullName !== undefined) values.fullName = patch.fullName;
  if (patch.phone !== undefined) values.phone = patch.phone;
  if (patch.email !== undefined) values.email = patch.email;
  if (patch.idType !== undefined) values.idType = patch.idType;
  if (patch.idNumber !== undefined) values.idNumber = patch.idNumber;
  if (patch.nationality !== undefined) values.nationality = patch.nationality;
  if (patch.dateOfBirth !== undefined) values.dateOfBirth = patch.dateOfBirth;
  if (patch.address !== undefined) values.address = patch.address;
  if (patch.company !== undefined) values.company = patch.company;
  if (patch.notes !== undefined) values.notes = patch.notes;
  return tx
    .update(guests)
    .set(values)
    .where(and(eq(guests.id, id), ACTIVE_GUEST))
    .returning(GUEST_COLUMNS)
    .then((rows) => rows[0]!);
}

export function blacklistGuestById(tx: Tx, id: string, reason: string): Promise<GuestRecord> {
  return tx
    .update(guests)
    .set({ isBlacklisted: true, blacklistReason: reason })
    .where(eq(guests.id, id))
    .returning(GUEST_COLUMNS)
    .then((rows) => rows[0]!);
}

export function unblacklistGuestById(tx: Tx, id: string): Promise<GuestRecord> {
  return tx
    .update(guests)
    .set({ isBlacklisted: false, blacklistReason: null })
    .where(eq(guests.id, id))
    .returning(GUEST_COLUMNS)
    .then((rows) => rows[0]!);
}

/** Soft-delete; the row is hidden from every query but stays for audit/FKs. */
export function softDeleteGuest(tx: Tx, id: string): Promise<void> {
  return tx
    .update(guests)
    .set({ deletedAt: new Date() })
    .where(eq(guests.id, id))
    .then(() => undefined);
}

/** Any booking row referencing the guest blocks deletion (blueprint §9.4). */
export async function countGuestBookings(db: Db, guestId: string): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.bookings).where(eq(schema.bookings.guestId, guestId));
  return rows[0]?.n ?? 0;
}

/**
 * Re-point every reference to the merged guest at the keeper and fold the
 * merged guest's lifetime stats in. booking_guests is a composite-PK table, so
 * an append-then-delete keeps conflicts idempotent.
 */
export async function mergeGuestReferences(tx: Tx, keepId: string, mergeId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO booking_guests (booking_id, guest_id)
    SELECT booking_id, ${keepId}::uuid
    FROM booking_guests
    WHERE guest_id = ${mergeId}::uuid
    ON CONFLICT DO NOTHING
  `);
  await tx.delete(schema.bookingGuests).where(eq(schema.bookingGuests.guestId, mergeId));
  await tx.update(schema.bookings).set({ guestId: keepId }).where(eq(schema.bookings.guestId, mergeId));
  await tx.update(schema.guestDocuments).set({ guestId: keepId }).where(eq(schema.guestDocuments.guestId, mergeId));
  await tx
    .update(guests)
    .set({
      stayCount: sql`${guests.stayCount} + (
        SELECT COALESCE(SUM(g2.stay_count), 0) FROM ${guests} g2 WHERE g2.id = ${mergeId}
      )`,
      lifetimeValue: sql`${guests.lifetimeValue} + (
        SELECT COALESCE(SUM(g2.lifetime_value), 0) FROM ${guests} g2 WHERE g2.id = ${mergeId}
      )`,
      lastStayDate: sql`(
        SELECT GREATEST(
          ${guests.lastStayDate},
          (SELECT g2.last_stay_date FROM ${guests} g2 WHERE g2.id = ${mergeId})
        )
      )`,
    })
    .where(eq(guests.id, keepId))
    .execute();
}

// ─── Documents ───────────────────────────────────────────────────────────────

export async function listGuestDocuments(db: Db, guestId: string): Promise<GuestDocumentRecord[]> {
  return db
    .select(DOCUMENT_COLUMNS)
    .from(guestDocuments)
    .where(eq(guestDocuments.guestId, guestId))
    .orderBy(asc(guestDocuments.createdAt));
}

export async function findGuestDocument(db: Db, docId: string): Promise<GuestDocumentRecord | null> {
  const rows = await db.select(DOCUMENT_COLUMNS).from(guestDocuments).where(eq(guestDocuments.id, docId)).limit(1);
  return rows[0] ?? null;
}

export function insertGuestDocument(tx: Tx, input: {
  guestId: string;
  fileId: string;
  docType: IdDocumentType;
  uploadedBy: string | null;
}): Promise<GuestDocumentRecord> {
  return tx
    .insert(guestDocuments)
    .values(input)
    .returning(DOCUMENT_COLUMNS)
    .then((rows) => rows[0]!);
}