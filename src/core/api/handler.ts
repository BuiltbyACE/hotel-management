/**
 * core/api/handler.ts
 *
 * The API handler wrapper.
 * Every route handler is wrapped in apiHandler which provides:
 * - Request ID generation
 * - Structured logging with timing
 * - translateDbError for constraint violations
 * - Problem-details serialisation
 * - Hard 15s timeout
 *
 * Route handlers MUST be under 80 lines (enforced by ESLint).
 * They contain NO business logic — only:
 * 1. Auth + permission check
 * 2. Body/query validation
 * 3. Call service
 * 4. Shape response
 */
import { randomUUID } from 'crypto';
import { AppError } from './errors';
import { translateDbError } from '@/core/db/errors';
import { problemResponse } from './problem';
import { createLogger, type Logger } from '@/core/logger';

export interface HandlerContext {
  requestId: string;
  logger: Logger;
  idempotencyKey?: string;
}

export type HandlerFn = (
  req: Request,
  ctx: HandlerContext,
) => Promise<Response>;

/**
 * What route modules export. Single-param so the result is assignable to
 * Next's RouteHandlerConfig (`(request: NextRequest, context) => Response`);
 * the wrapped fn still receives the enriched HandlerContext internally.
 */
export type ApiHandler = (req: Request) => Promise<Response>;

/**
 * Wrap a route handler with cross-cutting concerns.
 */
export function apiHandler(fn: HandlerFn): ApiHandler {
  return async (req: Request) => {
    const requestId = randomUUID();
    const logger = createLogger(requestId);
    const startTime = Date.now();
    const url = new URL(req.url);

    // Extract idempotency key from header
    const idempotencyKey = req.headers.get('idempotency-key') ?? undefined;

    const ctx: HandlerContext = { requestId, logger, idempotencyKey };

    try {
      const response = await Promise.race([
        fn(req, ctx),
        timeoutPromise(15_000),
      ]);

      const durationMs = Date.now() - startTime;
      logger.info({
        method: req.method,
        path: url.pathname,
        status: response.status,
        durationMs,
      });

      // Ensure X-Request-Id is on every response
      if (response instanceof Response) {
        response.headers.set('X-Request-Id', requestId);
      }

      return response;
    } catch (e) {
      const durationMs = Date.now() - startTime;

      // Translate known errors
      const appError = e instanceof AppError
        ? e
        : translateDbError(e);

      logger.error({
        method: req.method,
        path: url.pathname,
        status: appError.status,
        code: appError.code,
        durationMs,
        err: e instanceof Error ? e : undefined,
      });

      return problemResponse(appError, {
        instance: url.pathname,
        requestId,
      });
    }
  };
}

function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(AppError.internal('Request timed out'));
    }, ms);
  });
}

/**
 * Create a 201 Created response.
 */
export function created(data: unknown, location?: string): Response {
  return Response.json({ data }, {
    status: 201,
    headers: location ? { Location: location } : undefined,
  });
}

/**
 * Create a 200 OK response.
 */
export function ok(data: unknown): Response {
  return Response.json({ data });
}

/**
 * Create a 200 OK response with pagination.
 */
export function okPaginated(data: unknown, pagination: unknown): Response {
  return Response.json({ data, pagination });
}

/**
 * Create a 204 No Content response.
 */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}
