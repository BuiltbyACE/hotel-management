/**
 * modules/availability/types.ts
 *
 * Read-side views over the allocation ledger (blueprint §10).
 * Nothing here mutates state — availability is a bounded context that only
 * reads; bookings writes the ledger.
 */

export type AllocationStatusValue = 'held' | 'confirmed' | 'checked_in' | 'checked_out' | 'blocked' | 'released';

/** A single room that is free for the requested range (§10.1). */
export interface AvailableRoomView {
  id: string;
  roomNumber: string;
  floor: string | null;
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
  baseRate: number;
  maxOccupancy: number;
}

/** One room-type × day cell of the calendar strip (§10.2). */
export interface CalendarDayView {
  date: string;
  roomTypeId: string;
  roomTypeName: string;
  displayOrder: number;
  total: number;
  sold: number;
  available: number;
}

/** Tape-chart cell statuses. */
export type TapeCellStatus = AllocationStatusValue | 'available' | 'out_of_order';

/** One room × day cell of the tape chart (rooms × dates grid). */
export interface TapeCellView {
  date: string;
  status: TapeCellStatus;
}

/** One room row of the tape chart. */
export interface TapeRowView {
  roomId: string;
  roomNumber: string;
  floor: string | null;
  roomTypeId: string;
  roomTypeName: string;
  days: TapeCellView[];
}

/** One night of a quote. */
export interface QuoteNightView {
  date: string;
  rate: number;
  ruleId: string | null;
}

/** One tax/levy line on a quote. `rate` is a percentage point; money is a string. */
export interface TaxLineView {
  name: string;
  rate: number;
  amount: string;
}

/** Server-side pricing for a stay (§10.3). All money values are 2-dp strings. */
export interface QuoteView {
  roomTypeId: string;
  roomTypeName: string;
  arrival: string;
  departure: string;
  nights: QuoteNightView[];
  roomSubtotal: string;
  taxBreakdown: TaxLineView[];
  total: string;
  taxInclusive: boolean;
}