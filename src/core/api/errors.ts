/**
 * core/api/errors.ts
 *
 * Application error types that map to RFC 9457 problem-details responses.
 * Every error has a code, status, and human-readable detail.
 */
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'DUPLICATE'
  | 'ROOM_UNAVAILABLE'
  | 'OVERLAP'
  | 'INVALID_TRANSITION'
  | 'CONTENTION'
  | 'LOCK_TIMEOUT'
  | 'REFERENCE_INVALID'
  | 'CONSTRAINT_VIOLATION'
  | 'GUEST_BLACKLISTED'
  | 'DEPOSIT_REQUIRED'
  | 'BALANCE_OUTSTANDING'
  | 'INTERNAL_ERROR'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_MISMATCH';

export class AppError {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string;
  readonly errors?: Record<string, string[]>;

  private constructor(
    status: number,
    code: ErrorCode,
    detail: string,
    errors?: Record<string, string[]>,
  ) {
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.errors = errors;
  }

  static unauthorized(detail = 'Authentication required'): AppError {
    return new AppError(401, 'UNAUTHORIZED', detail);
  }

  static forbidden(code: ErrorCode = 'FORBIDDEN', detail = 'Insufficient permissions'): AppError {
    return new AppError(403, code, detail);
  }

  static notFound(detail = 'Resource not found'): AppError {
    return new AppError(404, 'NOT_FOUND', detail);
  }

  static badRequest(code: ErrorCode = 'VALIDATION_ERROR', detail = 'Invalid request'): AppError {
    return new AppError(400, code, detail);
  }

  static validation(errors: Record<string, string[]>): AppError {
    return new AppError(422, 'VALIDATION_ERROR', 'Validation failed', errors);
  }

  static conflict(code: ErrorCode = 'DUPLICATE', detail = 'Conflict'): AppError {
    return new AppError(409, code, detail);
  }

  static retryable(code: ErrorCode = 'CONTENTION', detail = 'Please try again'): AppError {
    return new AppError(409, code, detail);
  }

  static tooMany(detail = 'Rate limit exceeded'): AppError {
    return new AppError(429, 'RATE_LIMITED', detail);
  }

  static internal(cause?: unknown): AppError {
    const detail = cause instanceof Error ? cause.message : 'Internal server error';
    return new AppError(500, 'INTERNAL_ERROR', detail);
  }
}
