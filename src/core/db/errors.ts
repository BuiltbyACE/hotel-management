/**
 * core/db/errors.ts
 *
 * Postgres error code translation.
 * Constraint violations are the DESIGN, so they must surface as clean API errors,
 * never 500s. The 23P01 (exclusion violation) → ROOM_UNAVAILABLE mapping is the
 * single most important translation in the system.
 */
import { AppError } from '@/core/api/errors';

export const PG = {
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
  FK_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  SERIALIZATION: '40001',
  DEADLOCK: '40P01',
  LOCK_TIMEOUT: '55P03',
} as const;

function isPgError(e: unknown): e is { code: string; constraint?: string; detail?: string; table?: string } {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as Record<string, unknown>).code === 'string';
}

const uniqueMessages: Record<string, AppError> = {};

/**
 * Drizzle wraps driver errors in DrizzleQueryError (`.message` = "Failed query:
 * ..."), preserving the Postgres error on `.cause`. Unwrap the chain so the SQL
 * error code and constraint name surface for translation.
 */
function unwrap(e: unknown): unknown {
  let err = e;
  while (err instanceof Error && err.cause) {
    err = err.cause;
  }
  return err;
}

export function translateDbError(e: unknown): AppError {
  const cause = unwrap(e);
  if (!isPgError(cause)) return AppError.internal(e);

  switch (cause.code) {
    case PG.EXCLUSION_VIOLATION:
      if (cause.constraint === 'room_allocations_no_overlap') {
        return AppError.conflict(
          'ROOM_UNAVAILABLE',
          'That room was just taken for one or more of those nights.',
        );
      }
      return AppError.conflict('OVERLAP', 'Conflicting record.');

    case PG.UNIQUE_VIOLATION:
      return uniqueMessages[cause.constraint ?? ''] ?? AppError.conflict('DUPLICATE', 'Record already exists.');

    case PG.FK_VIOLATION:
      return AppError.badRequest('REFERENCE_INVALID', 'Referenced record does not exist.');

    case PG.CHECK_VIOLATION:
      return AppError.badRequest('CONSTRAINT_VIOLATION', 'Data violates a constraint.');

    case PG.SERIALIZATION:
    case PG.DEADLOCK:
      return AppError.retryable('CONTENTION', 'Please try again.');

    case PG.LOCK_TIMEOUT:
      return AppError.retryable('LOCK_TIMEOUT', 'System busy. Please try again.');

    default:
      return AppError.internal(e);
  }
}
