/**
 * modules/property/types.ts
 *
 * Domain types for the property & inventory context. The enums live on the
 * schema (room_condition / housekeeping_status); these are the shape-level
 * types services and routes exchange.
 */

export type RoomCondition = 'available' | 'occupied' | 'cleaning' | 'maintenance' | 'out_of_order';
export type HousekeepingStatus = 'clean' | 'dirty' | 'inspected' | 'out_of_service';

/** Public view of a room_type row. Numeric money surfaces as numbers. */
export interface RoomTypeView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  baseRate: number;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  extraBedRate: number;
  amenities: string[];
  photoFileIds: string[];
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Public view of a room row. */
export interface RoomView {
  id: string;
  roomNumber: string;
  roomTypeId: string;
  floor: string | null;
  condition: RoomCondition;
  housekeeping: HousekeepingStatus;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Public view of a rate rule. */
export interface RateRuleView {
  id: string;
  roomTypeId: string | null;
  name: string;
  validFrom: string;
  validTo: string;
  daysOfWeek: number[];
  minNights: number;
  rate: number;
  priority: number;
  isActive: boolean;
}

/** Public view of a settings entry (value is JSONB). */
export interface SettingView {
  key: string;
  value: unknown;
  description: string | null;
  updatedBy: string | null;
  updatedAt: string;
}