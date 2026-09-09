/**
 * Integration test: guests service rules against a real Postgres.
 * Requires the docker DB and .env.local (same harness as property/identity).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { AppError } from '@/core/api';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import {
  attachDocument,
  blacklistGuest,
  createGuest,
  deleteGuest,
  documentUrl,
  getGuest,
  listDocuments,
  listGuests,
  mergeGuests,
  unblacklistGuest,
  updateGuest,
} from '@/modules/guests/service';
import type { CreateGuestInput } from '@/modules/guests/validation';

vi.setConfig({ testTimeout: 30_000 });

function actor(role: Actor['role'], propertyId: string | null, id?: string): Actor {
  return {
    id: id ?? randomUUID(),
    name: role,
    email: `${role}@actor.test`,
    role,
    propertyId,
    permissions: resolvePermissions(role, []),
  };
}

const ADMIN = actor('admin', null);

let propertyId = '';
const userIds: string[] = [];
const extraGuests: { guestId: string; propertyId: string }[] = [];
const extraFiles: { fileId: string; propertyId: string }[] = [];

async function createGuestRow(over: Partial<CreateGuestInput> = {}): Promise<{ id: string; fullName: string; phone: string }> {
  const input: CreateGuestInput = {
    fullName: 'Kenya Walker',
    phone: `+2547${Math.floor(10000000 + Math.random() * 89999999)}`,
    email: `guest-${randomUUID().slice(0, 8)}@hotm.test`,
    idType: 'passport',
    idNumber: `K${Math.floor(1000000 + Math.random() * 8999999)}`,
    nationality: 'KE',
    ...over,
  };
  const guest = await createGuest(input, ADMIN);
  return { id: guest.id, fullName: guest.fullName, phone: guest.phone ?? input.phone! };
}

async function insertBooking(guestId: string, reference: string): Promise<string> {
  return withTx(async (tx) => {
    const row = await tx
      .insert(schema.bookings)
      .values({
        propertyId,
        reference,
        guestId,
        arrivalDate: '2026-10-01',
        departureDate: '2026-10-03',
        guestNameSnapshot: 'Kenya Walker',
        createdBy: ADMIN.id,
      })
      .returning({ id: schema.bookings.id })
      .then((rows) => rows[0]!);
    return row.id;
  });
}

async function seedFile(guestId: string): Promise<string> {
  return withTx(async (tx) => {
    const row = await tx
      .insert(schema.files)
      .values({
        propertyId,
        storageKey: `private/guests/${randomUUID()}.jpg`,
        visibility: 'private',
        originalName: 'identity-scan.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        entityType: 'guest',
        entityId: guestId,
        uploadedBy: ADMIN.id,
      })
      .returning({ id: schema.files.id })
      .then((rows) => rows[0]!.id);
    return row;
  });
}

beforeAll(async () => {
  const seeded = await withTx(async (tx) => {
    const prop = await tx
      .insert(schema.properties)
      .values({ name: `Guests Hotel ${randomUUID().slice(0, 6)}` })
      .returning({ id: schema.properties.id })
      .then((rows) => rows[0]!.id);
    const user = await tx
      .insert(schema.users)
      .values({
        id: randomUUID(),
        name: 'Guests Admin',
        email: `guests-admin-${randomUUID().slice(0, 8)}@hotm.test`,
        role: 'admin',
        status: 'active',
        mustChangePassword: true,
        createdBy: null,
      })
      .returning({ id: schema.users.id })
      .then((rows) => rows[0]!.id);
    await tx.insert(schema.accounts).values({
      id: randomUUID(),
      userId: user,
      providerId: 'credential',
      accountId: user,
      password: 'not-used-in-tests',
    });
    return { prop, user };
  });
  propertyId = seeded.prop;
  ADMIN.propertyId = propertyId;
  ADMIN.id = seeded.user;
  userIds.push(seeded.user);
});

afterAll(async () => {
  await withTx(async (tx) => {
    // properties + users now carry append-only activity_logs references
    // (actor_id / property_id FKs) and can never be removed — unique UUIDs
    // keep each run isolated, so they stay as residue.
    // far-property guests created by the merge-scope test
    for (const far of extraGuests) {
      await tx.delete(schema.guestDocuments).where(eq(schema.guestDocuments.guestId, far.guestId));
      await tx.delete(schema.guests).where(eq(schema.guests.id, far.guestId));
      await tx.delete(schema.files).where(eq(schema.files.propertyId, far.propertyId));
    }
    for (const far of extraFiles) {
      await tx.delete(schema.files).where(eq(schema.files.id, far.fileId));
    }

    const guestIds = await tx.select({ id: schema.guests.id }).from(schema.guests).where(eq(schema.guests.propertyId, propertyId));
    const ids = guestIds.map((g) => g.id);
    if (ids.length > 0) {
      await tx.delete(schema.guestDocuments).where(inArray(schema.guestDocuments.guestId, ids));
      await tx.delete(schema.bookingGuests).where(inArray(schema.bookingGuests.guestId, ids));
      await tx.delete(schema.bookings).where(inArray(schema.bookings.guestId, ids));
    }
    await tx.delete(schema.files).where(eq(schema.files.propertyId, propertyId));
    await tx.delete(schema.guests).where(eq(schema.guests.propertyId, propertyId));
    for (const id of userIds) {
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      await tx.delete(schema.accounts).where(eq(schema.accounts.userId, id));
    }
  });
});

describe('createGuest', () => {
  it('creates a guest with the actor recorded as created_by', async () => {
    const { id } = await createGuestRow();
    const row = await withDb((db) =>
      db
        .select({ fullName: schema.guests.fullName, createdBy: schema.guests.createdBy })
        .from(schema.guests)
        .where(eq(schema.guests.id, id)),
    );
    expect(row[0]).toMatchObject({ createdBy: ADMIN.id });
    expect(row[0]!.fullName).toBe('Kenya Walker');
  });

  it('rejects an ID document already on file, case-insensitively', async () => {
    const idNumber = `dup-${Math.floor(100000 + Math.random() * 899999)}`;
    await createGuestRow({ idType: 'national_id', idNumber });
    await expect(createGuestRow({ idType: 'national_id', idNumber: idNumber.toUpperCase() })).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'DUPLICATE',
    );
  });

  it('rejects a phone already on file', async () => {
    const phone = `+2547${Math.floor(10000000 + Math.random() * 89999999)}`;
    await createGuestRow({ phone });
    await expect(createGuestRow({ phone })).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'DUPLICATE',
    );
  });
});

describe('listGuests', () => {
  it('searches by name and by phone', async () => {
    const named = await createGuestRow({ fullName: 'Zebedee Njeru' });
    const byName = await listGuests({ search: 'zebedee', limit: 25, offset: 0 }, ADMIN);
    expect(byName.data.some((g) => g.id === named.id)).toBe(true);

    const phoned = await createGuestRow();
    const byPhone = await listGuests({ search: phoned.phone.slice(-6), limit: 25, offset: 0 }, ADMIN);
    expect(byPhone.data.some((g) => g.id === phoned.id)).toBe(true);
  });

  it('paginates and reports the full count', async () => {
    const { total } = await listGuests({ search: undefined, limit: 100, offset: 0 }, ADMIN);
    const page = await listGuests({ search: undefined, limit: 2, offset: 0 }, ADMIN);
    expect(page.total).toBe(total);
    expect(page.data.length).toBeLessThanOrEqual(2);
  });
});

describe('updateGuest', () => {
  it('updates profile fields', async () => {
    const { id } = await createGuestRow();
    const updated = await updateGuest(id, { fullName: 'Aziza Wharton', company: 'Safari Ltd', notes: 'prefers 4th floor' }, ADMIN);
    expect(updated.fullName).toBe('Aziza Wharton');
    expect(updated.company).toBe('Safari Ltd');
    expect(updated.notes).toBe('prefers 4th floor');
  });

  it('rejects moving onto another guest ID document', async () => {
    const a = await createGuestRow();
    const b = await createGuestRow();
    const clash = await withDb((db) =>
      db
        .select({ idType: schema.guests.idType, idNumber: schema.guests.idNumber })
        .from(schema.guests)
        .where(eq(schema.guests.id, a.id)),
    );
    await expect(
      updateGuest(b.id, { idType: clash[0]!.idType, idNumber: clash[0]!.idNumber }, ADMIN),
    ).rejects.toSatisfy((e) => e instanceof AppError && e.code === 'DUPLICATE');
  });
});

describe('blacklist / unblacklist', () => {
  it('blacklists with a reason and lifts it', async () => {
    const { id } = await createGuestRow();
    const blacked = await blacklistGuest(id, 'destructive behaviour', ADMIN);
    expect(blacked.isBlacklisted).toBe(true);
    expect(blacked.blacklistReason).toBe('destructive behaviour');

    await expect(blacklistGuest(id, 'again', ADMIN)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'INVALID_TRANSITION',
    );

    const lifted = await unblacklistGuest(id, ADMIN);
    expect(lifted.isBlacklisted).toBe(false);
    expect(lifted.blacklistReason).toBeNull();
  });
});

describe('deleteGuest', () => {
  it('blocks deleting a guest with booking history', async () => {
    const guest = await createGuestRow();
    await insertBooking(guest.id, `BK-TEST-${randomUUID().slice(0, 6)}`);
    await expect(deleteGuest(guest.id, ADMIN)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'REFERENCE_INVALID',
    );
  });

  it('soft-deletes a guest with no bookings', async () => {
    const { id } = await createGuestRow();
    await deleteGuest(id, ADMIN);
    await expect(getGuest(id, ADMIN)).rejects.toSatisfy((e) => e instanceof AppError && e.status === 404);
  });
});

describe('mergeGuests', () => {
  it('re-points references, aggregates stats, and soft-deletes the merged guests', async () => {
    const keep = await createGuestRow();
    const m1 = await createGuestRow();
    const m2 = await createGuestRow();

    const bookingId = await insertBooking(m1.id, `BK-MERGE-${randomUUID().slice(0, 6)}`);

    await withTx(async (tx) => {
      await tx.update(schema.guests).set({ stayCount: 2, lifetimeValue: '15000.00' }).where(eq(schema.guests.id, m1.id));
      await tx.update(schema.guests).set({ stayCount: 1, lifetimeValue: '25000.00' }).where(eq(schema.guests.id, m2.id));
    });

    const merged = await mergeGuests({ keepId: keep.id, mergeIds: [m1.id, m2.id] }, ADMIN);

    expect(merged.stayCount).toBe(3);
    expect(merged.lifetimeValue).toBe(40000);

    const booking = await withDb((db) =>
      db.select({ guestId: schema.bookings.guestId }).from(schema.bookings).where(eq(schema.bookings.id, bookingId)),
    );
    expect(booking[0]!.guestId).toBe(keep.id);

    await expect(getGuest(m1.id, ADMIN)).rejects.toSatisfy((e) => e instanceof AppError && e.status === 404);
    await expect(getGuest(m2.id, ADMIN)).rejects.toSatisfy((e) => e instanceof AppError && e.status === 404);
  });

  it('refuses to merge a guest from another property', async () => {
    const keep = await createGuestRow();
    const far = await withTx(async (tx) => {
      const prop = await tx
        .insert(schema.properties)
        .values({ name: `Far Hotel ${randomUUID().slice(0, 6)}`, isActive: false })
        .returning({ id: schema.properties.id })
        .then((rows) => rows[0]!.id);
      const g = await tx
        .insert(schema.guests)
        .values({ propertyId: prop, fullName: 'Far Guest', createdBy: ADMIN.id })
        .returning({ id: schema.guests.id })
        .then((rows) => rows[0]!.id);
      return { prop, g };
    });
    extraGuests.push({ guestId: far.g, propertyId: far.prop });

    await expect(mergeGuests({ keepId: keep.id, mergeIds: [far.g] }, ADMIN)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.status === 404,
    );
  });

  it('rejects keepId inside mergeIds', async () => {
    const keep = await createGuestRow();
    const m = await createGuestRow();
    await expect(mergeGuests({ keepId: keep.id, mergeIds: [m.id, keep.id] }, ADMIN)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.status === 400,
    );
  });
});

describe('documents', () => {
  it('attaches a document, lists it, and issues a signed URL', async () => {
    const { id } = await createGuestRow();
    const fileId = await seedFile(id);

    const doc = await attachDocument(id, { fileId, docType: 'passport' }, ADMIN);
    expect(doc.guestId).toBe(id);
    expect(doc.docType).toBe('passport');

    const list = await listDocuments(id, ADMIN);
    expect(list.some((d) => d.id === doc.id)).toBe(true);

    const { url, expiresInSeconds } = await documentUrl(id, doc.id, ADMIN);
    expect(url.length).toBeGreaterThan(0);
    expect(expiresInSeconds).toBe(300);
  });

  it('rejects a URL for another guest document', async () => {
    const a = await createGuestRow();
    const b = await createGuestRow();
    const fileId = await seedFile(a.id);
    const doc = await attachDocument(a.id, { fileId, docType: 'passport' }, ADMIN);
    await expect(documentUrl(b.id, doc.id, ADMIN)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.status === 404,
    );
  });

  it('rejects attaching a file from another property', async () => {
    const { id } = await createGuestRow();
    const far = await withTx(async (tx) => {
      const prop = await tx
        .insert(schema.properties)
        .values({ name: `Files Hotel ${randomUUID().slice(0, 6)}`, isActive: false })
        .returning({ id: schema.properties.id })
        .then((rows) => rows[0]!.id);
      const f = await tx
        .insert(schema.files)
        .values({
          propertyId: prop,
          storageKey: `private/guests/${randomUUID()}.jpg`,
          visibility: 'private',
          originalName: 'other.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 100,
          uploadedBy: ADMIN.id,
        })
        .returning({ id: schema.files.id })
        .then((rows) => rows[0]!.id);
      return { f, prop };
    });
    extraFiles.push({ fileId: far.f, propertyId: far.prop });

    await expect(attachDocument(id, { fileId: far.f, docType: 'passport' }, ADMIN)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'REFERENCE_INVALID',
    );
  });
});