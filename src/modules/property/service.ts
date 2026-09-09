/**
 * modules/property/service.ts
 *
 * Business rules for property & inventory (blueprint §16.3 Rooms & inventory,
 * §6 property module). Enforcement here, DDL in the schema:
 * - every record is scoped to a property: the actor's property_id, or the
 *   single active property when the actor is unbound (single-hotel deployment)
 * - room type code and room number are unique per property, case-insensitively
 *   (partial unique indexes in DDL back the duplicate checks)
 * - room type delete is soft and blocked while it still has rooms
 * - room delete is soft and blocked while live allocations exist (current or
 *   future — read from the allocation ledger, not from booking status)
 * - condition changes are their own operation (rooms.change_condition) and are
 *   broadcast; housekeeping state is owned by the housekeeping module
 */
import { withDb, withTx } from '@/core/db';
import { eventBus } from '@/core/events';
import { AppError } from '@/core/api';
import { type Actor } from '@/modules/identity/auth-guard';
import { auditActor, recordAudit } from '@/modules/audit/service';
import {
  countLiveAllocations,
  countRooms,
  countRoomsByRoomType,
  findRoomByNumber,
  findRoomById,
  findRoomTypeByCode,
  findRoomTypeById,
  insertRateRule,
  insertRoom,
  insertRoomType,
  listRateRules as listRateRuleRows,
  listRooms as listRoomRows,
  listRoomTypes as listRoomTypeRows,
  listSettings as listSettingRows,
  resolvePropertyId,
  setRoomCondition,
  softDeleteRoom,
  softDeleteRoomType,
  updateRoomById,
  updateRoomTypeById,
  upsertSettings,
  type RateRuleRecord,
  type RoomListFilters,
  type RoomRecord,
  type RoomTypeRecord,
  type SettingRecord,
} from './repository';
import { PROPERTY_EVENTS } from './events';
import type { RateRuleView, RoomTypeView, RoomView, SettingView } from './types';
import type {
  ChangeConditionInput,
  CreateRateRuleInput,
  CreateRoomInput,
  CreateRoomTypeInput,
  UpdateRoomInput,
  UpdateRoomTypeInput,
  UpdateSettingsInput,
} from './validation';

function moneyString(n: number): string {
  return n.toFixed(2);
}

