/**
 * Hermetic unit tests for src/core/worker-pool.ts (v0.41.15.0).
 *
 * Pins every contract from D1, D5, D7, D11/D12 (signal composition),
 * D13 (BudgetExhausted bypass). No DB, no API keys, no filesystem.
 *
 * Test-isolation note: this file follows the R1+R2 rules from
 * scripts/check-test-isolation.sh — no process.env mutation, no
 * mock.module. Lives in the parallel fast loop.
 */

import { describe, test, expect } from 'bun:test';
import {
  runSlidingPool,
  runWithLimit,
  isMustAbortError,
  MUST_ABORT_ERROR_TAGS,
  type PoolFailure,
  type SettledItem,
} from '../src/core/worker-pool.ts';

describe('runSlidingPool — basic shape', () => {
  test('empty items returns zeroed result without invoking onItem', async () => {
    let calls = 0;
    const r = await runSlidingPool({
      items: [],
      workers: 4,
      onItem: async () => {
        calls++;
      },
    });
    expect(r.processed).toBe(0);
    expect(r.errored).toBe(0);
    expect(r.aborted).toBe(false);
    expect(r.failures).toEqual([]);
    expect(calls).toBe(0);
  });

  test('N=1 processes items sequentially in order', async () => {
    const order: number[] = [];
    const r = await runSlidingPool({
      items: [1, 2, 3, 4, 5],
      workers: 1,
      onItem: async (item) => {
        order.push(item);
      },
    });
    expect(r.processed).toBe(5);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  test('N>items clamps to items count (no extra workers spawned)', async () => {
    const workerSlots = new Set<number>();
    const r = await runSlidingPool({
      items: [1, 2, 3],
      workers: 100,
      onItem: async (_item, _idx, workerIdx) => {
        workerSlots.add(workerIdx);
      },
    });
    expect(r.processed).toBe(3);
    // At most 3 workers should ever have been spawned; workerIdx is 0..N-1.
    for (const slot of workerSlots) {
      expect(slot).toBeLessThan(3);
    }
  });

  test('every item is claimed exactly once under N concurrent workers', async () => {
    const seen = new Map<number, number>(); // item -> claim count
    const items = Array.from({ length: 200 }, (_, i) => i);
    await runSlidingPool({
      items,
      workers: 16,
      onItem: async (item) => {
        seen.set(item, (seen.get(item) ?? 0) + 1);
        // Force interleaving via micro-yields.
        await Promise.resolve();
        await Promise.resolve();
      },
    });
    expect(seen.size).toBe(200);
    for (const [, count] of seen) expect(count).toBe(1);
  });
});

describe('runSlidingPool — atomic claim invariant (D5)', () => {
  test('200 items × 32 workers: every idx visited exactly once', async () => {
    // The atomicity invariant — `const idx = nextIdx++` is a single
    // synchronous statement — means no two workers ever read the same idx.
    // We assert this directly: build a counter of every idx the pool dispatched
    // and confirm every entry is 1.
    const idxCounts = new Map<number, number>();
    const items = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    await runSlidingPool({
      items,
      workers: 32,
      onItem: async (_item, idx) => {
        idxCounts.set(idx, (idxCounts.get(idx) ?? 0) + 1);
        await new Promise((res) => setTimeout(res, Math.random() * 2));
      },
    });
    expect(idxCounts.size).toBe(200);
    for (let i = 0; i < 200; i++) expect(idxCounts.get(i)).toBe(1);
  });
});

describe('runSlidingPool — abort semantics (D11/D12 signal composition)', () => {
  test('signal aborted before pool starts → returns immediately, no items claimed', async () => {
    const ctl = new AbortController();
    ctl.abort();
    let calls = 0;
    const r = await runSlidingPool({
      items: [1, 2, 3, 4, 5],
      workers: 2,
      signal: ctl.signal,
      onItem: async () => {
        calls++;
      },
    });
    expect(calls).toBe(0);
    expect(r.processed).toBe(0);
    expect(r.aborted).toBe(true);
  });

  test('signal aborted mid-pool → in-flight items finish, new claims stop', async () => {
    const ctl = new AbortController();
    const items = Array.from({ length: 50 }, (_, i) => i);
    let processed = 0;
    const r = await runSlidingPool({
      items,
      workers: 4,
      signal: ctl.signal,
      onItem: async () => {
        // Yield once so the abort can land between claims.
        await new Promise((res) => setTimeout(res, 1));
        processed++;
        if (processed === 4) ctl.abort();
      },
    });
    // After abort, at most the 4 in-flight finish plus a few that already
    // claimed before the signal flag-flip. The remaining never run.
    expect(r.processed).toBeLessThan(50);
    expect(r.aborted).toBe(true);
  });

  test('signal removeEventListener called on completion (no leak)', async () => {
    // Defensive: the helper attaches an abort listener for D13's local-abort
    // composition. It must remove it on completion. Smoke-test by running
    // many pools against one signal and asserting the signal still works
    // for subsequent abort propagation.
    const ctl = new AbortController();
    for (let i = 0; i < 50; i++) {
      await runSlidingPool({
        items: [1, 2, 3],
        workers: 2,
        signal: ctl.signal,
        onItem: async () => {},
      });
    }
    // If listeners leaked, addEventListener would have grown unbounded.
    // We can't directly count them, but we can confirm the signal still
    // composes correctly: trigger abort and verify a new pool short-circuits.
    ctl.abort();
    let calls = 0;
    const r = await runSlidingPool({
      items: [1, 2, 3],
      workers: 2,
      signal: ctl.signal,
      onItem: async () => {
        calls++;
      },
    });
    expect(calls).toBe(0);
    expect(r.aborted).toBe(true);
  });
});

describe('runSlidingPool — onProgress callback', () => {
  test('fires exactly `processed` times in monotonically increasing order', async () => {
    const dones: number[] = [];
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runSlidingPool({
      items,
      workers: 4,
      onItem: async () => {
        await new Promise((res) => setTimeout(res, Math.random() * 2));
      },
      onProgress: (done, total) => {
        dones.push(done);
        expect(total).toBe(20);
      },
    });
    expect(dones.length).toBe(20);
    // done counter is monotonic even though item ORDER isn't.
    for (let i = 1; i < dones.length; i++) {
      expect(dones[i]).toBeGreaterThanOrEqual(dones[i - 1]);
    }
    expect(dones[dones.length - 1]).toBe(20);
  });

  test('onProgress NOT fired for errored items (only successful processed)', async () => {
    let progressCalls = 0;
    const r = await runSlidingPool({
      items: [1, 2, 3, 4, 5],
      workers: 1,
      onItem: async (item) => {
        if (item === 3) throw new Error('boom');
      },
      onProgress: () => {
        progressCalls++;
      },
    });
    expect(r.processed).toBe(4);
    expect(r.errored).toBe(1);
    expect(progressCalls).toBe(4);
  });
});

describe('runSlidingPool — onError semantics (D7)', () => {
  test("default 'continue' policy captures all failures", async () => {
    const r = await runSlidingPool({
      items: [1, 2, 3, 4, 5],
      workers: 1,
      onItem: async (item) => {
        if (item % 2 === 0) throw new Error(`fail-${item}`);
      },
    });
    expect(r.processed).toBe(3);
    expect(r.errored).toBe(2);
    expect(r.aborted).toBe(false);
    expect(r.failures.map((f) => f.idx).sort()).toEqual([1, 3]); // idx of items 2 and 4
    expect((r.failures[0].error as Error).message).toMatch(/^fail-/);
  });

  test("explicit 'abort' policy stops pool on first error", async () => {
    let calls = 0;
    const r = await runSlidingPool({
      items: [1, 2, 3, 4, 5],
      workers: 1,
      onError: 'abort',
      onItem: async (item) => {
        calls++;
        if (item === 2) throw new Error('boom');
      },
    });
    expect(calls).toBeLessThanOrEqual(2);
    expect(r.aborted).toBe(true);
    expect(r.errored).toBe(1);
  });

  test("onError function can decide per-error", async () => {
    const r = await runSlidingPool({
      items: [1, 2, 3, 4, 5],
      workers: 1,
      onError: (err) => {
        return (err as Error).message.includes('fatal') ? 'abort' : 'continue';
      },
      onItem: async (item) => {
        if (item === 2) throw new Error('soft');
        if (item === 4) throw new Error('fatal');
      },
    });
    expect(r.aborted).toBe(true);
    // Items 1 + 2 (soft) + 3 + 4 (fatal-aborts) processed; 5 not claimed.
    expect(r.errored).toBe(2);
    expect(r.processed).toBe(2); // items 1 and 3
  });
});

describe('runSlidingPool — failures[] shape (codex #10)', () => {
  test('failures store idx + label, NOT full item', async () => {
    interface Page {
      slug: string;
      bigBuffer: number[];
    }
    const items: Page[] = Array.from({ length: 5 }, (_, i) => ({
      slug: `page-${i}`,
      bigBuffer: new Array(10_000).fill(i),
    }));
    const r = await runSlidingPool({
      items,
      workers: 1,
      failureLabel: (p) => p.slug,
      onItem: async () => {
        throw new Error('boom');
      },
    });
    expect(r.failures.length).toBe(5);
    for (const f of r.failures) {
      expect(typeof f.label).toBe('string');
      expect(f.label).toMatch(/^page-/);
      expect(typeof f.idx).toBe('number');
      // No `item` field on PoolFailure — codex #10 explicit shape.
      // (TypeScript would already reject `f.item`; runtime check defensive.)
      expect((f as PoolFailure & { item?: unknown }).item).toBeUndefined();
    }
  });

  test('default failureLabel uses String(item)', async () => {
    const r = await runSlidingPool({
      items: ['a', 'b', 'c'],
      workers: 1,
      onItem: async () => {
        throw new Error('boom');
      },
    });
    expect(r.failures.map((f) => f.label)).toEqual(['a', 'b', 'c']);
  });
});

describe('runSlidingPool — BudgetExhausted bypass (D13)', () => {
  test('BudgetExhausted-tagged error aborts pool regardless of onError continue', async () => {
    // Synthetic BudgetExhausted shape — tag-only match, no class import needed.
    class FakeBudgetExhausted extends Error {
      readonly tag = 'BUDGET_EXHAUSTED' as const;
      constructor() {
        super('cap exhausted');
        this.name = 'BudgetExhausted';
      }
    }
    let calls = 0;
    let threw = false;
    try {
      await runSlidingPool({
        items: [1, 2, 3, 4, 5],
        workers: 1,
        onError: 'continue', // would normally swallow
        onItem: async (item) => {
          calls++;
          if (item === 2) throw new FakeBudgetExhausted();
        },
      });
    } catch (e) {
      threw = true;
      expect((e as FakeBudgetExhausted).tag).toBe('BUDGET_EXHAUSTED');
    }
    expect(threw).toBe(true);
    expect(calls).toBeLessThanOrEqual(2);
  });

  test('BudgetExhausted from one worker propagates abort to in-flight peers via signal', async () => {
    class FakeBudgetExhausted extends Error {
      readonly tag = 'BUDGET_EXHAUSTED' as const;
    }
    let aborted = 0;
    let total = 0;
    let threw = false;
    try {
      await runSlidingPool({
        items: Array.from({ length: 100 }, (_, i) => i),
        workers: 8,
        onItem: async (item, _idx, _w) => {
          total++;
          if (item === 5) throw new FakeBudgetExhausted();
          // Long-running work that checks abort via micro-yield.
          for (let i = 0; i < 50; i++) {
            await new Promise((res) => setImmediate(res));
          }
        },
      });
    } catch (e) {
      threw = true;
      expect((e as FakeBudgetExhausted).tag).toBe('BUDGET_EXHAUSTED');
    }
    expect(threw).toBe(true);
    expect(total).toBeLessThan(100);
    // Use `aborted` to suppress unused-var lint while keeping it as a
    // probe value future test extensions can wire to a counter.
    expect(aborted).toBe(0);
  });

  test('isMustAbortError + MUST_ABORT_ERROR_TAGS exposed and stable', () => {
    expect(MUST_ABORT_ERROR_TAGS.has('BUDGET_EXHAUSTED')).toBe(true);
    expect(isMustAbortError({ tag: 'BUDGET_EXHAUSTED' })).toBe(true);
    expect(isMustAbortError({ tag: 'something-else' })).toBe(false);
    expect(isMustAbortError(new Error('plain'))).toBe(false);
    expect(isMustAbortError(null)).toBe(false);
    expect(isMustAbortError(undefined)).toBe(false);
    expect(isMustAbortError('string')).toBe(false);
  });
});

describe('runWithLimit — bounded semaphore', () => {
  test('empty input returns empty array', async () => {
    const out = await runWithLimit({
      items: [],
      limit: 4,
      fn: async () => 'never',
    });
    expect(out).toEqual([]);
  });

  test('preserves per-item ordering in returned array regardless of completion order', async () => {
    const out = await runWithLimit({
      items: [10, 5, 20, 1, 100, 2],
      limit: 4,
      fn: async (item) => {
        await new Promise((res) => setTimeout(res, item % 10));
        return item * 2;
      },
    });
    expect(out.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(out[i].ok).toBe(true);
      expect(out[i].idx).toBe(i);
      if (out[i].ok) {
        expect((out[i] as Extract<SettledItem<number>, { ok: true }>).value).toBe(
          [10, 5, 20, 1, 100, 2][i] * 2,
        );
      }
    }
  });

  test('captures per-item errors without throwing', async () => {
    const out = await runWithLimit({
      items: [1, 2, 3, 4, 5],
      limit: 2,
      fn: async (item) => {
        if (item === 3) throw new Error('boom');
        return item;
      },
    });
    expect(out.length).toBe(5);
    expect(out[0].ok).toBe(true);
    expect(out[2].ok).toBe(false);
    if (!out[2].ok) {
      expect((out[2].error as Error).message).toBe('boom');
    }
    expect(out[4].ok).toBe(true);
  });

  test('signal short-circuits remaining claims', async () => {
    const ctl = new AbortController();
    const out = await runWithLimit({
      items: Array.from({ length: 50 }, (_, i) => i),
      limit: 4,
      signal: ctl.signal,
      fn: async (item) => {
        if (item === 5) ctl.abort();
        await new Promise((res) => setTimeout(res, 1));
        return item;
      },
    });
    // Output array has 50 slots but only some are populated.
    const populated = out.filter((x) => x !== undefined).length;
    expect(populated).toBeLessThan(50);
  });
});

describe('runSlidingPool — worker slot index passed to onItem', () => {
  test('workerIdx is 0..N-1 across all calls', async () => {
    const slotsSeen = new Set<number>();
    await runSlidingPool({
      items: Array.from({ length: 100 }, (_, i) => i),
      workers: 5,
      onItem: async (_item, _idx, workerIdx) => {
        expect(workerIdx).toBeGreaterThanOrEqual(0);
        expect(workerIdx).toBeLessThan(5);
        slotsSeen.add(workerIdx);
      },
    });
    // With 100 items and 5 workers each pulling repeatedly, all 5 slots
    // get exercised.
    expect(slotsSeen.size).toBe(5);
  });
});
