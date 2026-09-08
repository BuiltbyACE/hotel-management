/**
 * core/cache/index.ts
 *
 * Cache interface + in-process LRU/TTL implementation. The blueprint
 * deliberately has NO Redis at one property; swapping this for Redis later is a
 * one-file change (§Level-2 bullet 11). Everything else depends on the
 * interface, never the implementation.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number; // 0 = no expiry
}

/**
 * In-process LRU with TTL. O(1) get/set via Map plus recency bookkeeping.
 * Not cross-instance safe — that is exactly why it is behind the interface.
 */
export function lruCache(opts: { maxSize?: number } = {}): Cache {
  const maxSize = opts.maxSize ?? 5000;
  const store = new Map<string, Entry>();

  function isExpired(entry: Entry, now: number): boolean {
    return entry.expiresAt > 0 && entry.expiresAt <= now;
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (isExpired(entry, Date.now())) {
        store.delete(key);
        return undefined;
      }
      store.delete(key);
      store.set(key, entry); // mark most-recently-used
      return entry.value as T;
    },

    async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expiresAt: ttlMs === undefined ? 0 : Date.now() + ttlMs });
      while (store.size > maxSize) {
        const oldest = store.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    async has(key: string): Promise<boolean> {
      const entry = store.get(key);
      if (!entry) return false;
      if (isExpired(entry, Date.now())) {
        store.delete(key);
        return false;
      }
      return true;
    },

    async clear(): Promise<void> {
      store.clear();
    },
  };
}

/** App-wide cache (small, TTL-heavy values only: rate tables, static config). */
export const cache: Cache = lruCache();