/**
 * DedupWindow tests — 24h content-hash LRU.
 *
 * Daemon's defense against duplicate events from overlapping sources and
 * at-least-once-emit semantics from the source supervisor.
 */

import { describe, expect, test } from 'bun:test';
import { DedupWindow } from '../../src/core/ingestion/dedup.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

describe('DedupWindow.mark — basic dedup', () => {
  test('first sight of a key returns true', () => {
    const w = new DedupWindow({ _now: () => 1000 });
    expect(w.mark('file-watcher', HASH_A)).toBe(true);
  });

  test('repeat of the same key within TTL returns false', () => {
    let t = 1000;
    const w = new DedupWindow({ _now: () => t });
    expect(w.mark('file-watcher', HASH_A)).toBe(true);
    t = 2000;
    expect(w.mark('file-watcher', HASH_A)).toBe(false);
  });

  test('same hash from different source kinds are independent keys', () => {
    const w = new DedupWindow({ _now: () => 1000 });
    expect(w.mark('file-watcher', HASH_A)).toBe(true);
    expect(w.mark('inbox-folder', HASH_A)).toBe(true);
    expect(w.mark('file-watcher', HASH_A)).toBe(false);
  });

  test('past-TTL repeat is treated as new', () => {
    let t = 1000;
    const w = new DedupWindow({ ttlMs: 1000, _now: () => t });
    expect(w.mark('x', HASH_A)).toBe(true);
    t = 5000; // far past 1s TTL
    expect(w.mark('x', HASH_A)).toBe(true);
  });

  test('within-TTL hit at boundary still dedups', () => {
    let t = 1000;
    const w = new DedupWindow({ ttlMs: 1000, _now: () => t });
    expect(w.mark('x', HASH_A)).toBe(true);
    t = 1999; // 1ms before TTL expiry
    expect(w.mark('x', HASH_A)).toBe(false);
  });
});

describe('DedupWindow.mark — LRU eviction', () => {
  test('exceeding maxEntries evicts the oldest', () => {
    const w = new DedupWindow({ maxEntries: 3, _now: () => 1000 });
    w.mark('x', HASH_A); // entry 1
    w.mark('x', HASH_B); // entry 2
    w.mark('x', HASH_C); // entry 3 — at capacity
    w.mark('y', HASH_A); // entry 4 — should evict 'x:HASH_A'

    // HASH_A under kind 'x' should now be treated as new because it was
    // evicted, not because TTL expired.
    expect(w.mark('x', HASH_A)).toBe(true);
    expect(w.stats().evictions).toBeGreaterThan(0);
  });

  test('touching an existing key moves it to MRU position', () => {
    const w = new DedupWindow({ maxEntries: 3, _now: () => 1000 });
    w.mark('x', HASH_A); // entry 1 (oldest)
    w.mark('x', HASH_B);
    w.mark('x', HASH_C);

    // Re-touch HASH_A — should move it to MRU.
    expect(w.mark('x', HASH_A)).toBe(false); // dedup hit

    // Now insert a new entry. The eviction should pick HASH_B (now oldest), not HASH_A.
    w.mark('y', HASH_A);
    expect(w.mark('x', HASH_B)).toBe(true); // HASH_B was evicted
    expect(w.mark('x', HASH_A)).toBe(false); // HASH_A still in cache (recently touched)
  });
});

describe('DedupWindow.prune', () => {
  test('removes entries older than TTL', () => {
    let t = 1000;
    const w = new DedupWindow({ ttlMs: 1000, _now: () => t });
    w.mark('x', HASH_A);
    w.mark('x', HASH_B);

    t = 3000; // both entries should be expired
    const removed = w.prune();
    expect(removed).toBe(2);
    expect(w.stats().size).toBe(0);
  });

  test('preserves entries within TTL', () => {
    let t = 1000;
    const w = new DedupWindow({ ttlMs: 1000, _now: () => t });
    w.mark('x', HASH_A); // inserted at t=1000
    t = 1500;
    w.mark('x', HASH_B); // inserted at t=1500
    t = 2200; // HASH_A is past TTL (1200 cutoff), HASH_B still in window

    const removed = w.prune();
    expect(removed).toBe(1);
    expect(w.stats().size).toBe(1);
  });

  test('explicit now parameter overrides clock', () => {
    const w = new DedupWindow({ ttlMs: 1000, _now: () => 1000 });
    w.mark('x', HASH_A);
    expect(w.prune(3000)).toBe(1);
  });
});

describe('DedupWindow.stats', () => {
  test('total counts every mark call', () => {
    const w = new DedupWindow({ _now: () => 1000 });
    w.mark('x', HASH_A);
    w.mark('x', HASH_A);
    w.mark('x', HASH_B);
    expect(w.stats().total).toBe(3);
  });

  test('hits counts dedup hits', () => {
    const w = new DedupWindow({ _now: () => 1000 });
    w.mark('x', HASH_A);
    w.mark('x', HASH_A);
    w.mark('x', HASH_A);
    expect(w.stats().hits).toBe(2);
  });

  test('size tracks live entries', () => {
    const w = new DedupWindow({ _now: () => 1000 });
    expect(w.stats().size).toBe(0);
    w.mark('x', HASH_A);
    expect(w.stats().size).toBe(1);
    w.mark('x', HASH_B);
    expect(w.stats().size).toBe(2);
  });

  test('evictions count LRU evictions, not TTL prunes', () => {
    const w = new DedupWindow({ maxEntries: 2, _now: () => 1000 });
    w.mark('x', HASH_A);
    w.mark('x', HASH_B);
    w.mark('x', HASH_C); // forces eviction of HASH_A
    expect(w.stats().evictions).toBe(1);
  });
});

describe('DedupWindow._resetForTest', () => {
  test('clears all state', () => {
    const w = new DedupWindow({ _now: () => 1000 });
    w.mark('x', HASH_A);
    w.mark('x', HASH_A); // hit
    w._resetForTest();
    expect(w.stats()).toEqual({ total: 0, hits: 0, evictions: 0, size: 0 });
    expect(w.mark('x', HASH_A)).toBe(true);
  });
});
