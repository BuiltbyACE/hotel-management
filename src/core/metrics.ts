/**
 * core/metrics.ts
 *
 * Tiny in-process Prometheus registry (blueprint §21). Gauges and counters
 * are set/ bumped by the subsystems that own them (SSE connections, job
 * failures, queue depth) and rendered by GET /api/metrics. No external
 * deps — multi-instance collectors can scrape each pod.
 */
const gauges = new Map<string, number>();
const counters = new Map<string, number>();

const HELP: Record<string, string> = {
  sse_connections: 'Current open SSE connections.',
  job_queue_depth: 'Pending + processing jobs in the queue.',
  job_failures_total: 'Total failed job executions (no handler + handler threw).',
};

/** Every metric the app exposes, declared up front so the text rends zeros. */
const DECLARED: { name: string; type: 'gauge' | 'counter' }[] = [
  { name: 'sse_connections', type: 'gauge' },
  { name: 'job_queue_depth', type: 'gauge' },
  { name: 'job_failures_total', type: 'counter' },
];

export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function bumpCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function counterValue(name: string): number {
  return counters.get(name) ?? 0;
}

/** Render every registered metric in Prometheus text format, sorted by name. */
export function metricsText(): string {
  const values = new Map<string, number>();
  for (const [name, value] of gauges) values.set(name, value);
  for (const [name, value] of counters) values.set(name, value);

  const samples = DECLARED.map((m) => ({
    ...m,
    help: HELP[m.name] ?? m.name,
    value: values.get(m.name) ?? 0,
  })).sort((a, b) => a.name.localeCompare(b.name));

  return (
    samples
      .map(
        (s) =>
          `# HELP ${s.name} ${s.help}\n# TYPE ${s.name} ${s.type}\n${s.name} ${s.value}`,
      )
      .join('\n') + '\n'
  );
}

/** Test hook. */
export function __resetMetrics(): void {
  gauges.clear();
  counters.clear();
}