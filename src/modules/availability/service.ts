/**
 * modules/availability/service.ts
 *
 * The read side of the allocation ledger (blueprint §10). Everything reads;
 * only the booking service writes allocations.
 *
 * `quoteStay` is deliberately exported with a db/tx handle so the booking
 * transaction can recompute the price server-side (§11.2 step 4). The route
 * wrappers below scope it to the actor's property.
 */
import { withDb, type Db, type Tx } from '@/core/db';
import { AppError } from '@/core/api';
import { M } from '@/core/money';
import { type Actor } from '@/modules/identity/auth-guard';
import {
  buildCalendarRows,
  buildTapeRows,
  dayOfWeek,
  eachNight,
  findAvailableRooms as findFreeRooms,
  findQuoteRoomType,
  listQuoteRateRules,
  listSellableRoomTypes,
  listTapeRooms,
  liveAllocationsForRange,
  readTaxSettings,
  resolvePropertyId,
  sellablePerRoomType,
  type AllocationOverlapRow,
  type FindRoomsFilters,
} from './repository';
import type { AvailableRoomView, CalendarDayView, QuoteView, TapeRowView } from './types';

async function scopeProperty(actor: Actor): Promise<string> {
  const propertyId = await withDb((db) => resolvePropertyId(db, actor.propertyId));
  if (!propertyId) throw AppError.notFound('No active property is configured');
  return propertyId;
}

// ─── Search ──────────────────────────────────────────────────────────────────

export async function findAvailableRooms(
  filters: Omit<FindRoomsFilters, 'propertyId'>,
  actor: Actor,
): Promise<AvailableRoomView[]> {
  const propertyId = await scopeProperty(actor);
  const rows = await withDb((db) => findFreeRooms(db, { propertyId, ...filters }));
  return rows.map((r) => ({
    id: r.id,
    roomNumber: r.roomNumber,
    floor: r.floor,
    roomTypeId: r.roomTypeId,
    roomTypeCode: r.roomTypeCode,
    roomTypeName: r.roomTypeName,
    baseRate: Number(r.baseRate),
    maxOccupancy: r.maxOccupancy,
  }));
}

export async function getCalendar(
  from: string,
  to: string,
  roomTypeId: string | undefined,
  actor: Actor,
): Promise<CalendarDayView[]> {
  const propertyId = await scopeProperty(actor);
  return withDb(async (db) => {
    const roomTypes = await listSellableRoomTypes(db, propertyId);
    const typed = roomTypeId ? roomTypes.filter((r) => r.id === roomTypeId) : roomTypes;
    const sellable = await sellablePerRoomType(db, propertyId);
    const allocs = await liveAllocationsForRange(db, propertyId, from, to);
    return buildCalendarRows(
      from,
      to,
      typed,
      new Map(sellable.map((s) => [s.roomTypeId, s.total])),
      allocs as AllocationOverlapRow[],
    );
  });
}

export async function getTape(from: string, to: string, actor: Actor): Promise<TapeRowView[]> {
  const propertyId = await scopeProperty(actor);
  return withDb(async (db) => {
    const rooms = await listTapeRooms(db, propertyId);
    const allocs = await liveAllocationsForRange(db, propertyId, from, to);
    return buildTapeRows(from, to, rooms, allocs as AllocationOverlapRow[]);
  });
}

// ─── Quoting ─────────────────────────────────────────────────────────────────

export interface QuoteInput {
  propertyId: string;
  roomTypeId: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  overrideRate?: number;
}

/** Money as DB-shaped text: exactly two decimals ("10000.00"). */
const fmt2 = (value: string): string => M.toDecimal(value).toFixed(2);

/**
 * Price a stay server-side. Resolution order (§10.3):
 * override → best active rate_rule (priority, then specific-over-global)
 * → room type base_rate. Rates are recomputed inside the booking transaction,
 * never trusted from the client.
 */
export async function quoteStay(db: Db | Tx, input: QuoteInput): Promise<QuoteView> {
  const roomType = await findQuoteRoomType(db, input.propertyId, input.roomTypeId);
  if (!roomType) throw AppError.notFound('Room type not found');

  const [rules, tax] = await Promise.all([
    listQuoteRateRules(db, input.propertyId),
    readTaxSettings(db),
  ]);

  const nights = eachNight(input.arrival, input.departure);
  const nightRows = nights.map((date) => {
    let rate: string;
    let ruleId: string | null = null;
    if (input.overrideRate !== undefined) {
      rate = input.overrideRate.toFixed(2);
    } else {
      const rule = rules.find(
        (r) =>
          (r.roomTypeId === null || r.roomTypeId === input.roomTypeId) &&
          r.validFrom <= date &&
          r.validTo >= date &&
          r.daysOfWeek.includes(dayOfWeek(date)) &&
          r.minNights <= nights.length,
      );
      if (rule) {
        rate = rule.rate;
        ruleId = rule.id;
      } else {
        rate = roomType.baseRate;
      }
    }
    return { date, rate: Number(rate), ruleId };
  });

  const subtotal = M.add(...nightRows.map((n) => n.rate.toFixed(2)));
  const vatAmount = tax.vatRate > 0 ? M.pct(subtotal, tax.vatRate) : M.of(0);
  const levyAmount = tax.levyRate > 0 ? M.pct(subtotal, tax.levyRate) : M.of(0);

  const taxBreakdown = [
    { name: 'VAT', rate: tax.vatRate, amount: fmt2(vatAmount) },
    { name: 'Levy', rate: tax.levyRate, amount: fmt2(levyAmount) },
  ].filter((t) => t.rate > 0);

  let total: string;
  if (tax.taxInclusive) {
    total = subtotal;
  } else {
    total = M.add(subtotal, vatAmount, levyAmount);
  }

  return {
    roomTypeId: roomType.id,
    roomTypeName: roomType.name,
    arrival: input.arrival,
    departure: input.departure,
    nights: nightRows,
    roomSubtotal: fmt2(subtotal),
    taxBreakdown,
    total: fmt2(total),
    taxInclusive: tax.taxInclusive,
  };
}

/** Route-facing wrapper: scope to the actor's property and run the quote. */
export async function quoteStayForActor(
  input: { roomTypeId: string; arrival: string; departure: string; adults: number; children: number },
  actor: Actor,
): Promise<QuoteView> {
  const propertyId = await scopeProperty(actor);
  return withDb((db) =>
    quoteStay(db, {
      propertyId,
      roomTypeId: input.roomTypeId,
      arrival: input.arrival,
      departure: input.departure,
      adults: input.adults,
      children: input.children,
    }),
  );
}