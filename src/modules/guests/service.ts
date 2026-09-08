/**
 * modules/guests/service.ts
 *
 * Business rules for guest profiles (blueprint §8.1 guests, §9.4 delete rule).
 * - guests are property-scoped: the actor's property_id, or the single active
 *   property for unbound actors (same convention as property/inventory)
 * - a guest identity number is unique per property (case-insensitive partial
 *   unique index); create/update dedupe against it before inserting
 * - blacklisting is its own permission (guests.blacklist) and requires a reason
 * - delete is soft and blocked while any booking references the guest
 * - merge re-points every reference (bookings, booking_guests, documents) to
 *   the keeper and folds lifetime stats before soft-deleting the merged rows
 * - documents reference file metadata in core/files; viewing goes through a
 *   short-lived presigned URL (guests.view_documents)
 */
import { withDb, withTx } from '@/core/db';
import { AppError } from '@/core/api';
import { eventBus } from '@/core/events';
import { getFileRecord, getStorage } from '@/core/files';
import { type Actor } from '@/modules/identity/auth-guard';
import {
  blacklistGuestById,
  countGuestBookings,
  countGuests,
  findGuestById,
  findGuestByIdNumber,
  findGuestByPhone,
  findGuestDocument,
  insertGuest,
  insertGuestDocument,
  listGuestDocuments,
  listGuests as listGuestRows,
  mergeGuestReferences,
  resolvePropertyId,
  softDeleteGuest,
  unblacklistGuestById,
  updateGuestById,
  type GuestRecord,
  type GuestDocumentRecord,
} from './repository';
import { GUEST_EVENTS } from './events';
import type { GuestDocumentView, GuestView } from './types';
import type {
  CreateGuestInput,
  MergeGuestsInput,
  UpdateGuestInput,
} from './validation';

