/**
 * modules/identity/validation.ts
 *
 * Route-facing Zod schemas. Handlers validate the body here, then the service
 * re-enforces business rules (canModifyUser, last-admin guard, uniqueness).
 */
import { z } from 'zod';
import type { UserRole } from './permissions';

const ROLE_VALUES: readonly UserRole[] = ['admin', 'manager', 'receptionist'];
const STATUS_VALUES: readonly string[] = ['active', 'suspended', 'disabled'];

const strongPassword = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a digit');

const email = z.email('Enter a valid email address').trim().toLowerCase();

export const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Name is too long'),
  email,
  password: strongPassword,
  role: z.enum(ROLE_VALUES as [UserRole, ...UserRole[]], { message: 'Invalid role' }),
  propertyId: z.uuid('Valid property id required').nullish(),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(30).optional().or(z.literal('')),
    role: z.enum(ROLE_VALUES as [UserRole, ...UserRole[]], { message: 'Invalid role' }).optional(),
    propertyId: z.uuid('Valid property id required').nullish(),
    status: z.enum(STATUS_VALUES as [string, ...string[]], { message: 'Invalid status' }).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({
  password: strongPassword,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const listUsersQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  role: z.enum(ROLE_VALUES as [UserRole, ...UserRole[]], { message: 'Invalid role' }).optional(),
  status: z.enum(STATUS_VALUES as [string, ...string[]], { message: 'Invalid status' }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});