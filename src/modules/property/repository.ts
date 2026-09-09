/**
 * modules/property/repository.ts
 *
 * All SQL for the property & inventory context. No business rules — queries.
 * The one cross-module read is the room-allocation ledger (owned by
 * modules/availability), reached through the core schema barrel — it is what
 * backs the "blocked if future allocations" delete guard.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db, type Tx } from '@/core/db';
import { properties, rateRules, roomTypes, rooms, settings } from './schema';
import type { HousekeepingStatus, RoomCondition } from './types';

export interface RoomTypeRecord {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string | null;
  baseRate: string;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  extraBedRate: string;
  amenities: string[];
  photoFileIds: string[];
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface RoomRecord {
  id: string;
  propertyId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  condition: RoomCondition;
  housekeeping: HousekeepingStatus;
  notes: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface RateRuleRecord {
  id: string;
  propertyId: string;
  roomTypeId: string | null;
  name: string;
  validFrom: string;
  validTo: string;
  daysOfWeek: number[];
  minNights: number;
  rate: string;
  priority: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SettingRecord {
  key: string;
  value: unknown;
  description: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

const ROOM_TYPE_COLUMNS = {
  id: roomTypes.id,
  propertyId: roomTypes.propertyId,
  code: roomTypes.code,
  name: roomTypes.name,
  description: roomTypes.description,
  baseRate: roomTypes.baseRate,
  maxOccupancy: roomTypes.maxOccupancy,
  maxAdults: roomTypes.maxAdults,
  maxChildren: roomTypes.maxChildren,
  extraBedRate: roomTypes.extraBedRate,
  amenities: roomTypes.amenities,
  photoFileIds: roomTypes.photoFileIds,
  displayOrder: roomTypes.displayOrder,
  isActive: roomTypes.isActive,
  createdAt: roomTypes.createdAt,
  updatedAt: roomTypes.updatedAt,
  deletedAt: roomTypes.deletedAt,
};

const ROOM_COLUMNS = {
  id: rooms.id,
  propertyId: rooms.propertyId,
  roomTypeId: rooms.roomTypeId,
  roomNumber: rooms.roomNumber,
  floor: rooms.floor,
  condition: rooms.condition,
  housekeeping: rooms.housekeeping,
  notes: rooms.notes,
  isActive: rooms.isActive,
  createdAt: rooms.createdAt,
  updatedAt: rooms.updatedAt,
  deletedAt: rooms.deletedAt,
};

const RATE_RULE_COLUMNS = {
  id: rateRules.id,
  propertyId: rateRules.propertyId,
  roomTypeId: rateRules.roomTypeId,
  name: rateRules.name,
  validFrom: rateRules.validFrom,
  validTo: rateRules.validTo,
  daysOfWeek: rateRules.daysOfWeek,
  minNights: rateRules.minNights,
  rate: rateRules.rate,
  priority: rateRules.priority,
  isActive: rateRules.isActive,
  createdAt: rateRules.createdAt,
  updatedAt: rateRules.updatedAt,
};

const ACTIVE_ROOM_TYPE = sql`${roomTypes.deletedAt} IS NULL`;
const ACTIVE_ROOM = sql`${rooms.deletedAt} IS NULL`;

// ─── Scope ───────────────────────────────────────────────────────────────────

/** actor.propertyId, or the single active property when the actor is unbound. */
export async function resolvePropertyId(db: Db, preferred: string | null): Promise<string | null> {
  if (preferred) return preferred;
  const rows = await db
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.isActive, true))
    .orderBy(asc(properties.name))
    .limit(1);
  return rows[0]?.id ?? null;
}

// ─── Room types ──────────────────────────────────────────────────────────────

export async function findRoomTypeById(db: Db, id: string): Promise<RoomTypeRecord | null> {
  const rows = await db.select(ROOM_TYPE_COLUMNS).from(roomTypes).where(and(eq(roomTypes.id, id), ACTIVE_ROOM_TYPE)).limit(1);
  return rows[0] ?? null;
}

