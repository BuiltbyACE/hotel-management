/**
 * core/api/problem.ts
 *
 * RFC 9457 problem-details response serialiser.
 * All errors are returned in this format, never bare { error: "..." }.
 */
import { AppError } from './errors';

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance?: string;
  requestId?: string;
  errors?: Record<string, string[]>;
}

/**
 * Serialise an AppError into an RFC 9457 problem-details response.
 */
export function problemResponse(
  error: AppError,
  opts: {
    instance?: string;
    requestId?: string;
  } = {},
): Response {
  const problem: ProblemDetail = {
    type: `https://hms.local/errors/${error.code.toLowerCase().replace(/_/g, '-')}`,
    title: error.code.replace(/_/g, ' '),
    status: error.status,
    code: error.code,
    detail: error.detail,
    ...(opts.instance && { instance: opts.instance }),
    ...(opts.requestId && { requestId: opts.requestId }),
    ...(error.errors && { errors: error.errors }),
  };

  return Response.json(problem, {
    status: error.status,
    headers: {
      'Content-Type': 'application/problem+json',
      ...(opts.requestId && { 'X-Request-Id': opts.requestId }),
    },
  });
}
