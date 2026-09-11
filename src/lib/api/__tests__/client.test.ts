import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { get, post, request } from '@/lib/api/client';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('parses 2xx JSON bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    await expect(get<{ ok: boolean }>('/x')).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith('/x', expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
  });

  it('sends JSON bodies on POST with the JSON content-type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ saved: true })));
    await post<{ saved: boolean }>('/y', { a: 1 });
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[1]?.method).toBe('POST');
    expect(call[1]?.body).toBe(JSON.stringify({ a: 1 }));
    expect(call[1]?.headers).toMatchObject({ 'content-type': 'application/json', accept: 'application/json' });
  });

  it('maps a problem+json response to an ApiError with code/detail/requestId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { code: 'RATE_LIMITED', title: 'Too many attempts', detail: 'Try later', requestId: 'r-42' },
          429,
          { 'content-type': 'application/problem+json' },
        ),
      ),
    );
    await expect(post('/login', {})).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      code: 'RATE_LIMITED',
      detail: 'Try later',
      requestId: 'r-42',
    });
  });

  it('reads Retry-After seconds from the response header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'RATE_LIMITED', title: 'nope' }, 429, { 'retry-after': '37' })));
    try {
      await post('/login', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).retryAfterSeconds).toBe(37);
    }
  });

  it('prefers the X-Request-Id header over the body instance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 'X', title: 'oops', requestId: 'body-id' }, 500, { 'x-request-id': 'hdr-id' })),
    );
    try {
      await request('/z');
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).requestId).toBe('hdr-id');
    }
  });

  it('turns transport failures into a status-0 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    try {
      await get('/x');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(0);
    }
  });

  it('handles empty 204-ish bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    await expect(get<undefined>('/void')).resolves.toBeUndefined();
  });
});