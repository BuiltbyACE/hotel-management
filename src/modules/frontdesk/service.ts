/**
 * modules/frontdesk/service.ts
 *
 * The front desk (blueprint §13.1, §16.3). Home to the today board and the
 * walk-in, which is the booking engine's create + check-in composed behind one
 * front-desk gesture. The module owns no tables: everything here calls into
 * bookings (ledger lists, the booking engine) and property (sellable room
 * count) services, and re-shapes into frontdesk's own views.
 *
 * The walk-in runs as create-then-check-in (two transactions). If check-in is
 * refused (deposit rule, illegal transition) the confirmed booking stands and
 * the front desk resolves it at the register — never a half-written ledger.
 */
import { type Actor } from '@/modules/identity/auth-guard';
import {
  checkInBooking,
  createBooking,
  expectedArrivals,
  expectedDepartures,
  inHouseRooms,
} from '@/modules/bookings/service';
import { listRoomsForBoard } from '@/modules/property/service';
import type { LedgerRowView, TodaySummaryView } from './types';
import type { WalkInInput } from './validation';

function toRows(rows: readonly {
  bookingId: string;
  reference: string;
  status: string;
  guestName: string;
  roomId: string;
  roomNumber: string;
  date: string;
}[]): LedgerRowView[] {
  return rows.map((r) => ({
    bookingId: r.bookingId,
    reference: r.reference,
    status: r.status,
    guestName: r.guestName,
    roomId: r.roomId,
    roomNumber: r.roomNumber,
    date: r.date,
  }));
}

/** Rooms expected to check in on `date`. */
export async function arrivalsOn(date: string, actor: Actor): Promise<LedgerRowView[]> {
  return toRows(await expectedArrivals(date, actor));
}

/** Rooms due out on `date` (still in-house or already checked out today). */
export async function departuresOn(date: string, actor: Actor): Promise<LedgerRowView[]> {
  return toRows(await expectedDepartures(date, actor));
}

/** Rooms occupied right now. */
export async function inHouseOn(actor: Actor): Promise<LedgerRowView[]> {
  return toRows(await inHouseRooms(actor));
}

/** The at-a-glance today board: arrivals, departures, in-house, occupancy. */
export async function getTodaySummary(date: string, actor: Actor): Promise<TodaySummaryView> {
  const [arrivals, departures, inHouse, rooms] = await Promise.all([
    arrivalsOn(date, actor),
    departuresOn(date, actor),
    inHouseOn(actor),
    listRoomsForBoard(actor),
  ]);
  const roomsTotal = rooms.length;
  const roomsOccupied = inHouse.length;
  return {
    date,
    roomsTotal,
    roomsOccupied,
    roomsVacant: roomsTotal - roomsOccupied,
    occupancyPct: roomsTotal > 0 ? Math.round((roomsOccupied / roomsTotal) * 100) : 0,
    arrivals,
    departures,
    inHouse,
  };
}

/** Guest + booking + check-in behind one front-desk gesture (§16.3). */
export async function walkIn(input: WalkInInput, actor: Actor): Promise<Awaited<ReturnType<typeof checkInBooking>>> {
  const booking = await createBooking(
    {
      guest: {
        fullName: input.guest.fullName,
        phone: input.guest.phone ?? undefined,
        email: input.guest.email ?? undefined,
        idType: input.guest.idType ?? undefined,
        idNumber: input.guest.idNumber,
      },
      source: 'walk_in',
      rooms: input.rooms.map((r) => ({
        roomId: r.roomId,
        arrival: r.arrival,
        departure: r.departure,
        adults: r.adults,
        children: r.children,
        overrideRate: r.overrideRate,
      })),
      specialRequests: input.specialRequests ?? undefined,
      internalNotes: input.internalNotes ?? undefined,
      payment: input.payment ?? null,
    },
    actor,
  );
  return checkInBooking(booking.id, actor, input.overrideDepositReason ?? null);
}