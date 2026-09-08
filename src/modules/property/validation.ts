/**
 * modules/property/validation.ts
 *
 * Route-facing Zod schemas. Handlers validate here; the service re-enforces
 * business rules (scope, uniqueness, reference checks, delete guards).
 */
import { z } from 'zod';
import type { HousekeepingStatus, RoomCondition } from './types';

const ROOM_CONDITIONS: readonly RoomCondition[] = ['available', 'occupied', 'cleaning', 'maintenance', 'out_of_order'];
const HOUSEKEEPING: readonly HousekeepingStatus[] = ['clean', 'dirty', 'inspected', 'out_of_service'];

const uuid = z.uuid('A valid id is required');

const money = z
  .number({ message: 'Amount must be a number' })
  .min(0, 'Amount cannot be negative')
  .refine((v) => Math.round(v * 100) / 100 === v, { message: 'Amount supports at most 2 decimal places' });

const isoDate = z
  .string({ message: 'Date must be a string' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

// ─── Room types ─────────────────────────────────────────────────────────────

export const roomTypeCreateSchema = z.object({
  code: z
    .string({ message: 'Code is required' })
    .trim()
    .min(1, 'Code is required')
    .max(20, 'Code too long')
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1, 'Name is required').max(120, 'Name too long'),
  description: z.string().trim().max(500).optional(),
  baseRate: money,
  maxOccupancy: z.number().int().min(1).max(20).default(2),
  maxAdults: z.number().int().min(0).max(20).default(2),
  maxChildren: z.number().int().min(0).max(20).default(0),
  extraBedRate: money.default(0),
  amenities: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  photoFileIds: z.array(uuid).max(20).default([]),
  displayOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

export type CreateRoomTypeInput = z.infer<typeof roomTypeCreateSchema>;

export const roomTypeUpdateSchema = z
  .object({
    code: z.string().trim().min(1, 'Code is required').max(20, 'Code too long').transform((v) => v.toUpperCase()),
    name: z.string().trim().min(1, 'Name is required').max(120, 'Name too long'),
    description: z.string().trim().max(500).nullish(),
    baseRate: money,
    maxOccupancy: z.number().int().min(1).max(20),
    maxAdults: z.number().int().min(0).max(20),
    maxChildren: z.number().int().min(0).max(20),
    extraBedRate: money,
    amenities: z.array(z.string().trim().min(1).max(60)).max(50),
    photoFileIds: z.array(uuid).max(20),
    displayOrder: z.number().int().min(0),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type UpdateRoomTypeInput = z.infer<typeof roomTypeUpdateSchema>;

export const listRoomTypesQuerySchema = z.object({
  active: z
    .enum(['true', 'false'], { message: 'active must be true or false' })
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  search: z.string().trim().max(120).optional(),
});

// ─── Rooms ───────────────────────────────────────────────────────────────────

export const roomCreateSchema = z.object({
  roomNumber: z.string().trim().min(1, 'Room number is required').max(20, 'Room number too long'),
  roomTypeId: uuid,
  floor: z.string().trim().max(20).optional(),
  notes: z.string().trim().max(500).optional(),
  condition: z.enum(ROOM_CONDITIONS, { message: 'Invalid condition' }).default('available'),
  housekeeping: z.enum(HOUSEKEEPING, { message: 'Invalid housekeeping status' }).default('clean'),
  isActive: z.boolean().default(true),
});

export type CreateRoomInput = z.infer<typeof roomCreateSchema>;

export const roomUpdateSchema = z
  .object({
    roomNumber: z.string().trim().min(1, 'Room number is required').max(20, 'Room number too long'),
    roomTypeId: uuid,
    floor: z.string().trim().max(20).nullish(),
    notes: z.string().trim().max(500).nullish(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type UpdateRoomInput = z.infer<typeof roomUpdateSchema>;

export const changeConditionSchema = z.object({
  condition: z.enum(ROOM_CONDITIONS, { message: 'Invalid condition' }),
  note: z.string().trim().max(500).optional(),
});

export type ChangeConditionInput = z.infer<typeof changeConditionSchema>;

export const listRoomsQuerySchema = z.object({
  typeId: uuid.optional(),
  condition: z.enum(ROOM_CONDITIONS, { message: 'Invalid condition' }).optional(),
  floor: z.string().trim().max(20).optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ─── Rate rules [P2] ─────────────────────────────────────────────────────────

export const rateRuleCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(120, 'Name too long'),
    roomTypeId: uuid.optional(),
    validFrom: isoDate,
    validTo: isoDate,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([...ALL_DAYS]),
    minNights: z.number().int().min(1).max(365).default(1),
    rate: money,
    priority: z.number().int().min(0).max(100).default(0),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.validTo >= v.validFrom, {
    message: 'validTo must be on or after validFrom',
    path: ['validTo'],
  });

export type CreateRateRuleInput = z.infer<typeof rateRuleCreateSchema>;

// ─── Settings ────────────────────────────────────────────────────────────────

const jsonValue = z.unknown().refine((v) => JSON.stringify(v) !== undefined && v !== undefined, {
  message: 'Value must be valid JSON',
});

export const updateSettingsSchema = z.object({
  settings: z
    .array(
      z.object({
        key: z.string().trim().min(1, 'Key is required').max(120, 'Key too long'),
        value: jsonValue,
        description: z.string().trim().max(500).optional(),
      }),
    )
    .min(1, 'Provide at least one setting'),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;