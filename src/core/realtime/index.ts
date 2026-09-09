/**
 * core/realtime/index.ts
 *
 * Thin SSE adapter (blueprint §16 / §17.6). The app holds an in-process
 * registry of EventSource clients and broadcasts typed events — housekeeping
 * board, availability changes after a booking, payment alerts.
 *
 *   - Events carry ONLY { type, entity, id } — never payload data. Clients
 *     invalidate the matching TanStack Query keys and refetch through the
 *     permission-checked API, so the stream can never leak what a permission
 *     check would not show.
 *   - Heartbeat comment every 25 s to defeat proxy timeouts. [ERP-DNA]
 *   - Connection caps: 5 per user, 100 total. [ERP-DNA]
 *
 * Multi-instance scaling is a [P2] concern; this adapter deliberately has no
 * pub/sub backing store. Swap the internals, keep the surface.
 */
import type { ReadableStreamDefaultController } from 'node:stream/web';
import { AppError } from '@/core/api/errors';
import { setGauge } from '@/core/metrics';

export interface SseClient {
  channel: string;
  send(event: string, data: unknown): void;
  close(): void;
}

interface WiredClient {
  channel: string;
  userId: string | null;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

export const SSE_MAX_PER_USER = 5;
export const SSE_MAX_TOTAL = 100;

const HEARTBEAT_MS = 25_000;
const HEARTBEAT_FRAME = ': hms heartbeat\n\n';

const clients = new Map<number, WiredClient>();
const userClients = new Map<string, number>();
let nextId = 0;
let heartbeatMs = HEARTBEAT_MS;

function encode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const encoder = new TextEncoder();

function syncGauge(): void {
  setGauge('sse_connections', clients.size);
}

function release(id: number, userId: string | null): void {
  clients.delete(id);
  if (userId) {
    const n = (userClients.get(userId) ?? 0) - 1;
    if (n <= 0) userClients.delete(userId);
    else userClients.set(userId, n);
  }
  syncGauge();
}

/**
 * Open a client. The route owns the Response lifecycle:
 *
 *   const { body, client } = sseClient(channel);
 *   return new Response(body, {
 *     headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
 *   });
 *
 * Pass the authenticated userId to enforce the per-user connection cap. The
 * total cap applies to every connection regardless of owner.
 */
export function sseClient(
  channel: string,
  opts: { userId?: string } = {},
): { body: ReadableStream<Uint8Array>; client: SseClient } {
  const userId = opts.userId ?? null;

  if (clients.size >= SSE_MAX_TOTAL) {
    throw AppError.tooMany(`SSE connection limit exceeded (${SSE_MAX_TOTAL})`);
  }
  if (userId) {
    const perUser = userClients.get(userId) ?? 0;
    if (perUser >= SSE_MAX_PER_USER) {
      throw AppError.tooMany(`SSE connection limit exceeded (${SSE_MAX_PER_USER} per user)`);
    }
  }

  const id = ++nextId;
  let wired: WiredClient | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      wired = { channel, userId, controller };
      clients.set(id, wired);
      if (userId) userClients.set(userId, (userClients.get(userId) ?? 0) + 1);
      syncGauge();
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      controller.enqueue(encoder.encode(encode('pong', { t: Date.now() })));
      timer = setInterval(() => controller.enqueue(encoder.encode(HEARTBEAT_FRAME)), heartbeatMs);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
      release(id, userId);
    },
  });

  return {
    body,
    client: {
      channel,
      send(event, data) {
        if (wired) wired.controller.enqueue(encoder.encode(encode(event, data)));
      },
      close() {
        if (timer) clearInterval(timer);
        release(id, userId);
        wired = undefined;
        if (!closed) {
          closed = true;
          void body.cancel().catch(() => undefined);
        }
      },
    },
  };
}

/**
 * Broadcast to every client subscribed on a channel.
 */
export function broadcast(channel: string, event: string, data: unknown): void {
  const frame = encoder.encode(encode(event, data));
  for (const c of clients.values()) {
    if (c.channel === channel) c.controller.enqueue(frame);
  }
}

/** For /api/metrics: sse_connections */
export function activeConnections(): number {
  return clients.size;
}

/** Open connections held by one user (§17.6 cap accounting). */
export function activeConnectionsByUser(userId: string): number {
  return userClients.get(userId) ?? 0;
}

/** Test hooks. */
export function __reset(): void {
  clients.clear();
  userClients.clear();
  nextId = 0;
  heartbeatMs = HEARTBEAT_MS;
  syncGauge();
}
export function __setHeartbeatIntervalMs(ms: number): void {
  heartbeatMs = ms;
}