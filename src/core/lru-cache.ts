/**
 * FIX [8/12] 2026-08-08: Simple LRU cache to reduce PGLite single-connection
 * pressure. Wraps query results, vector similarity results, and page lookups.
 *
 * Thread-safe via Map ordering — each get/set reorders the map so the
 * least-recently-used entry is always at the bottom and evicted first.
 * Default capacity: 100 entries. Override with GBRAIN_LRU_CAPACITY.
 */

const DEFAULT_CAPACITY = 100;

function resolveCapacity(): number {
  const env = process.env.GBRAIN_LRU_CAPACITY;
  if (!env) return DEFAULT_CAPACITY;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CAPACITY;
}

export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity?: number) {
    this.capacity = capacity ?? resolveCapacity();
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    // Move to end (most recently used)
    const val = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Evict least recently used (first key in insertion order).
      // size >= capacity >= 1 guarantees the iterator yields a value, but
      // TS still types firstKey as K | undefined — guard before deleting.
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
