/**
 * modules/property/schema.ts
 *
 * Property & inventory: the hotel itself, key/value settings, room types,
 * rooms (with physical condition + housekeeping state), and rate rules.
 * Owned tables (blueprint §5.1): properties, settings, room_types, rooms, rate_rules.
 *
 * Mirror of drizzle/0001_full_schema.sql §2 + §6. Column keys are camelCase;
 * the drizzle client runs with casing:'snake_case' so they map 1:1 to DDL.
 * `properties.logo_file_id` → files is a circular FK added in the migration
 * via ALTER (drizzle/0001 §10) and is therefore not repeated here.
 */
import { sql } from 'drizzle-orm';
import { boolean, char, check, date, index, jsonb, numeric, pgEnum, pgTable, smallint, text, time, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const roomCondition = pgEnum('room_condition', ['available', 'occupied', 'cleaning', 'maintenance', 'out_of_order']);
export const housekeepingStatus = pgEnum('housekeeping_status', ['clean', 'dirty', 'inspected', 'out_of_service']);

export const properties = pgTable(
  'properties',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    address: text('address'),
    city: text('city'),
    country: text('country').notNull().default('KE'),
    timezone: text('timezone').notNull().default('Africa/Nairobi'),
    currency: char('currency', { length: 3 }).notNull().default('KES'),
    phone: text('phone'),
    email: text('email'),
    taxPin: text('tax_pin'),
    logoFileId: uuid('logo_file_id'),
    checkInTime: time('check_in_time').notNull().default('14:00'),
    checkOutTime: time('check_out_time').notNull().default('10:00'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const settings = pgTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    description: text('description'),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const roomTypes = pgTable(
  'room_types',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    baseRate: numeric('base_rate', { precision: 14, scale: 2 }).notNull(),
    maxOccupancy: smallint('max_occupancy').notNull(),
    maxAdults: smallint('max_adults').notNull().default(2),
    maxChildren: smallint('max_children').notNull().default(0),
    extraBedRate: numeric('extra_bed_rate', { precision: 14, scale: 2 }).notNull().default('0'),
    amenities: text('amenities').array().notNull().default(sql`'{}'`),
    photoFileIds: uuid('photo_file_ids').array().notNull().default(sql`'{}'`),
    displayOrder: smallint('display_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('room_types_code_uq')
      .on(sql`${t.propertyId}, upper(${t.code})`)
      .where(sql`${t.deletedAt} IS NULL`),
    index('room_types_amenities_gin').using('gin', sql`${t.amenities}`),
    check('room_types_base_rate_check', sql`${t.baseRate} >= 0`),
    check('room_types_max_occupancy_check', sql`${t.maxOccupancy} BETWEEN 1 AND 20`),
    check('room_types_extra_bed_rate_check', sql`${t.extraBedRate} >= 0`),
  ],
);

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    roomTypeId: uuid('room_type_id').notNull(),
    roomNumber: text('room_number').notNull(),
    floor: text('floor'),
    condition: roomCondition('condition').notNull().default('available'),
    housekeeping: housekeepingStatus('housekeeping').notNull().default('clean'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('rooms_number_uq')
      .on(sql`${t.propertyId}, upper(${t.roomNumber})`)
      .where(sql`${t.deletedAt} IS NULL`),
    index('rooms_type_idx').on(t.roomTypeId),
    index('rooms_condition_idx').on(t.propertyId, t.condition).where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const rateRules = pgTable(
  'rate_rules',
  {
    id: uuid('id').primaryKey().default(sql`new_id()`),
    propertyId: uuid('property_id').notNull(),
    roomTypeId: uuid('room_type_id'),
    name: text('name').notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }).notNull(),
    daysOfWeek: smallint('days_of_week').array().notNull().default(sql`'{0,1,2,3,4,5,6}'`),
    minNights: smallint('min_nights').notNull().default(1),
    rate: numeric('rate', { precision: 14, scale: 2 }).notNull(),
    priority: smallint('priority').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // CHECK (valid_to >= valid_from) — SQL-only via rate_rules_valid_to_check name parity
    index('rate_rules_lookup_idx').on(t.propertyId, t.roomTypeId, t.validFrom, t.validTo).where(sql`${t.isActive}`),
    check('rate_rules_valid_period_check', sql`${t.validTo} >= ${t.validFrom}`),
    check('rate_rules_rate_check', sql`${t.rate} >= 0`),
  ],
);