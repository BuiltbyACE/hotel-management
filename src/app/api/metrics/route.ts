/**
 * GET /api/metrics — Prometheus text exposition (§21). Gauges are refreshed
 * on scrape (queue depth), counters accumulate on the subsystems that own
 * them (see core/metrics.ts). Unauthenticated by design — the cluster
 * scraper reads it.
 */
import { withDb } from '@/core/db';
import { queueDepth } from '@/core/jobs';
import { activeConnections } from '@/core/realtime';
import { metricsText, setGauge } from '@/core/metrics';

export const GET = async () => {
  const depth = await withDb((db) => queueDepth(db));
  setGauge('job_queue_depth', depth);
  setGauge('sse_connections', activeConnections());

  return new Response(metricsText(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
};

export const runtime = 'nodejs';