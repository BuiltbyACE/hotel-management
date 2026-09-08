/**
 * core/events/bus.ts
 *
 * In-process typed event bus. Modules name their own events (see
 * blueprint §15.3 catalogue) and publish payloads. The bus is intentionally
 * generic — modules get type safety from their own `events.ts` wrappers, and
 * cross-module subscribers (audit, housekeeping board) subscribe by string.
 *
 * Events are the "what happened" record. Side effects that must survive a
 * rollback go through the outbox (core/jobs), NOT through this bus.
 */
type Handler = (payload: unknown, meta: { event: string; raisedBy?: string }) => void | Promise<void>;

export interface EventBus {
  on(event: string, handler: Handler): () => void;
  off(event: string, handler: Handler): void;
  emit(event: string, payload: unknown, raisedBy?: string): void | Promise<void>;
  clear(): void;
}

interface Listener {
  event: string;
  handler: Handler;
}

export function createEventBus(): EventBus {
  const listeners: Listener[] = [];

  return {
    on(event, handler) {
      listeners.push({ event, handler });
      return () => this.off(event, handler);
    },

    off(event, handler) {
      const idx = listeners.findIndex((l) => l.event === event && l.handler === handler);
      if (idx >= 0) listeners.splice(idx, 1);
    },

    async emit(event, payload, raisedBy) {
      const target = [...listeners];
      for (const l of target) {
        if (l.event !== event) continue;
        await l.handler(payload, { event, raisedBy });
      }
    },

    clear() {
      listeners.length = 0;
    },
  };
}

/** App-wide singleton. Modules import this from '@/core/events'. */
export const eventBus: EventBus = createEventBus();