function toRoomTypeView(r: RoomTypeRecord): RoomTypeView {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    baseRate: Number(r.baseRate),
    maxOccupancy: r.maxOccupancy,
    maxAdults: r.maxAdults,
    maxChildren: r.maxChildren,
    extraBedRate: Number(r.extraBedRate),
    amenities: r.amenities,
    photoFileIds: r.photoFileIds,
    displayOrder: r.displayOrder,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toRoomView(r: RoomRecord): RoomView {
  return {
    id: r.id,
    roomNumber: r.roomNumber,
    roomTypeId: r.roomTypeId,
    floor: r.floor,
    condition: r.condition,
    housekeeping: r.housekeeping,
    notes: r.notes,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toRateRuleView(r: RateRuleRecord): RateRuleView {
  return {
    id: r.id,
    roomTypeId: r.roomTypeId,
    name: r.name,
    validFrom: r.validFrom,
    validTo: r.validTo,
    daysOfWeek: r.daysOfWeek,
    minNights: r.minNights,
    rate: Number(r.rate),
    priority: r.priority,
    isActive: r.isActive,
  };
}

function toSettingView(r: SettingRecord): SettingView {
  return {
    key: r.key,
    value: r.value,
    description: r.description,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Resolve the property every inventory record is scoped to. */
async function scopeProperty(actor: Actor): Promise<string> {
  const propertyId = await withDb((db) => resolvePropertyId(db, actor.propertyId));
  if (!propertyId) {
    throw AppError.notFound('No active property is configured');
  }
  return propertyId;
}

// ─── Room types ──────────────────────────────────────────────────────────────

export async function listRoomTypes(
  filters: { active?: boolean; search?: string },
  actor: Actor,
): Promise<RoomTypeView[]> {
  const propertyId = await scopeProperty(actor);
  const rows = await withDb((db) => listRoomTypeRows(db, { propertyId, ...filters }));
  return rows.map(toRoomTypeView);
}

export async function createRoomType(input: CreateRoomTypeInput, actor: Actor): Promise<RoomTypeView> {
  const propertyId = await scopeProperty(actor);

  const existing = await withDb((db) => findRoomTypeByCode(db, propertyId, input.code));
  if (existing) {
    throw AppError.conflict('DUPLICATE', `A room type with code ${input.code} already exists`);
  }

  const created = await withTx(async (tx) => {
    const row = await insertRoomType(tx, {
      propertyId,
      code: input.code,
      name: input.name,
      description: input.description,
      baseRate: moneyString(input.baseRate),
      maxOccupancy: input.maxOccupancy,
      maxAdults: input.maxAdults,
      maxChildren: input.maxChildren,
      extraBedRate: moneyString(input.extraBedRate),
      amenities: input.amenities,
      photoFileIds: input.photoFileIds,
      displayOrder: input.displayOrder,
      isActive: input.isActive,
    });
    await eventBus.emit(PROPERTY_EVENTS.roomTypeCreated, {
      id: row.id,
      code: row.code,
      name: row.name,
      by: actor.email,
    });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'roomtypes.create',
      entityType: 'room_type',
      entityId: row.id,
      summary: `Room type ${row.code} ${row.name} created`,
    });
    return row;
  });

  return toRoomTypeView(created);
}

export async function getRoomType(id: string, _actor: Actor): Promise<RoomTypeView> {
  const row = await withDb((db) => findRoomTypeById(db, id));
  if (!row) throw AppError.notFound('Room type not found');
  return toRoomTypeView(row);
}

export async function updateRoomType(id: string, input: UpdateRoomTypeInput, actor: Actor): Promise<RoomTypeView> {
  const target = await withDb((db) => findRoomTypeById(db, id));
  if (!target) throw AppError.notFound('Room type not found');

  if (input.code !== undefined && input.code !== target.code) {
    const code = input.code;
    const clash = await withDb((db) => findRoomTypeByCode(db, target.propertyId, code));
    if (clash && clash.id !== id) {
      throw AppError.conflict('DUPLICATE', `A room type with code ${code} already exists`);
    }
  }

  const updated = await withTx(async (tx) => {
    const row = await updateRoomTypeById(tx, id, {
      code: input.code,
      name: input.name,
      description: input.description,
      baseRate: input.baseRate === undefined ? undefined : moneyString(input.baseRate),
      maxOccupancy: input.maxOccupancy,
      maxAdults: input.maxAdults,
      maxChildren: input.maxChildren,
      extraBedRate: input.extraBedRate === undefined ? undefined : moneyString(input.extraBedRate),
      amenities: input.amenities,
      photoFileIds: input.photoFileIds,
      displayOrder: input.displayOrder,
      isActive: input.isActive,
    });
    await eventBus.emit(PROPERTY_EVENTS.roomTypeUpdated, { id, by: actor.email });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId: target.propertyId,
      action: 'roomtypes.update',
      entityType: 'room_type',
      entityId: id,
      summary: `Room type ${target.code} ${target.name} updated`,
    });
    return row;
  });

  return toRoomTypeView(updated);
}

/** Soft delete. Blocked while the type still has rooms. */
export async function deleteRoomType(id: string, actor: Actor): Promise<void> {
  const target = await withDb((db) => findRoomTypeById(db, id));
  if (!target) throw AppError.notFound('Room type not found');

  const roomCount = await withDb((db) => countRoomsByRoomType(db, id));
  if (roomCount > 0) {
    throw AppError.conflict('REFERENCE_INVALID', 'Cannot delete a room type that still has rooms');
  }

  await withTx(async (tx) => {
    await softDeleteRoomType(tx, id);
    await eventBus.emit(PROPERTY_EVENTS.roomTypeDeleted, { id, by: actor.email });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId: target.propertyId,
      action: 'roomtypes.delete',
      entityType: 'room_type',
      entityId: id,
      summary: `Room type ${target.code} ${target.name} deleted`,
    });
  });
}

