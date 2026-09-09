/**
 * modules/housekeeping/service.ts
 *
 * The housekeeping board (blueprint §13.4) and the one-tap status flip.
 *
 * The board is a read projection, so the module owns no tables:
 *  - rooms come from property.service (condition + housekeeping, its DDL)
 *  - the per-room type/name and the per-date cell come from availability's
 *    tape (the allocation-ledger read side)
 *  - the activity flag (Arrival / Departure / Stayover / Vacant) is derived
 *    from bookings' ledger lists for the same date
 *
 * The flip is written through property.service.setHousekeepingState (the rooms
 * DDL owner); the housekeeping ROUTE enforces housekeeping.update. The board
 * then broadcasts over SSE so the front desk sees a room go clean live.
 */
import { broadcast } from '@/core/realtime';
import { addDays, type DateOnly } from '@/core/dates';
import { type Actor } from '@/modules/identity/auth-guard';
import { getTape } from '@/modules/availability/service';
import { listRoomsForBoard, setHousekeepingState } from '@/modules/property/service';
import { expectedArrivals, expectedDepartures, inHouseRooms } from '@/modules/bookings/service';
import type { BoardRoomView } from './types';
import type { UpdateHousekeepingInput } from './validation';

export async function getHousekeepingBoard(date: string, actor: Actor): Promise<BoardRoomView[]> {
  const [tape, rooms, arrivals, departures, inHouse] = await Promise.all([
    getTape(date, addDays(date as DateOnly, 1), actor),
    listRoomsForBoard(actor),
    expectedArrivals(date, actor),
    expectedDepartures(date, actor),
    inHouseRooms(actor),
  ]);

  const room = new Map(rooms.map((r) => [r.id, r]));
  const arrivalRooms = new Set(arrivals.map((r) => r.roomId));
  const departureRooms = new Set(departures.map((r) => r.roomId));
  const stayoverRooms = new Set(inHouse.map((r) => r.roomId));

  return tape.map((t) => {
    const base = room.get(t.roomId);
    let activity: BoardRoomView['activity'];
    if (arrivalRooms.has(t.roomId)) activity = 'arrival';
    else if (departureRooms.has(t.roomId)) activity = 'departure';
    else if (stayoverRooms.has(t.roomId)) activity = 'stayover';
    else activity = 'vacant';

    return {
      id: t.roomId,
      roomNumber: t.roomNumber,
      floor: t.floor,
      roomTypeId: t.roomTypeId,
      roomTypeName: t.roomTypeName,
      condition: base?.condition ?? 'available',
      housekeeping: base?.housekeeping ?? 'clean',
      activity,
    };
  });
}

export async function updateHousekeeping(
  id: string,
  input: UpdateHousekeepingInput,
  actor: Actor,
): Promise<{ id: string; roomNumber: string; housekeeping: string; condition: string }> {
  const updated = await setHousekeepingState(
    id,
    { housekeeping: input.housekeeping, condition: input.condition },
    actor,
  );
  broadcast('housekeeping', 'board.updated', {
    roomId: updated.id,
    roomNumber: updated.roomNumber,
    housekeeping: updated.housekeeping,
    condition: updated.condition,
  });
  return {
    id: updated.id,
    roomNumber: updated.roomNumber,
    housekeeping: updated.housekeeping,
    condition: updated.condition,
  };
}