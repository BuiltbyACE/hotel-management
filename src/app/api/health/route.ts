/**
 * GET /api/health — liveness probe (§21). No dependencies: a 200 means the
 * process scheduler is alive and the route layer is responding.
 */
export const GET = () =>
  Response.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  });

export const runtime = 'nodejs';