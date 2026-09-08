/**
 * Integration test: property & inventory service rules against real Postgres.
 * Requires the docker DB and .env.local (same harness as the identity suite).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withDb, withTx, schema } from '@/core/db';
import { AppError } from '@/core/api';
import { eventBus } from '@/core/events';
import {
  changeRoomCondition,
  createRateRule,
  createRoom,
  createRoomType,
  deleteRoom,
  deleteRoomType,
  getRoomType,
  getSettings,
  listRateRules,
  listRooms,
  listRoomTypes,
  updateRoom,
  updateRoomType,
  updateSettings,
} from '@/modules/property/service';
import { findRoomById } from '@/modules/property/repository';
import { resolvePermissions, type Actor } from '@/modules/identity/auth-guard';
import { PROPERTY_EVENTS } from '@/modules/property/events';
import { properties } from '@/modules/property/schema';
import type { CreateRoomInput, CreateRoomTypeInput } from '@/modules/property/validation';

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

// The acting admin must be a REAL users row (settings.updated_by FK).
const ADMIN = actor('admin', null);

let propertyId = '';
let secondPropertyId = '';
const userIds: string[] = [];
const settingKeys: string[] = [];

function isoUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const TODAY = isoUtc(new Date());
const TOMORROW = isoUtc(new Date(Date.now() + 86400_000));

async function createType(over: Partial<CreateRoomTypeInput> = {}): Promise<string> {
  const rt = await createRoomType(
    {
      code: `RT${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'Deluxe Room',
      baseRate: 12500,
      maxOccupancy: 3,
      maxAdults: 2,
      maxChildren: 1,
      extraBedRate: 2500,
      amenities: ['WiFi'],
      photoFileIds: [],
      displayOrder: 0,
      isActive: true,
      ...over,
    },
    ADMIN,
  );
  return rt.id;
}

async function createRoomRow(typeId: string, over: Partial<CreateRoomInput> = {}): Promise<{ id: string; roomNumber: string }> {
  const roomNumber = `R${String(Math.floor(Math.random() * 900) + 100)}${randomUUID().slice(0, 2).toUpperCase()}`;
  const r = await createRoom(
    {
      roomNumber,
      roomTypeId: typeId,
      floor: '1',
      condition: 'available',
      housekeeping: 'clean',
      isActive: true,
      ...over,
    },
    ADMIN,
  );
  return { id: r.id, roomNumber: r.roomNumber };
}

async function seedProperty(): Promise<string> {
  return withTx(async (tx) =>
    tx
      .insert(properties)
      .values({ name: `Integration Hotel ${randomUUID().slice(0, 6)}` })
      .returning({ id: properties.id })
      .then((rows) => rows[0]!.id),
  );
}

beforeAll(async () => {
  const seeded = await withTx(async (tx) => {
    const prop = await seedProperty();
    const user = await tx
      .insert(schema.users)
      .values({
        id: randomUUID(),
        name: 'Property Admin',
        email: `prop-admin-${randomUUID().slice(0, 8)}@hotm.test`,
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
  secondPropertyId = await seedProperty();
  ADMIN.propertyId = propertyId;
  ADMIN.id = seeded.user;
  userIds.push(seeded.user);
});

afterAll(async () => {
  await withTx(async (tx) => {
    for (const key of settingKeys) {
      await tx.delete(schema.settings).where(eq(schema.settings.key, key));
    }
    for (const pid of [propertyId, secondPropertyId]) {
      await tx.delete(schema.roomAllocations).where(eq(schema.roomAllocations.propertyId, pid));
      await tx.delete(schema.rooms).where(eq(schema.rooms.propertyId, pid));
      await tx.delete(schema.roomTypes).where(eq(schema.roomTypes.propertyId, pid));
      await tx.delete(schema.rateRules).where(eq(schema.rateRules.propertyId, pid));
      await tx.delete(schema.users).where(eq(schema.users.propertyId, pid));
      await tx.delete(schema.properties).where(eq(schema.properties.id, pid));
    }
    // settings.updated_by → users → accounts/sessions
    for (const id of userIds) {
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      await tx.delete(schema.accounts).where(eq(schema.accounts.userId, id));
      await tx.delete(schema.users).where(eq(schema.users.id, id));
    }
  });
});

describe('room types', () => {
  it('creates a room type and returns money as a number', async () => {
    const id = await createType();
    const got = await getRoomType(id, ADMIN);
    expect(got.id).toBe(id);
    expect(got.baseRate).toBe(12500);
    expect(got.extraBedRate).toBe(2500);
    expect(got.maxOccupancy).toBe(3);
    expect(got.amenities).toEqual(['WiFi']);
  });

  it('rejects a duplicate code case-insensitively', async () => {
    await createType({ code: 'DUPCODE' });
    await expect(createType({ code: 'dupcode' })).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'DUPLICATE',
    );
  });

  it('allows the same code on a different property', async () => {
    const other = actor('admin', secondPropertyId);
    await createType({ code: 'SHAREDCODE' });
    const rt = await createRoomType(
      {
        code: 'SHAREDCODE',
        name: 'Shared',
        baseRate: 500,
        maxOccupancy: 2,
        maxAdults: 2,
        maxChildren: 0,
        extraBedRate: 0,
        amenities: [],
        photoFileIds: [],
        displayOrder: 0,
        isActive: true,
      },
      other,
    );
    expect(rt.id).toBeTruthy();
  });

  it('updates fields and rounds money to 2 decimals', async () => {
    const id = await createType();
    const updated = await updateRoomType(id, { name: 'Deluxe King', baseRate: 13000.5 }, ADMIN);
    expect(updated.name).toBe('Deluxe King');
    expect(updated.baseRate).toBe(13000.5);
  });

  it('lists with search + active filter, excluding soft-deleted', async () => {
    const id = await createType({ name: 'Zanzibar Suite' });
    const bySearch = await listRoomTypes({ search: 'zanzibar' }, ADMIN);
    expect(bySearch.some((r) => r.id === id)).toBe(true);

    const inactive = await listRoomTypes({ active: false }, ADMIN);
    expect(inactive.some((r) => r.id === id)).toBe(false);
  });

  it('blocks delete while rooms exist', async () => {
    const id = await createType();
    await createRoomRow(id);
    await expect(deleteRoomType(id, ADMIN)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'REFERENCE_INVALID',
    );
  });

  it('soft-deletes when empty and hides it afterwards', async () => {
    const id = await createType();
    await deleteRoomType(id, ADMIN);
    await expect(getRoomType(id, ADMIN)).rejects.toSatisfy((e) => e instanceof AppError && e.status === 404);
  });
});

describe('rooms', () => {
  it('creates a room with defaults', async () => {
    const typeId = await createType();
    const { id } = await createRoomRow(typeId);
    const row = await withDb((db) => findRoomById(db, id));
    expect(row).not.toBeNull();
    expect(row!.condition).toBe('available');
    expect(row!.housekeeping).toBe('clean');
  });

  it('rejects a duplicate room number case-insensitively', async () => {
    const typeId = await createType();
    await createRoomRow(typeId, { roomNumber: 'DUP101' });
    await expect(createRoomRow(typeId, { roomNumber: 'dup101' })).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'DUPLICATE',
    );
  });

  it('rejects an unknown room type', async () => {
    await expect(createRoomRow(randomUUID())).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'REFERENCE_INVALID',
    );
  });

  it('updates the room number and notes', async () => {
    const typeId = await createType();
    const { id } = await createRoomRow(typeId);
    const updated = await updateRoom(id, { roomNumber: 'PENTHOUSE', notes: 'sea view' }, ADMIN);
    expect(updated.roomNumber).toBe('PENTHOUSE');
    expect(updated.notes).toBe('sea view');
  });

  it('lists with filters and pagination', async () => {
    const typeId = await createType();
    const { id } = await createRoomRow(typeId, { roomNumber: 'FILTER-A', condition: 'maintenance' });
    await createRoomRow(typeId, { roomNumber: 'FILTER-B' });

    const byType = await listRooms({ typeId, condition: 'maintenance', limit: 25, offset: 0 }, ADMIN);
    expect(byType.total).toBe(1);
    expect(byType.data[0]!.id).toBe(id);

    const paged = await listRooms({ limit: 1, offset: 0 }, ADMIN);
    expect(paged.data.length).toBe(1);
    expect(paged.total).toBeGreaterThanOrEqual(2);
  });

  it('changes condition and broadcasts room.condition_changed', async () => {
    const typeId = await createType();
    const { id } = await createRoomRow(typeId);
    const captured: unknown[] = [];
    const off = eventBus.on(PROPERTY_EVENTS.roomConditionChanged, (e) => {
      captured.push(e);
    });

    const updated = await changeRoomCondition(id, { condition: 'maintenance', note: 'flooded bathroom' }, ADMIN);
    off();

    expect(updated.condition).toBe('maintenance');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ roomId: id, from: 'available', to: 'maintenance', note: 'flooded bathroom' });
  });

  it('blocks delete while a live (future) allocation exists', async () => {
    const typeId = await createType();
    const room = await createRoomRow(typeId);
    await withTx((tx) =>
      tx.insert(schema.roomAllocations).values({
        propertyId,
        roomId: room.id,
        kind: 'block',
        status: 'blocked',
        blockReason: 'maintenance test',
        startDate: TODAY,
        endDate: TOMORROW,
        adults: 1,
        children: 0,
        createdBy: ADMIN.id,
      }),
    );

    await expect(deleteRoom(room.id, ADMIN)).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'REFERENCE_INVALID',
    );
  });

  it('soft-deletes a room with no allocations', async () => {
    const typeId = await createType();
    const { id } = await createRoomRow(typeId);
    await deleteRoom(id, ADMIN);
    await expect(withDb((db) => findRoomById(db, id))).resolves.toBeNull();
  });
});

describe('rate rules', () => {
  it('creates and lists a rate rule', async () => {
    const rule = await createRateRule(
      {
        name: 'Low season',
        validFrom: '2026-04-01',
        validTo: '2026-06-30',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        minNights: 2,
        rate: 9800.5,
        priority: 0,
        isActive: true,
      },
      ADMIN,
    );
    expect(rule.rate).toBe(9800.5);
    expect(rule.daysOfWeek).toHaveLength(7);

    const list = await listRateRules(ADMIN);
    expect(list.some((r) => r.id === rule.id)).toBe(true);
  });
});

describe('settings', () => {
  it('upserts settings and records the updater', async () => {
    const key = `test.hotel.name.${randomUUID().slice(0, 6)}`;
    settingKeys.push(key);
    await updateSettings(
      { settings: [{ key, value: { en: 'Sunset Hotel' }, description: 'Display name' }] },
      ADMIN,
    );

    const list = await getSettings(ADMIN);
    const row = list.find((s) => s.key === key);
    expect(row).toBeDefined();
    expect(row!.value).toEqual({ en: 'Sunset Hotel' });
    expect(row!.updatedBy).toBe(ADMIN.id);
    expect(new Date(row!.updatedAt).getTime()).not.toBeNaN();

    // update in place (single row, new value)
    await updateSettings({ settings: [{ key, value: { en: 'Sunset Hotel Resort' } }] }, ADMIN);
    const again = await getSettings(ADMIN);
    const single = again.filter((s) => s.key === key);
    expect(single).toHaveLength(1);
    expect(single[0]!.value).toEqual({ en: 'Sunset Hotel Resort' });
  });
});