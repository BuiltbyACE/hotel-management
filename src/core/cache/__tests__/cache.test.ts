/**
 * Unit test: in-process LRU cache with TTL.
 */
import { describe, expect, it } from 'vitest';
import { lruCache } from '@/core/cache';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('lruCache', () => {
  it('stores and returns values', async () => {
    const c = lruCache();
    await c.set('k', { n: 1 });
    expect(await c.get('k')).toEqual({ n: 1 });
    expect(await c.has('k')).toBe(true);
  });

  it('expires entries after ttl', async () => {
    const c = lruCache();
    await c.set('k', 1, 30);
    expect(await c.get('k')).toBe(1);
    await tick(50);
    expect(await c.get('k')).toBeUndefined();
    expect(await c.has('k')).toBe(false);
  });

  it('delete removes and clear empties the store', async () => {
    const c = lruCache();
    await c.set('a', 1);
    await c.set('b', 2);
    await c.delete('a');
    expect(await c.get('a')).toBeUndefined();
    expect(await c.get('b')).toBe(2);
    await c.clear();
    expect(await c.get('b')).toBeUndefined();
  });

  it('evicts least-recently-used beyond maxSize', async () => {
    const c = lruCache({ maxSize: 2 });
    await c.set('a', 1);
    await c.set('b', 2);
    await c.get('a'); // touch a → most recent
    await c.set('c', 3); // evicts b
    expect(await c.get('b')).toBeUndefined();
    expect(await c.get('a')).toBe(1);
    expect(await c.get('c')).toBe(3);
  });

  it('re-setting a key refreshes recency and value', async () => {
    const c = lruCache({ maxSize: 2 });
    await c.set('a', 1);
    await c.set('b', 2);
    await c.set('a', 10); // move a to MRU with new value
    await c.set('c', 3); // evicts b
    expect(await c.get('a')).toBe(10);
    expect(await c.get('b')).toBeUndefined();
  });
});