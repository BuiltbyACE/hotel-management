/**
 * src/instrumentation.ts
 *
 * Next.js server bootstrap (nodejs runtime). Runs once per server instance
 * before it serves traffic. This is where the outbox worker is woken and the
 * job handlers are registered — modules never import core/jobs for side
 * effects, only for storage, so a single registration point keeps the worker
 * honest (blueprint §15.2).
 *
 * Tests and the production build skip this file (vitest loads modules
 * directly and deliberately registers its own handlers; `next build` must not
 * start a poll loop).
 */
import { env } from '@/core/config/env';

export async function register() {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.NODE_ENV === 'test') return;

  const { registerExportJobs } = await import('@/modules/reporting/export');
  const { registerRealtimeBridge, registerRealtimeJobs } = await import('@/core/realtime/bridge');
  const { registerEmailJobHandlers } = await import('@/core/jobs/emails');

  registerExportJobs();
  registerRealtimeJobs();
  registerEmailJobHandlers();
  registerRealtimeBridge();

  if (env.JOB_WORKER_ENABLED) {
    const { startWorker } = await import('@/core/jobs');
    startWorker();
  }
}