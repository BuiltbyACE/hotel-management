/**
 * modules/housekeeping/types.ts
 *
 * The housekeeping board's own view types (blueprint §13.4). The module owns
 * no DDL — it projects over the rooms table (condition + housekeeping, owned
 * by property) and the allocation ledger (activity flag, owned by
 * availability/bookings). The string unions mirror rooms.housekeeping_status
 * and rooms.condition locally so the module stays self-contained.
 */

export type HousekeepingValue = 'clean' | 'dirty' | 'inspected' | 'out_of_service';
export type RoomConditionValue = 'available' | 'occupied' | 'cleaning' | 'maintenance' | 'out_of_order';
export type BoardActivity = 'arrival' | 'departure' | 'stayover' | 'vacant';

/** One room tile on the board. */
export interface BoardRoomView {
  id: string;
  roomNumber: string;
  floor: string | null;
  roomTypeId: string;
  roomTypeName: string;
  condition: RoomConditionValue;
  housekeeping: HousekeepingValue;
  activity: BoardActivity;
}