export async function findRoomTypeByCode(db: Db, propertyId: string, code: string): Promise<RoomTypeRecord | null> {
  const rows = await db
    .select(ROOM_TYPE_COLUMNS)
    .from(roomTypes)
    .where(and(eq(roomTypes.propertyId, propertyId), sql`upper(${roomTypes.code}) = upper(${code})`, ACTIVE_ROOM_TYPE))
    .limit(1);
  return rows[0] ?? null;
}

export interface RoomTypeListFilters {
  propertyId: string;
  active?: boolean;
  search?: string;
}

export function roomTypeFilters(f: RoomTypeListFilters) {
  return and(
    eq(roomTypes.propertyId, f.propertyId),
    ACTIVE_ROOM_TYPE,
    f.active !== undefined ? eq(roomTypes.isActive, f.active) : undefined,
    f.search
      ? sql`(lower(${roomTypes.code}) LIKE lower(${`%${f.search}%`}) OR lower(${roomTypes.name}) LIKE lower(${`%${f.search}%`}))`
      : undefined,
  );
}

export async function listRoomTypes(db: Db, filters: RoomTypeListFilters): Promise<RoomTypeRecord[]> {
  return db
    .select(ROOM_TYPE_COLUMNS)
    .from(roomTypes)
    .where(roomTypeFilters(filters))
    .orderBy(asc(roomTypes.displayOrder), asc(roomTypes.name));
}

export function insertRoomType(tx: Tx, input: {
  propertyId: string;
  code: string;
  name: string;
  description?: string | null;
  baseRate: string;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  extraBedRate: string;
  amenities: string[];
  photoFileIds: string[];
  displayOrder: number;
  isActive: boolean;
}): Promise<RoomTypeRecord> {
  return tx
    .insert(roomTypes)
    .values({
      propertyId: input.propertyId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      baseRate: input.baseRate,
      maxOccupancy: input.maxOccupancy,
      maxAdults: input.maxAdults,
      maxChildren: input.maxChildren,
      extraBedRate: input.extraBedRate,
      amenities: input.amenities,
      photoFileIds: input.photoFileIds,
      displayOrder: input.displayOrder,
      isActive: input.isActive,
    })
    .returning(ROOM_TYPE_COLUMNS)
    .then((rows) => rows[0]!);
}

export function updateRoomTypeById(tx: Tx, id: string, patch: {
  code?: string;
  name?: string;
  description?: string | null;
  baseRate?: string;
  maxOccupancy?: number;
  maxAdults?: number;
  maxChildren?: number;
  extraBedRate?: string;
  amenities?: string[];
  photoFileIds?: string[];
  displayOrder?: number;
  isActive?: boolean;
}): Promise<RoomTypeRecord> {
  const values: Record<string, unknown> = {};
  if (patch.code !== undefined) values.code = patch.code;
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.baseRate !== undefined) values.baseRate = patch.baseRate;
  if (patch.maxOccupancy !== undefined) values.maxOccupancy = patch.maxOccupancy;
  if (patch.maxAdults !== undefined) values.maxAdults = patch.maxAdults;
  if (patch.maxChildren !== undefined) values.maxChildren = patch.maxChildren;
  if (patch.extraBedRate !== undefined) values.extraBedRate = patch.extraBedRate;
  if (patch.amenities !== undefined) values.amenities = patch.amenities;
  if (patch.photoFileIds !== undefined) values.photoFileIds = patch.photoFileIds;
  if (patch.displayOrder !== undefined) values.displayOrder = patch.displayOrder;
  if (patch.isActive !== undefined) values.isActive = patch.isActive;
  return tx.update(roomTypes).set(values).where(eq(roomTypes.id, id)).returning(ROOM_TYPE_COLUMNS).then((rows) => rows[0]!);
}

/** Soft-delete; the rows calling this must already know no rooms reference it. */
export function softDeleteRoomType(tx: Tx, id: string): Promise<void> {
  return tx
    .update(roomTypes)
    .set({ deletedAt: new Date() })
    .where(eq(roomTypes.id, id))
    .then(() => undefined);
}

