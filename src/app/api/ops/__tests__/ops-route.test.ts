/**
 * Route smoke tests for the ops endpoints (§21): health, ready, metrics.
 * Route handlers run in-process against the real test DB.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { GET as health } from '@/app/api/health/route';
import { GET as ready } from '@/app/api/ready/route';
import { GET as metrics } from '@/app/api/metrics/route';
import { __resetMetrics } from '@/core/metrics';

describe('GET /api/health', () => {
  it('reports ok without touching the DB', async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });
});

describe('GET /api/ready', () => {
  it('reports ok when the DB and schema objects are present', async () => {
    const res = await ready();
    const body = (await res.json()) as { status: string; db: string; schema: string };
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'ok', db: 'ok', schema: 'applied' });
  });
});

describe('GET /api/metrics', () => {
  beforeEach(() => __resetMetrics());

  it('exposes Prometheus text with the required gauges', async () => {
    const res = await metrics();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const text = await res.text();
    expect(text).toContain('# TYPE sse_connections gauge');
    expect(text).toContain('# TYPE job_queue_depth gauge');
    expect(text).toContain('# TYPE job_failures_total counter');
    expect(text).toMatch(/^sse_connections \d+$/m);
    expect(text).toMatch(/^job_queue_depth \d+$/m);
    expect(text).toMatch(/^job_failures_total \d+$/m);
  });
});