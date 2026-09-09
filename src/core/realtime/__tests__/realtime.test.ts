/**
 * Unit tests for the SSE hub adapter + the event-bus bridge (§17.6).
 * Pure core — no DB. The heartbeat is shortened via the test hook so the
 * proxy-timeout comment can be observed without waiting 25 s.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@/core/api/errors';
import { eventBus } from '@/core/events';
import {
  __reset,
  __setHeartbeatIntervalMs,
  activeConnections,
  activeConnectionsByUser,
  broadcast,
  sseClient,
  SSE_MAX_PER_USER,
  SSE_MAX_TOTAL,
  type SseClient,
} from '../index';
import { registerRealtimeBridge } from '../bridge';

function decoder() {
  return new TextDecoder();
}

async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 500,
): Promise<string> {
  const read = reader.read();
  const chime = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timed out waiting for SSE frame')), timeoutMs),
  );
  const { value } = (await Promise.race([read, chime])) as { value: Uint8Array };
  return decoder().decode(value);
}

const open = (channel: string, userId?: string) =>
  sseClient(channel, userId ? { userId } : {});
const wrap = (o: { client: SseClient }) => o.client;
/** Drain the two handshake frames (retry + pong) from a fresh stream. */
async function handshake(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  await readFrame(reader);
  await readFrame(reader);
}

describe('SSE adapter (§17.6)', () => {
  let streams: { close: () => void }[] = [];

  beforeEach(() => {
    __reset();
    streams = [];
  });

  afterEach(() => {
    for (const s of streams) s.close();
    __reset();
  });

  it('sends retry + pong then a heartbeat frame while open', async () => {
    __setHeartbeatIntervalMs(20);
    const { body, client } = open('property:p1', 'u1');
    streams.push({ close: () => client.close() });
    const reader = body.getReader();

    expect(await readFrame(reader)).toBe('retry: 3000\n\n');
    expect(await readFrame(reader)).toContain('event: pong');
    expect(await readFrame(reader, 1000)).toBe(': hms heartbeat\n\n');
    expect(activeConnections()).toBe(1);
    await reader.cancel();
  });

  it('broadcasts only to the matching channel', async () => {
    const a = open('property:p1', 'u1');
    const b = open('property:p2', 'u2');
    streams.push(wrap(a), wrap(b));
    const ra = a.body.getReader();
    const rb = b.body.getReader();

    await handshake(ra);
    await handshake(rb);

    broadcast('property:p1', 'booking.confirmed', { type: 'booking.confirmed', entity: 'booking', id: 'b1' });
    expect(await readFrame(ra)).toBe(
      'event: booking.confirmed\ndata: {"type":"booking.confirmed","entity":"booking","id":"b1"}\n\n',
    );
    await expect(readFrame(rb, 150)).rejects.toThrow('timed out waiting for SSE frame');
    await ra.cancel();
    await rb.cancel();
    a.client.close();
    b.client.close();
  });

  it(`enforces the ${SSE_MAX_PER_USER}-per-user cap`, () => {
    for (let i = 0; i < SSE_MAX_PER_USER; i++) {
      streams.push(wrap(open('property:p1', 'u1')));
    }
    expect(activeConnectionsByUser('u1')).toBe(SSE_MAX_PER_USER);
    expect(() => open('property:p1', 'u1')).toThrow(AppError);
  });

  it(`enforces the ${SSE_MAX_TOTAL} total cap regardless of user`, () => {
    for (let i = 0; i < SSE_MAX_TOTAL; i++) {
      streams.push(wrap(open('property:p1', `many-${i}`)));
    }
    expect(activeConnections()).toBe(SSE_MAX_TOTAL);
    expect(() => open('property:p1')).toThrow(AppError);
  });

  it('close() releases the slot and the gauge resets on __reset', () => {
    const first = open('property:p1', 'u1');
    streams.push(wrap(first));
    first.client.close();
    expect(activeConnections()).toBe(0);
    expect(activeConnectionsByUser('u1')).toBe(0);
  });
});

describe('realtime bridge (§17.6)', () => {
  afterEach(() => __reset());

  it('mirrors booking.created onto the property channel as booking.confirmed', async () => {
    const off = registerRealtimeBridge();
    const { body, client } = open('property:prop-1', 'u1');
    const reader = body.getReader();

    await readFrame(reader);
    await readFrame(reader);

    await eventBus.emit('booking.created', { bookingId: 'B-42', propertyId: 'prop-1' });
    expect(await readFrame(reader)).toBe(
      'event: booking.confirmed\ndata: {"type":"booking.confirmed","entity":"booking","id":"B-42"}\n\n',
    );

    await reader.cancel();
    client.close();
    off();
  });

  it('does not leak events to other properties', async () => {
    const off = registerRealtimeBridge();
    const { body, client } = open('property:prop-2', 'u1');
    const reader = body.getReader();

    await readFrame(reader);
    await readFrame(reader);

    await eventBus.emit('booking.checked_in', { bookingId: 'B-7', propertyId: 'prop-9' });
    await expect(readFrame(reader, 150)).rejects.toThrow('timed out waiting for SSE frame');

    await reader.cancel();
    client.close();
    off();
  });
});