export async function countRoomsByRoomType(db: Db, roomTypeId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rooms)
    .where(and(eq(rooms.roomTypeId, roomTypeId), ACTIVE_ROOM));
  return rows[0]?.n ?? 0;
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

export async function findRoomById(db: Db, id: string): Promise<RoomRecord | null> {
  const rows = await db.select(ROOM_COLUMNS).from(rooms).where(and(eq(rooms.id, id), ACTIVE_ROOM)).limit(1);
  return rows[0] ?? null;
}

export async function findRoomByNumber(db: Db, propertyId: string, roomNumber: string): Promise<RoomRecord | null> {
  const rows = await db
    .select(ROOM_COLUMNS)
    .from(rooms)
    .where(and(eq(rooms.propertyId, propertyId), sql`upper(${rooms.roomNumber}) = upper(${roomNumber})`, ACTIVE_ROOM))
    .limit(1);
  return rows[0] ?? null;
}

export interface RoomListFilters {
  propertyId: string;
  typeId?: string;
  condition?: RoomCondition;
  floor?: string;
  search?: string;
  limit: number;
  offset: number;
}

export function roomFilters(f: Omit<RoomListFilters, 'limit' | 'offset'>) {
  return and(
    eq(rooms.propertyId, f.propertyId),
    ACTIVE_ROOM,
    f.typeId ? eq(rooms.roomTypeId, f.typeId) : undefined,
    f.condition ? eq(rooms.condition, f.condition as never) : undefined,
    f.floor ? eq(rooms.floor, f.floor) : undefined,
    f.search
      ? sql`(lower(${rooms.roomNumber}) LIKE lower(${`%${f.search}%`}) OR lower(${rooms.floor}) LIKE lower(${`%${f.search}%`}) OR lower(${rooms.notes}) LIKE lower(${`%${f.search}%`}))`
      : undefined,
  );
}

export async function listRooms(db: Db, filters: RoomListFilters): Promise<RoomRecord[]> {
  return db.select(ROOM_COLUMNS).from(rooms).where(roomFilters(filters)).orderBy(asc(rooms.roomNumber)).limit(filters.limit).offset(filters.offset);
}

/** Every active room for a property — the housekeeping board source (§13.4). */
export async function listActiveRooms(db: Db, propertyId: string): Promise<RoomRecord[]> {
  return db
    .select(ROOM_COLUMNS)
    .from(rooms)
    .where(and(eq(rooms.propertyId, propertyId), ACTIVE_ROOM))
    .orderBy(asc(rooms.roomNumber));
}

/** Board tile flip (housekeeping + optional condition) for housekeeping.update. */
export function updateRoomBoardState(
  tx: Tx,
  id: string,
  patch: { housekeeping?: HousekeepingStatus; condition?: RoomCondition },
): Promise<RoomRecord> {
  const values: Record<string, unknown> = {};
  if (patch.housekeeping !== undefined) values.housekeeping = patch.housekeeping;
  if (patch.condition !== undefined) values.condition = patch.condition;
  return tx.update(rooms).set(values).where(eq(rooms.id, id)).returning(ROOM_COLUMNS).then((rows) => rows[0]!);
}

export async function countRooms(db: Db, filters: Omit<RoomListFilters, 'limit' | 'offset'>): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(rooms).where(roomFilters(filters));
  return rows[0]?.n ?? 0;
}

export function insertRoom(tx: Tx, input: {
  propertyId: string;
  roomTypeId: string;
  roomNumber: string;
  floor?: string | null;
  condition: RoomCondition;
  housekeeping: HousekeepingStatus;
  notes?: string | null;
  isActive: boolean;
}): Promise<RoomRecord> {
  return tx
    .insert(rooms)
    .values({
      propertyId: input.propertyId,
      roomTypeId: input.roomTypeId,
      roomNumber: input.roomNumber,
      floor: input.floor ?? null,
      condition: input.condition,
      housekeeping: input.housekeeping,
      notes: input.notes ?? null,
      isActive: input.isActive,
    })
    .returning(ROOM_COLUMNS)
    .then((rows) => rows[0]!);
}