// ─── Rooms ───────────────────────────────────────────────────────────────────

export async function listRooms(
  filters: Omit<RoomListFilters, 'propertyId'>,
  actor: Actor,
): Promise<{ data: RoomView[]; total: number }> {
  const propertyId = await scopeProperty(actor);
  const { limit, offset, ...rest } = filters;
  return withDb(async (db) => {
    const rows = await listRoomRows(db, { propertyId, ...rest, limit, offset });
    const total = await countRooms(db, { propertyId, ...rest });
    return { data: rows.map(toRoomView), total };
  });
}

export async function createRoom(input: CreateRoomInput, actor: Actor): Promise<RoomView> {
  const propertyId = await scopeProperty(actor);

  const clash = await withDb((db) => findRoomByNumber(db, propertyId, input.roomNumber));
  if (clash) {
    throw AppError.conflict('DUPLICATE', `Room ${input.roomNumber} already exists`);
  }
  const type = await withDb((db) => findRoomTypeById(db, input.roomTypeId));
  if (!type) {
    throw AppError.badRequest('REFERENCE_INVALID', 'Room type does not exist');
  }

  const created = await withTx(async (tx) => {
    const row = await insertRoom(tx, {
      propertyId,
      roomTypeId: input.roomTypeId,
      roomNumber: input.roomNumber,
      floor: input.floor,
      condition: input.condition,
      housekeeping: input.housekeeping,
      notes: input.notes,
      isActive: input.isActive,
    });
    await eventBus.emit(PROPERTY_EVENTS.roomCreated, {
      id: row.id,
      roomNumber: row.roomNumber,
      by: actor.email,
    });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'rooms.create',
      entityType: 'room',
      entityId: row.id,
      summary: `Room ${row.roomNumber} created`,
    });
    return row;
  });

  return toRoomView(created);
}

export async function updateRoom(id: string, input: UpdateRoomInput, actor: Actor): Promise<RoomView> {
  const target = await withDb((db) => findRoomById(db, id));
  if (!target) throw AppError.notFound('Room not found');

  if (input.roomNumber !== undefined && input.roomNumber !== target.roomNumber) {
    const roomNumber = input.roomNumber;
    const clash = await withDb((db) => findRoomByNumber(db, target.propertyId, roomNumber));
    if (clash && clash.id !== id) {
      throw AppError.conflict('DUPLICATE', `Room ${roomNumber} already exists`);
    }
  }
  if (input.roomTypeId !== undefined && input.roomTypeId !== target.roomTypeId) {
    const roomTypeId = input.roomTypeId;
    const type = await withDb((db) => findRoomTypeById(db, roomTypeId));
    if (!type) {
      throw AppError.badRequest('REFERENCE_INVALID', 'Room type does not exist');
    }
  }

  const updated = await withTx(async (tx) => {
    const row = await updateRoomById(tx, id, {
      roomNumber: input.roomNumber,
      roomTypeId: input.roomTypeId,
      floor: input.floor,
      notes: input.notes,
      isActive: input.isActive,
    });
    await eventBus.emit(PROPERTY_EVENTS.roomUpdated, { id, by: actor.email });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId: target.propertyId,
      action: 'rooms.update',
      entityType: 'room',
      entityId: id,
      summary: `Room ${target.roomNumber} updated`,
    });
    return row;
  });

  return toRoomView(updated);
}