function toGuestView(r: GuestRecord): GuestView {
  return {
    id: r.id,
    fullName: r.fullName,
    phone: r.phone,
    email: r.email,
    idType: r.idType,
    idNumber: r.idNumber,
    nationality: r.nationality,
    dateOfBirth: r.dateOfBirth,
    address: r.address,
    company: r.company,
    notes: r.notes,
    isBlacklisted: r.isBlacklisted,
    blacklistReason: r.blacklistReason,
    stayCount: r.stayCount,
    lifetimeValue: Number(r.lifetimeValue),
    lastStayDate: r.lastStayDate,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toDocumentView(r: GuestDocumentRecord): GuestDocumentView {
  return {
    id: r.id,
    guestId: r.guestId,
    fileId: r.fileId,
    docType: r.docType,
    uploadedBy: r.uploadedBy,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Resolve the property a guest record must belong to. */
async function scopeProperty(actor: Actor): Promise<string> {
  const propertyId = await withDb((db) => resolvePropertyId(db, actor.propertyId));
  if (!propertyId) {
    throw AppError.notFound('No active property is configured');
  }
  return propertyId;
}

/** Fetch a guest and assert it sits inside the actor's property scope. */
async function scopedGuest(id: string, actor: Actor): Promise<GuestRecord> {
  const guest = await withDb((db) => findGuestById(db, id));
  if (!guest) throw AppError.notFound('Guest not found');

  const propertyId = await scopeProperty(actor);
  if (guest.propertyId !== propertyId) throw AppError.notFound('Guest not found');
  return guest;
}

// ─── Guests ──────────────────────────────────────────────────────────────────

export async function listGuests(
  filters: { search?: string; limit: number; offset: number },
  actor: Actor,
): Promise<{ data: GuestView[]; total: number }> {
  const propertyId = await scopeProperty(actor);
  const { limit, offset, search } = filters;
  return withDb(async (db) => {
    const rows = await listGuestRows(db, { propertyId, search, limit, offset });
    const total = await countGuests(db, { propertyId, search });
    return { data: rows.map(toGuestView), total };
  });
}

/**
 * Create a guest. Dedupes on identity document (then phone) first — a
 * receptionist creating a guest who already exists should reuse, not duplicate.
 * Throws DUPLICATE when a match is found so the UI can offer merge/reuse.
 */
export async function createGuest(input: CreateGuestInput, actor: Actor): Promise<GuestView> {
  const propertyId = await scopeProperty(actor);

  if (input.idType && input.idNumber) {
    const idType = input.idType;
    const idNumber = input.idNumber;
    const sameId = await withDb((db) => findGuestByIdNumber(db, propertyId, idType, idNumber));
    if (sameId) {
      throw AppError.conflict('DUPLICATE', 'A guest with this ID document already exists');
    }
  }
  if (input.phone) {
    const phone = input.phone;
    const samePhone = await withDb((db) => findGuestByPhone(db, propertyId, phone));
    if (samePhone) {
      throw AppError.conflict('DUPLICATE', 'A guest with this phone number already exists');
    }
  }

  const created = await withTx(async (tx) => {
    const row = await insertGuest(tx, {
      propertyId,
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
      createdBy: actor.id,
    });
    await eventBus.emit(GUEST_EVENTS.guestCreated, { id: row.id, fullName: row.fullName, by: actor.email });
    return row;
  });

  return toGuestView(created);
}

export async function getGuest(id: string, actor: Actor): Promise<GuestView> {
  const guest = await scopedGuest(id, actor);
  return toGuestView(guest);
}

export async function updateGuest(id: string, input: UpdateGuestInput, actor: Actor): Promise<GuestView> {
  const target = await scopedGuest(id, actor);

  if (input.idType && input.idNumber) {
    const idType = input.idType;
    const idNumber = input.idNumber;
    const clash = await withDb((db) => findGuestByIdNumber(db, target.propertyId, idType, idNumber));
    if (clash && clash.id !== id) {
      throw AppError.conflict('DUPLICATE', 'A guest with this ID document already exists');
    }
  }
  if (input.phone && input.phone !== target.phone) {
    const phone = input.phone;
    const clash = await withDb((db) => findGuestByPhone(db, target.propertyId, phone));
    if (clash && clash.id !== id) {
      throw AppError.conflict('DUPLICATE', 'A guest with this phone number already exists');
    }
  }

  const updated = await withTx(async (tx) => {
    const row = await updateGuestById(tx, id, {
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      idType: input.idType,
      idNumber: input.idNumber,
      nationality: input.nationality,
      dateOfBirth: input.dateOfBirth,
      address: input.address,
      company: input.company,
      notes: input.notes,
    });
    await eventBus.emit(GUEST_EVENTS.guestUpdated, { id, by: actor.email });
    return row;
  });

  return toGuestView(updated);
}

/** Soft delete. Blocked while the guest is referenced by any booking. */
export async function deleteGuest(id: string, actor: Actor): Promise<void> {
  const target = await scopedGuest(id, actor);

  const bookings = await withDb((db) => countGuestBookings(db, id));
  if (bookings > 0) {
    throw AppError.conflict('REFERENCE_INVALID', 'Cannot delete a guest with booking history');
  }

  await withTx(async (tx) => {
    await softDeleteGuest(tx, id);
    await eventBus.emit(GUEST_EVENTS.guestDeleted, { id, fullName: target.fullName, by: actor.email });
  });
}

// ─── Blacklist ───────────────────────────────────────────────────────────────

export async function blacklistGuest(id: string, reason: string, actor: Actor): Promise<GuestView> {
  const target = await scopedGuest(id, actor);
  if (target.isBlacklisted) {
    throw AppError.conflict('INVALID_TRANSITION', 'Guest is already blacklisted');
  }

  const updated = await withTx(async (tx) => {
    const row = await blacklistGuestById(tx, id, reason);
    await eventBus.emit(GUEST_EVENTS.guestBlacklisted, { id, reason, by: actor.email });
    return row;
  });
  return toGuestView(updated);
}

export async function unblacklistGuest(id: string, actor: Actor): Promise<GuestView> {
  const target = await scopedGuest(id, actor);
  if (!target.isBlacklisted) {
    throw AppError.conflict('INVALID_TRANSITION', 'Guest is not blacklisted');
  }

  const updated = await withTx(async (tx) => {
    const row = await unblacklistGuestById(tx, id);
    await eventBus.emit(GUEST_EVENTS.guestUnblacklisted, { id, by: actor.email });
    return row;
  });
  return toGuestView(updated);
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/**
 * Fold mergeIds into keepId: re-point bookings/documents, aggregate lifetime
 * stats, and soft-delete the merged guests. All rows must be in the same
 * property. Blacklisted merge guests flatten into the keeper.
 */
export async function mergeGuests(input: MergeGuestsInput, actor: Actor): Promise<GuestView> {
  const propertyId = await scopeProperty(actor);
  if (input.mergeIds.includes(input.keepId)) {
    throw AppError.badRequest('REFERENCE_INVALID', 'keepId cannot appear in mergeIds');
  }

  const uniqueMerge = [...new Set(input.mergeIds)];
  const targets = await withDb(async (db) => {
    const rows: GuestRecord[] = [];
    for (const id of [input.keepId, ...uniqueMerge]) {
      const row = await findGuestById(db, id);
      if (!row || row.propertyId !== propertyId) {
        throw AppError.notFound('One or more guests were not found');
      }
      rows.push(row);
    }
    return rows;
  });

  const keep = targets[0]!;

  await withTx(async (tx) => {
    for (const mergeId of uniqueMerge) {
      await mergeGuestReferences(tx, keep.id, mergeId);
      await softDeleteGuest(tx, mergeId);
    }
    await eventBus.emit(GUEST_EVENTS.guestMerged, {
      keepId: keep.id,
      mergedIds: uniqueMerge,
      by: actor.email,
    });
  });

  return getGuest(keep.id, actor);
}

// ─── Documents ───────────────────────────────────────────────────────────────

export async function listDocuments(guestId: string, actor: Actor): Promise<GuestDocumentView[]> {
  await scopedGuest(guestId, actor);
  const rows = await withDb((db) => listGuestDocuments(db, guestId));
  return rows.map(toDocumentView);
}

export async function attachDocument(
  guestId: string,
  input: { fileId: string; docType: GuestDocumentView['docType'] },
  actor: Actor,
): Promise<GuestDocumentView> {
  const guest = await scopedGuest(guestId, actor);

  const file = await withDb((db) => getFileRecord(db, input.fileId));
  if (!file) throw AppError.badRequest('REFERENCE_INVALID', 'File does not exist');
  if (file.propertyId !== guest.propertyId) {
    throw AppError.badRequest('REFERENCE_INVALID', 'File belongs to a different property');
  }

  const created = await withTx(async (tx) => {
    const row = await insertGuestDocument(tx, {
      guestId,
      fileId: input.fileId,
      docType: input.docType,
      uploadedBy: actor.id,
    });
    await eventBus.emit(GUEST_EVENTS.guestDocumentUploaded, {
      guestId,
      documentId: row.id,
      docType: row.docType,
      by: actor.email,
    });
    return row;
  });

  return toDocumentView(created);
}

/** 5-minute presigned URL to the private object (blueprint §20.3). */
export async function documentUrl(guestId: string, docId: string, actor: Actor): Promise<{ url: string; expiresInSeconds: number }> {
  await scopedGuest(guestId, actor);
  const doc = await withDb((db) => findGuestDocument(db, docId));
  if (!doc || doc.guestId !== guestId) throw AppError.notFound('Document not found');

  const file = await withDb((db) => getFileRecord(db, doc.fileId));
  if (!file) throw AppError.notFound('File not found');

  const url = await getStorage().presignGet(file.storageKey, 300);
  return { url, expiresInSeconds: 300 };
}