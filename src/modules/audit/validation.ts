/**
 * modules/audit/validation.ts
 *
 * Route-facing Zod schemas for the audit trail + notifications.
 */
import { z } from 'zod';

const uuid = z.uuid('A valid id is required');

export const listActivityLogsQuerySchema = z.object({
  entityType: z.string().trim().max(64).optional(),
  entityId: uuid.optional(),
  actorId: uuid.optional(),
  action: z.string().trim().max(64).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListActivityLogsQuery = z.infer<typeof listActivityLogsQuerySchema>;

export const listNotificationsQuerySchema = z.object({
  includeRead: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;