/** Condition change is its own permission and its own broadcast. */
export async function changeRoomCondition(
  id: string,
  input: ChangeConditionInput,
  actor: Actor,
): Promise<RoomView> {
  const target = await withDb((db) => findRoomById(db, id));
  if (!target) throw AppError.notFound('Room not found');
  if (input.condition === target.condition) {
    return toRoomView(target);
  }

  const updated = await withTx(async (tx) => {
    const row = await setRoomCondition(tx, id, input.condition);
    await eventBus.emit(PROPERTY_EVENTS.roomConditionChanged, {
      roomId: row.id,
      roomNumber: row.roomNumber,
      from: target.condition,
      to: row.condition,
      note: input.note ?? null,
      by: actor.email,
    });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId: target.propertyId,
      action: 'rooms.change_condition',
      entityType: 'room',
      entityId: row.id,
      summary: `Room ${row.roomNumber} condition ${target.condition} → ${row.condition}`,
    });
    return row;
  });

  return toRoomView(updated);
}

/** Soft delete. Blocked while the room has current or future allocations. */
export async function deleteRoom(id: string, actor: Actor): Promise<void> {
  const target = await withDb((db) => findRoomById(db, id));
  if (!target) throw AppError.notFound('Room not found');

  const live = await withDb((db) => countLiveAllocations(db, id));
  if (live > 0) {
    throw AppError.conflict('REFERENCE_INVALID', 'Cannot delete a room with current or future allocations');
  }

  await withTx(async (tx) => {
    await softDeleteRoom(tx, id);
    await eventBus.emit(PROPERTY_EVENTS.roomDeleted, { id, roomNumber: target.roomNumber, by: actor.email });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId: target.propertyId,
      action: 'rooms.delete',
      entityType: 'room',
      entityId: id,
      summary: `Room ${target.roomNumber} deleted`,
    });
  });
}

// ─── Rate rules [P2] ─────────────────────────────────────────────────────────

export async function listRateRules(actor: Actor): Promise<RateRuleView[]> {
  const propertyId = await scopeProperty(actor);
  const rows = await withDb((db) => listRateRuleRows(db, propertyId));
  return rows.map(toRateRuleView);
}

export async function createRateRule(input: CreateRateRuleInput, actor: Actor): Promise<RateRuleView> {
  const propertyId = await scopeProperty(actor);

  if (input.roomTypeId) {
    const roomTypeId = input.roomTypeId;
    const type = await withDb((db) => findRoomTypeById(db, roomTypeId));
    if (!type) {
      throw AppError.badRequest('REFERENCE_INVALID', 'Room type does not exist');
    }
  }

  const created = await withTx(async (tx) => {
    const row = await insertRateRule(tx, {
      propertyId,
      roomTypeId: input.roomTypeId,
      name: input.name,
      validFrom: input.validFrom,
      validTo: input.validTo,
      daysOfWeek: input.daysOfWeek,
      minNights: input.minNights,
      rate: moneyString(input.rate),
      priority: input.priority,
      isActive: input.isActive,
    });
    await eventBus.emit(PROPERTY_EVENTS.rateRuleCreated, { id: row.id, name: row.name, by: actor.email });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId,
      action: 'rates.update',
      entityType: 'rate_rule',
      entityId: row.id,
      summary: `Rate rule ${row.name} created`,
    });
    return row;
  });

  return toRateRuleView(created);
}

// ─── Settings ────────────────────────────────────────────────────────────────

export async function getSettings(actor: Actor): Promise<SettingView[]> {
  void actor;
  const rows = await withDb((db) => listSettingRows(db));
  return rows.map(toSettingView);
}

export async function updateSettings(input: UpdateSettingsInput, actor: Actor): Promise<SettingView[]> {
  await withTx(async (tx) => {
    await upsertSettings(
      tx,
      input.settings.map((s) => ({ ...s, updatedBy: actor.id })),
    );
    await eventBus.emit(PROPERTY_EVENTS.settingsUpdated, {
      keys: input.settings.map((s) => s.key),
      by: actor.email,
    });
    await recordAudit(tx, {
      actor: auditActor(actor),
      propertyId: null,
      action: 'settings.update',
      entityType: 'setting',
      summary: `Settings updated: ${input.settings.map((s) => s.key).join(', ')}`,
    });
  });
  return getSettings(actor);
}