/**
 * core/realtime/bridge.ts
 *
 * Connects the in-process event bus and the outbox to the SSE hub
 * (blueprint §17.6, "we connect them" [ERP-FIX]).
 *
 *  - The event-bus bridge mirrors the domain events that drive the front desk
 *    (booking confirmed / check-in / check-out, night audit done) onto the
 *    per-property SSE channel. Broadcasts carry ONLY { type, entity, id } —
 *    never payload data — so the stream can't leak what a permission check
 *    would not show; clients refetch through the normal API.
 *  - The outbox handler executes the pre-enqueued realtime.broadcast jobs
 *    (availability refresh) that modules write next to their other side
 *    effects, so the worker owns the delivery latency.
 */
import { eventBus } from '@/core/events';
import { registerHandler } from '@/core/jobs';
import { broadcast } from './index';

interface BridgeSpec {
  type: string;
  entity: string;
  idKey: string;
}

const BRIDGE: Record<string, BridgeSpec> = {
  'booking.created': { type: 'booking.confirmed', entity: 'booking', idKey: 'bookingId' },
  'booking.checked_in': { type: 'booking.checked_in', entity: 'booking', idKey: 'bookingId' },
  'booking.checked_out': { type: 'booking.checked_out', entity: 'booking', idKey: 'bookingId' },
  'frontdesk.night_audit_completed': { type: 'frontdesk.night_audit_completed', entity: 'property', idKey: 'propertyId' },
};

/**
 * Mirror selected domain events onto the SSE hub. Returns an unsubscribe fn
 * (used by the bus tests; instrumentation keeps the subscription for the app
 * lifetime).
 */
export function registerRealtimeBridge(): () => void {
  const offs = Object.entries(BRIDGE).map(([event, spec]) =>
    eventBus.on(event, (payload) => {
      const row = (payload ?? {}) as Record<string, unknown>;
      const id = row[spec.idKey];
      const propertyId = row.propertyId;
      if (typeof id !== 'string' || typeof propertyId !== 'string') return;
      broadcast(`property:${propertyId}`, spec.type, { type: spec.type, entity: spec.entity, id });
    }),
  );
  return () => offs.forEach((off) => off());
}

/**
 * Execute the `realtime.broadcast` outbox jobs modules enqueue (e.g. the
 * availability refresh written next to booking creation).
 */
export function registerRealtimeJobs(): void {
  registerHandler('realtime.broadcast', async (payload) => {
    const channel = payload.channel;
    const bookingId = payload.bookingId;
    if (typeof channel !== 'string' || typeof bookingId !== 'string' || !channel || !bookingId) return;
    broadcast(channel, 'availability.updated', { type: 'availability.updated', entity: 'booking', id: bookingId });
  });
}