export function updateRoomById(tx: Tx, id: string, patch: {
  roomNumber?: string;
  roomTypeId?: string;
  floor?: string | null;
  notes?: string | null;
  isActive?: boolean;
}): Promise<RoomRecord> {
  const values: Record<string, unknown> = {};
  if (patch.roomNumber !== undefined) values.roomNumber = patch.roomNumber;
  if (patch.roomTypeId !== undefined) values.roomTypeId = patch.roomTypeId;
  if (patch.floor !== undefined) values.floor = patch.floor;
  if (patch.notes !== undefined) values.notes = patch.notes;
  if (patch.isActive !== undefined) values.isActive = patch.isActive;
  return tx.update(rooms).set(values).where(eq(rooms.id, id)).returning(ROOM_COLUMNS).then((rows) => rows[0]!);
}

export function setRoomCondition(tx: Tx, id: string, condition: RoomCondition): Promise<RoomRecord> {
  return tx.update(rooms).set({ condition }).where(eq(rooms.id, id)).returning(ROOM_COLUMNS).then((rows) => rows[0]!);
}

export function softDeleteRoom(tx: Tx, id: string): Promise<void> {
  return tx
    .update(rooms)
    .set({ deletedAt: new Date() })
    .where(eq(rooms.id, id))
    .then(() => undefined);
}

const ACTIVE_ALLOCATION_STATUSES = ['held', 'confirmed', 'checked_in', 'blocked'] as never[];

/** Active allocations (current or future) still attached to the room. */
export async function countLiveAllocations(db: Db, roomId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.roomAllocations)
    .where(
      and(
        eq(schema.roomAllocations.roomId, roomId),
        inArray(schema.roomAllocations.status, ACTIVE_ALLOCATION_STATUSES),
        sql`${schema.roomAllocations.endDate} >= current_date`,
      ),
    );
  return rows[0]?.n ?? 0;
}

// ─── Rate rules ──────────────────────────────────────────────────────────────

export function insertRateRule(tx: Tx, input: {
  propertyId: string;
  roomTypeId?: string | null;
  name: string;
  validFrom: string;
  validTo: string;
  daysOfWeek: number[];
  minNights: number;
  rate: string;
  priority: number;
  isActive: boolean;
}): Promise<RateRuleRecord> {
  return tx
    .insert(rateRules)
    .values({
      propertyId: input.propertyId,
      roomTypeId: input.roomTypeId ?? null,
      name: input.name,
      validFrom: input.validFrom,
      validTo: input.validTo,
      daysOfWeek: input.daysOfWeek,
      minNights: input.minNights,
      rate: input.rate,
      priority: input.priority,
      isActive: input.isActive,
    })
    .returning(RATE_RULE_COLUMNS)
    .then((rows) => rows[0]!);
}

export async function listRateRules(db: Db, propertyId: string): Promise<RateRuleRecord[]> {
  return db
    .select(RATE_RULE_COLUMNS)
    .from(rateRules)
    .where(eq(rateRules.propertyId, propertyId))
    .orderBy(desc(rateRules.priority), asc(rateRules.name));
}

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTING_COLUMNS = {
  key: settings.key,
  value: settings.value,
  description: settings.description,
  updatedBy: settings.updatedBy,
  updatedAt: settings.updatedAt,
};

export async function listSettings(db: Db): Promise<SettingRecord[]> {
  return db.select(SETTING_COLUMNS).from(settings).orderBy(asc(settings.key));
}

export async function upsertSettings(tx: Tx, entries: {
  key: string;
  value: unknown;
  description?: string | null;
  updatedBy: string;
}[]): Promise<void> {
  await tx
    .insert(settings)
    .values(
      entries.map((e) => ({
        key: e.key,
        value: e.value,
        description: e.description ?? null,
        updatedBy: e.updatedBy,
      })),
    )
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`excluded.value`,
        description: sql`excluded.description`,
        updatedBy: sql`excluded.updated_by`,
        updatedAt: sql`now()`,
      },
    })
    .then(() => undefined);
}