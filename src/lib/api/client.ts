/**
 * Thin same-origin fetch wrapper.
 *
 * Decodes RFC 9457 problem+json bodies plus headers the backend guarantees:
 * code/detail/requestId, the X-Request-Id header, and Retry-After (seconds).
 * Non-2xx responses throw ApiError. Login and TOTP-verify call this path so we
 * can read Retry-After exactly; session/sign-out/change-password go through the
 * Better Auth client (same endpoints).
 */
import { ApiError } from './errors';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: Record<string, unknown>;
}

export async function get<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, { ...init, method: 'GET' });
}

export function post<T>(path: string, body: unknown, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    ...init,
    method: 'POST',
    headers: { ...JSON_HEADERS, ...init?.headers },
    body: JSON.stringify(body),
  });
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...init.headers },
    });
  } catch {
    throw new ApiError('Cannot reach the server.', { status: 0 });
  }

  if (!res.ok) {
    const problem = await readProblem(res);
    const headerRequestId = res.headers.get('x-request-id');
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new ApiError(problem.title ?? problem.detail ?? `Request failed (${res.status})`, {
      status: res.status,
      code: problem.code,
      detail: problem.detail,
      requestId: headerRequestId ?? problem.requestId,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    });
  }

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('Malformed response from the server.', { status: res.status });
  }
}

async function readProblem(res: Response): Promise<ProblemDetails> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ProblemDetails;
    return { detail: text };
  } catch {
    return { detail: text.slice(0, 200) };
  }
}