/**
 * Tests for src/core/parallel.ts (v0.40 Federated Sync v2).
 *
 * Pins: result order matches input order, one rejection doesn't kill others,
 * concurrency cap is a hard ceiling, empty input returns empty, invalid
 * concurrency throws TypeError.
 */
import { describe, test, expect } from 'bun:test';
import { pMapAllSettled } from '../src/core/parallel.ts';

describe('pMapAllSettled', () => {
  test('returns results in input order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await pMapAllSettled(items, 2, async (n) => n * 10);
    expect(results).toHaveLength(5);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([10, 20, 30, 40, 50]);
  });

  test('one rejection does not kill other items', async () => {
    const items = ['a', 'b', 'c'];
    const results = await pMapAllSettled(items, 2, async (s) => {
      if (s === 'b') throw new Error('intentional');
      return s.toUpperCase();
    });
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'A' });
    expect(results[1].status).toBe('rejected');
    expect(results[1].status === 'rejected' && (results[1].reason as Error).message).toBe('intentional');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'C' });
  });

  test('hard ceiling: never exceeds concurrency in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await pMapAllSettled(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 'ok';
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  test('empty input returns empty array', async () => {
    const results = await pMapAllSettled([], 5, async () => 'x');
    expect(results).toEqual([]);
  });

  test('concurrency > items.length runs all in parallel (no semaphore stall)', async () => {
    // Every task waits at a barrier that opens only once all of them have
    // started, so a stalled semaphore never opens it. The timeout is a hang
    // guard, not the pass condition.
    const items = [1, 2, 3];
    let inFlight = 0;
    let peak = 0;
    let open!: () => void;
    const barrier = new Promise<void>((resolve) => { open = resolve; });
    let guard: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error(`semaphore stall: ${inFlight} of ${items.length} tasks started`)), 5_000);
    });
    try {
      const results = await Promise.race([
        pMapAllSettled(items, 100, async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          if (inFlight === items.length) open();
          await barrier;
          inFlight--;
          return 'ok';
        }),
        stalled,
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    } finally {
      clearTimeout(guard);
    }
    expect(peak).toBe(items.length);
  });

  test('throws TypeError on concurrency < 1', async () => {
    await expect(pMapAllSettled([1], 0, async (x) => x)).rejects.toThrow(TypeError);
    await expect(pMapAllSettled([1], -3, async (x) => x)).rejects.toThrow(TypeError);
  });

  test('throws TypeError on non-integer concurrency', async () => {
    await expect(pMapAllSettled([1], 1.5, async (x) => x)).rejects.toThrow(TypeError);
    await expect(pMapAllSettled([1], NaN, async (x) => x)).rejects.toThrow(TypeError);
  });

  test('passes index to fn', async () => {
    const seen: Array<[string, number]> = [];
    await pMapAllSettled(['a', 'b', 'c'], 2, async (item, i) => {
      seen.push([item, i]);
      return item;
    });
    // Sort by item since execution order isn't guaranteed.
    seen.sort((a, b) => a[0].localeCompare(b[0]));
    expect(seen).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  });
});
