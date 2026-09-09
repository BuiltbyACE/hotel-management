/**
 * GET /api/v1/events (EventSource, session-cookie auth) — §17.6
 * Opens an authenticated SSE stream on the caller's per-property channel.
 * The hub broadcasts ONLY { type, entity, id }, so clients refetch through
 * the permission-checked API. Heartbeat every 25 s; caps 5/user, 100 total.
 */
import { apiHandler } from '@/core/api';
import { requireActor } from '@/modules/identity/auth-guard';
import { sseClient } from '@/core/realtime';

export const GET = apiHandler(async (req) => {
  const actor = await requireActor(req);

  const channel = `property:${actor.propertyId ?? 'system'}`;
  const { body, client } = sseClient(channel, { userId: actor.id });
  req.signal.addEventListener('abort', () => client.close());

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

export const runtime = 'nodejs';