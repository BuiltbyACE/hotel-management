/**
 * modules/guests/validation.ts
 *
 * Route-facing Zod schemas. Handlers validate here; the service re-enforces
 * business rules (scope, ID-document dedupe, blacklist, delete guards).
 */
import { z } from 'zod';
import type { IdDocumentType } from './types';

const DOCUMENT_TYPES: readonly IdDocumentType[] = ['national_id', 'passport', 'driving_licence', 'military', 'other'];
const uuid = z.uuid('A valid id is required');

const isoDate = z
  .string({ message: 'Date must be a string' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates');

const optionalText = (max: number, label = 'text') =>
  z
    .string({ message: `${label} must be a string` })
    .trim()
    .max(max, `${label} too long`)
    .nullish();

export const guestCreateSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Full name is required').max(120, 'Full name too long'),
    phone: z
      .string()
      .trim()
      .min(7, 'Phone number looks too short')
      .max(30, 'Phone number too long')
      .optional(),
    email: z.string().trim().email('A valid email is required').max(120, 'Email too long').optional(),
    idType: z.enum(DOCUMENT_TYPES, { message: 'Invalid ID type' }).optional(),
    idNumber: optionalText(40, 'ID number'),
    nationality: optionalText(60, 'Nationality'),
    dateOfBirth: isoDate.optional(),
    address: optionalText(300, 'Address'),
    company: optionalText(120, 'Company'),
    notes: optionalText(500, 'Notes'),
  })
  .refine((v) => !v.idNumber || v.idType, { message: 'idType is required when idNumber is provided', path: ['idType'] });

export type CreateGuestInput = z.infer<typeof guestCreateSchema>;

export const guestUpdateSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Full name is required').max(120, 'Full name too long'),
    phone: z.string().trim().min(7, 'Phone number looks too short').max(30, 'Phone number too long').nullish(),
    email: z.string().trim().email('A valid email is required').max(120, 'Email too long').nullish(),
    idType: z.enum(DOCUMENT_TYPES, { message: 'Invalid ID type' }).nullish(),
    idNumber: optionalText(40, 'ID number'),
    nationality: optionalText(60, 'Nationality'),
    dateOfBirth: isoDate.nullish(),
    address: optionalText(300, 'Address'),
    company: optionalText(120, 'Company'),
    notes: optionalText(500, 'Notes'),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type UpdateGuestInput = z.infer<typeof guestUpdateSchema>;

export const listGuestsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const blacklistGuestSchema = z.object({
  reason: z.string().trim().min(5, 'A reason of at least 5 characters is required').max(500, 'Reason too long'),
});

export const mergeGuestsSchema = z
  .object({
    keepId: uuid,
    mergeIds: z.array(uuid).min(1, 'Provide at least one guest to merge').max(50, 'Too many guests'),
  })
  .refine((v) => !v.mergeIds.includes(v.keepId), {
    message: 'keepId cannot appear in mergeIds',
    path: ['mergeIds'],
  });

export type MergeGuestsInput = z.infer<typeof mergeGuestsSchema>;

export const attachDocumentSchema = z.object({
  fileId: uuid,
  docType: z.enum(DOCUMENT_TYPES, { message: 'Invalid document type' }),
});