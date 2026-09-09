/**
 * modules/maintenance/validation.ts
 *
 * Route-facing Zod schemas for the maintenance flow (§14.1, spec A10/A15).
 * Business transitions (which statuses may follow which) are enforced in the
 * service; here we validate shape only.
 */
import { z } from 'zod';
import type { MaintenancePriority, MaintenanceStatus } from './types';

const uuid = z.uuid('A valid id is required');
const isoDate = z
  .string({ message: 'Date must be a string' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');
const optionalText = (max: number, label = 'text') =>
  z.string({ message: `${label} must be a string` }).trim().max(max, `${label} too long`).nullish();

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const STATUSES = ['reported', 'pending', 'in_progress', 'resolved', 'closed'] as const;
type Priority = (typeof PRIORITIES)[number];
type Status = (typeof STATUSES)[number];

export const reportIssueSchema = z
  .object({
    title: z.string({ message: 'Title is required' }).trim().min(1, 'Title is required').max(120, 'Title too long'),
    description: z
      .string({ message: 'Description is required' })
      .trim()
      .min(1, 'Description is required')
      .max(2000, 'Description too long'),
    roomId: uuid.optional(),
    location: optionalText(200, 'Location'),
    priority: z.enum(PRIORITIES).optional(),
    estimatedCost: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal like 18500.00')
      .optional(),
    takesRoomOffline: z.boolean().optional(),
    blockStartDate: isoDate.optional(),
    blockEndDate: isoDate.optional(),
    assignedTo: optionalText(200, 'Assignee'),
    assignedUserId: uuid.optional(),
  })
  .refine((v) => v.roomId !== undefined || v.location !== undefined, {
    message: 'A roomId or a location is required',
    path: ['roomId'],
  })
  .refine((v) => !v.takesRoomOffline || v.blockEndDate !== undefined, {
    message: 'blockEndDate is required when takesRoomOffline is true',
    path: ['blockEndDate'],
  })
  .refine((v) => !v.takesRoomOffline || (v.blockEndDate ?? '') > (v.blockStartDate ?? ''), {
    message: 'blockEndDate must be after blockStartDate',
    path: ['blockEndDate'],
  });

export type ReportIssueInput = z.infer<typeof reportIssueSchema>;

export const updateIssueSchema = z.object({
  status: z.enum(STATUSES).optional(),
  assignedTo: optionalText(200, 'Assignee'),
  assignedUserId: uuid.optional(),
  estimatedCost: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a decimal like 18500.00')
    .optional(),
  resolutionNotes: optionalText(1000, 'Resolution notes'),
  note: optionalText(500, 'Note'),
  fileIds: z.array(uuid).max(10).optional(),
});

export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;

export const listIssuesQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  roomId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListIssuesQuery = z.infer<typeof listIssuesQuerySchema>;

// Re-export the unions so callers can type without importing the DB enums.
export type { MaintenancePriority, MaintenanceStatus };
export type { Priority, Status };