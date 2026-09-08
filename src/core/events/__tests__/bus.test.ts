/**
 * Unit test: in-process event bus semantics.
 */
import { describe, expect, it } from 'vitest';
import { createEventBus, eventBus } from '@/core/events';

describe('eventBus', () => {
  it('delivers payloads to matching listeners', async () => {
    const bus = createEventBus();
    const seen: unknown[] = [];
    bus.on('booking.created', (payload) => {
      seen.push(payload);
    });
    bus.on('other', () => {
      seen.push('wrong');
    });

    await bus.emit('booking.created', { reference: 'BK-1' }, 'user-1');
    expect(seen).toEqual([{ reference: 'BK-1' }]);
  });

  it('unsubscribes with the returned teardown', async () => {
    const bus = createEventBus();
    let calls = 0;
    const off = bus.on('e', () => {
      calls += 1;
    });
    await bus.emit('e', null);
    off();
    await bus.emit('e', null);
    expect(calls).toBe(1);
  });

  it('removes single handlers with off() and all with clear()', async () => {
    const bus = createEventBus();
    let calls = 0;
    const handler = () => {
      calls += 1;
    };
    bus.on('e', handler);
    bus.on('e', handler); // duplicate subscribe — each fires independently
    await bus.emit('e', null);
    expect(calls).toBe(2);

    bus.off('e', handler); // removes only the first matching subscription
    await bus.emit('e', null);
    expect(calls).toBe(3);

    bus.clear();
    await bus.emit('e', null);
    expect(calls).toBe(3);
  });

  it('awaits async handlers', async () => {
    const bus = createEventBus();
    let done = false;
    bus.on('e', async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await bus.emit('e', null);
    expect(done).toBe(true);
  });

  it('clear() removes all listeners', async () => {
    const bus = createEventBus();
    let calls = 0;
    bus.on('e', () => {
      calls += 1;
    });
    bus.clear();
    await bus.emit('e', null);
    expect(calls).toBe(0);
  });

  it('singleton emits and can be cleared', async () => {
    let calls = 0;
    const h = () => {
      calls += 1;
    };
    eventBus.on('probe', h);
    await eventBus.emit('probe', {});
    expect(calls).toBe(1);
    eventBus.off('probe', h);
  });
});