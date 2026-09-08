/**
 * core/realtime/index.ts
 *
 * Thin SSE adapter (blueprint §16 / metrics `sse_connections`). The app holds
 * an in-process registry of EventSource clients and broadcasts typed events —
 * housekeeping board, availability changes after a booking, payment alerts.
 *
 * Multi-instance scaling is a [P2] concern; this adapter deliberately has no
 * pub/sub backing store. Swap the internals, keep the surface.
 */
import type { ReadableStreamDefaultController } from 'node:stream/web';

export interface SseClient {
  channel: string;
  send(event: string, data: unknown): void;
  close(): void;
}

interface WiredClient {
  channel: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

const clients = new Map<number, WiredClient>();
let nextId = 0;

function encode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const encoder = new TextEncoder();

/**
 * Open a client. The route owns the Response lifecycle:
 *
 *   const { body, client } = sseClient(channel);
 *   return new Response(body, {
 *     headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
 *   });
 */
export function sseClient(channel: string): { body: ReadableStream<Uint8Array>; client: SseClient } {
  const id = ++nextId;
  let wired: WiredClient | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      wired = { channel, controller };
      clients.set(id, wired);
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      controller.enqueue(encoder.encode(encode('pong', { t: Date.now() })));
    },
    cancel() {
      clients.delete(id);
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
        clients.delete(id);
        wired = undefined;
        try {
          void body.cancel();
        } catch {
          /* already closed */
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

/** Test hook. */
export function __reset(): void {
  clients.clear();
  nextId = 0;
}