/**
 * modules/availability/repository.ts
 *
 * Read-only queries over the allocation ledger and the surrounding inventory.
 * All cross-module tables (rooms, room_types, rate_rules, settings, properties)
 * are read through the core schema barrel — never through another module's
 * repository (boundary rule).
 *
 * The authoritative overlap check is the exclusion constraint; these queries
 * exist to answer "what is free" quickly (§10). The booking transaction uses
 * SELECT … FOR UPDATE as the real guard.
 */
import { and, asc, eq, gt, inArray, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm';
import { schema, type Db, type Tx } from '@/core/db';
import type { CalendarDayView, TapeCellStatus, TapeRowView } from './types';

/** Statuses whose allocations actually consume a room (exclusion side too). */
export const LIVE_ALLOCATION_STATUSES = ['held', 'confirmed', 'checked_in', 'checked_out', 'blocked'] as const;

export async function resolvePropertyId(db: Db, preferred: string | null): Promise<string | null> {
  if (preferred) {
    const rows = await db
      .select({ id: schema.properties.id })
      .from(schema.properties)
      .where(and(eq(schema.properties.id, preferred), eq(schema.properties.isActive, true)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(eq(schema.properties.isActive, true))
    .orderBy(asc(schema.properties.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface FindRoomsFilters {
  propertyId: string;
  arrival: string;
  departure: string;
  roomTypeId?: string;
  occupancy?: number;
  excludeBookingId?: string;
}

export async function findAvailableRooms(db: Db, f: FindRoomsFilters) {
  const allocations = schema.roomAllocations;
  return db
    .select({
      id: schema.rooms.id,
      roomNumber: schema.rooms.roomNumber,
      floor: schema.rooms.floor,
      roomTypeId: schema.roomTypes.id,
      roomTypeCode: schema.roomTypes.code,
      roomTypeName: schema.roomTypes.name,
      baseRate: schema.roomTypes.baseRate,
      maxOccupancy: schema.roomTypes.maxOccupancy,
    })
    .from(schema.rooms)
    .innerJoin(schema.roomTypes, eq(schema.roomTypes.id, schema.rooms.roomTypeId))
    .where(
      and(
        eq(schema.rooms.propertyId, f.propertyId),
        isNull(schema.rooms.deletedAt),
        eq(schema.rooms.isActive, true),
        ne(schema.rooms.condition, 'out_of_order'),
        f.roomTypeId ? eq(schema.rooms.roomTypeId, f.roomTypeId) : undefined,
        f.occupancy ? sql`${schema.roomTypes.maxOccupancy} >= ${f.occupancy}` : undefined,
        notExists(
          db
            .select({ one: sql`1` })
            .from(allocations)
            .where(
              and(
                eq(allocations.roomId, schema.rooms.id),
                inArray(allocations.status, [...LIVE_ALLOCATION_STATUSES]),
                f.excludeBookingId
                  ? or(
                      isNull(allocations.bookingId),
                      ne(allocations.bookingId, f.excludeBookingId),
                    )
                  : undefined,
                sql`daterange(${allocations.startDate}::date, ${allocations.endDate}::date, '[)') && daterange(${f.arrival}::date, ${f.departure}::date, '[)')`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(schema.roomTypes.displayOrder), asc(schema.rooms.roomNumber));
}

export interface CalendarFilters {
  propertyId: string;
  from: string;
  to: string;
  roomTypeId?: string;
}

/** Sellable room counts per room type. */
export async function sellablePerRoomType(db: Db, propertyId: string) {
  return db
    .select({
      roomTypeId: schema.rooms.roomTypeId,
      total: sql<number>`count(*)::int`,
    })
    .from(schema.rooms)
    .where(
      and(
        eq(schema.rooms.propertyId, propertyId),
        isNull(schema.rooms.deletedAt),
        eq(schema.rooms.isActive, true),
        ne(schema.rooms.condition, 'out_of_order'),
      ),
    )
    .groupBy(schema.rooms.roomTypeId);
}

/** Room types for the property (calendar rows are a cross of these × days). */
export async function listSellableRoomTypes(db: Db, propertyId: string) {
  return db
    .select({
      id: schema.roomTypes.id,
      code: schema.roomTypes.code,
      name: schema.roomTypes.name,
      displayOrder: schema.roomTypes.displayOrder,
    })
    .from(schema.roomTypes)
    .where(and(eq(schema.roomTypes.propertyId, propertyId), isNull(schema.roomTypes.deletedAt)))
    .orderBy(asc(schema.roomTypes.displayOrder), asc(schema.roomTypes.code));
}

export interface AllocationOverlapRow {
  roomId: string;
  roomTypeId: string;
  status: string;
  startDate: string;
  endDate: string;
}

/** Live allocations overlapping [from, to) for a property. */
export async function liveAllocationsForRange(db: Db, propertyId: string, from: string, to: string) {
  const a = schema.roomAllocations;
  return db
    .select({
      roomId: a.roomId,
      roomTypeId: schema.rooms.roomTypeId,
      status: a.status,
      startDate: a.startDate,
      endDate: a.endDate,
    })
    .from(a)
    .innerJoin(schema.rooms, eq(schema.rooms.id, a.roomId))
    .where(
      and(
        eq(a.propertyId, propertyId),
        inArray(a.status, [...LIVE_ALLOCATION_STATUSES]),
        lt(a.startDate, to),
        gt(a.endDate, from),
      ),
    );
}

/** Rooms shown on the tape grid (all active rooms incl. out_of_order). */
export async function listTapeRooms(db: Db, propertyId: string) {
  return db
    .select({
      id: schema.rooms.id,
      roomNumber: schema.rooms.roomNumber,
      floor: schema.rooms.floor,
      condition: schema.rooms.condition,
      roomTypeId: schema.roomTypes.id,
      roomTypeName: schema.roomTypes.name,
      displayOrder: schema.roomTypes.displayOrder,
    })
    .from(schema.rooms)
    .innerJoin(schema.roomTypes, eq(schema.roomTypes.id, schema.rooms.roomTypeId))
    .where(and(eq(schema.rooms.propertyId, propertyId), isNull(schema.rooms.deletedAt)))
    .orderBy(asc(schema.rooms.roomNumber));
}

// ─── Quote data ──────────────────────────────────────────────────────────────

export interface QuoteRoomTypeRecord {
  id: string;
  code: string;
  name: string;
  baseRate: string;
  maxOccupancy: number;
}

export async function findQuoteRoomType(db: Db | Tx, propertyId: string, roomTypeId: string): Promise<QuoteRoomTypeRecord | null> {
  const rows = await db
    .select({
      id: schema.roomTypes.id,
      code: schema.roomTypes.code,
      name: schema.roomTypes.name,
      baseRate: schema.roomTypes.baseRate,
      maxOccupancy: schema.roomTypes.maxOccupancy,
    })
    .from(schema.roomTypes)
    .where(
      and(
        eq(schema.roomTypes.id, roomTypeId),
        eq(schema.roomTypes.propertyId, propertyId),
        isNull(schema.roomTypes.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface RateRuleQuoteRecord {
  id: string;
  roomTypeId: string | null;
  validFrom: string;
  validTo: string;
  daysOfWeek: number[];
  minNights: number;
  rate: string;
  priority: number;
}

/** Active rules for a property, best-match first (specific overrides global). */
export async function listQuoteRateRules(db: Db | Tx, propertyId: string): Promise<RateRuleQuoteRecord[]> {
  const rules = schema.rateRules;
  return db
    .select({
      id: rules.id,
      roomTypeId: rules.roomTypeId,
      validFrom: rules.validFrom,
      validTo: rules.validTo,
      daysOfWeek: rules.daysOfWeek,
      minNights: rules.minNights,
      rate: rules.rate,
      priority: rules.priority,
    })
    .from(rules)
    .where(and(eq(rules.propertyId, propertyId), eq(rules.isActive, true)))
    .orderBy(sql`${rules.priority} desc, ${rules.roomTypeId} IS NOT NULL desc`);
}

export interface TaxSettingsRecord {
  vatRate: number;
  levyRate: number;
  taxInclusive: boolean;
}

/** VAT / levy rates are settings (never hardcoded). */
export async function readTaxSettings(db: Db | Tx): Promise<TaxSettingsRecord> {
  const keys = ['vat_rate', 'levy_rate', 'tax_inclusive_pricing'];
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys));
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));
  const num = (key: string, fallback: number): number => {
    const raw = map.get(key);
    if (raw === undefined || raw === null) return fallback;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = map.get(key);
    return typeof raw === 'boolean' ? raw : fallback;
  };
  return {
    vatRate: num('vat_rate', 16),
    levyRate: num('levy_rate', 0),
    taxInclusive: bool('tax_inclusive_pricing', false),
  };
}

// ─── Date helpers ────────────────────────────────────────────────────────────

/** Every night in [arrival, departure). */
export function eachNight(arrival: string, departure: string): string[] {
  const days: string[] = [];
  const start = new Date(`${arrival}T00:00:00Z`);
  const end = new Date(`${departure}T00:00:00Z`);
  const cursor = new Date(start);
  while (cursor < end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Night index of a date within [from, to) — also the day count. */
export function nightsBetween(from: string, to: string): number {
  return eachNight(from, to).length;
}

export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function buildCalendarRows(
  from: string,
  to: string,
  roomTypes: { id: string; name: string; displayOrder: number }[],
  sellable: Map<string, number>,
  allocations: AllocationOverlapRow[],
): CalendarDayView[] {
  const days = eachNight(from, to);
  const sold = new Map<string, number>();
  const inc = (key: string) => sold.set(key, (sold.get(key) ?? 0) + 1);
  for (const alloc of allocations) {
    const start = alloc.startDate < from ? from : alloc.startDate;
    const end = alloc.endDate > to ? to : alloc.endDate;
    for (const day of days) {
      if (day >= start && day < end) inc(`${alloc.roomTypeId}|${day}`);
    }
  }
  const rows: CalendarDayView[] = [];
  for (const rt of roomTypes) {
    const total = sellable.get(rt.id) ?? 0;
    if (total <= 0) continue;
    for (const day of days) {
      const taken = sold.get(`${rt.id}|${day}`) ?? 0;
      rows.push({
        date: day,
        roomTypeId: rt.id,
        roomTypeName: rt.name,
        displayOrder: rt.displayOrder,
        total,
        sold: taken,
        available: total - taken,
      });
    }
  }
  rows.sort((a, b) => a.displayOrder - b.displayOrder || (a.date < b.date ? -1 : 1));
  return rows;
}

export function buildTapeRows(
  from: string,
  to: string,
  rooms: { id: string; roomNumber: string; floor: string | null; roomTypeId: string; roomTypeName: string; condition: string }[],
  allocations: AllocationOverlapRow[],
): TapeRowView[] {
  const days = eachNight(from, to);
  const byDay = (roomId: string, day: string): TapeCellStatus | null => {
    const hit = allocations.find(
      (a) => a.roomId === roomId && day >= a.startDate && day < a.endDate,
    );
    return hit ? (hit.status as TapeCellStatus) : null;
  };
  return rooms.map((room) => {
    const outOfOrder = room.condition === 'out_of_order';
    return {
      roomId: room.id,
      roomNumber: room.roomNumber,
      floor: room.floor,
      roomTypeId: room.roomTypeId,
      roomTypeName: room.roomTypeName,
      days: days.map((date) => {
        const allocStatus = byDay(room.id, date);
        const status: TapeCellStatus = outOfOrder ? 'out_of_order' : allocStatus ?? 'available';
        return { date, status };
      }),
    };
  });
}