/**
 * Unit test: guests route-facing schemas (no DB required).
 */
import { describe, expect, it } from 'vitest';
import {
  blacklistGuestSchema,
  guestCreateSchema,
  mergeGuestsSchema,
  attachDocumentSchema,
} from '@/modules/guests/validation';

const KEEP = '11111111-1111-4111-8111-111111111111';

describe('guestCreateSchema', () => {
  it('accepts a minimal guest', () => {
    const out = guestCreateSchema.parse({ fullName: 'Juma' });
    expect(out.fullName).toBe('Juma');
  });

  it('requires idType when idNumber is provided', () => {
    expect(guestCreateSchema.safeParse({ fullName: 'Juma', idNumber: 'X123' }).success).toBe(false);
    expect(guestCreateSchema.safeParse({ fullName: 'Juma', idType: 'passport', idNumber: 'X123' }).success).toBe(true);
  });

  it('rejects an invalid email and a too-short phone', () => {
    expect(guestCreateSchema.safeParse({ fullName: 'Juma', email: 'not-an-email' }).success).toBe(false);
    expect(guestCreateSchema.safeParse({ fullName: 'Juma', phone: '123' }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(guestCreateSchema.safeParse({ fullName: '   ' }).success).toBe(false);
  });
});

describe('blacklistGuestSchema', () => {
  it('requires a reason of at least 5 characters', () => {
    expect(blacklistGuestSchema.safeParse({ reason: 'bad' }).success).toBe(false);
    expect(blacklistGuestSchema.safeParse({ reason: 'damaged property' }).success).toBe(true);
  });
});

describe('mergeGuestsSchema', () => {
  it('rejects keepId inside mergeIds', () => {
    const res = mergeGuestsSchema.safeParse({ keepId: KEEP, mergeIds: [KEEP, '22222222-2222-4222-8222-222222222222'] });
    expect(res.success).toBe(false);
  });

  it('requires at least one merge target', () => {
    expect(mergeGuestsSchema.safeParse({ keepId: KEEP, mergeIds: [] }).success).toBe(false);
  });
});

describe('attachDocumentSchema', () => {
  it('accepts a valid attachment', () => {
    const out = attachDocumentSchema.parse({ fileId: KEEP, docType: 'driving_licence' });
    expect(out.docType).toBe('driving_licence');
  });

  it('rejects unknown document types', () => {
    expect(attachDocumentSchema.safeParse({ fileId: KEEP, docType: 'parchment' }).success).toBe(false);
  });
});