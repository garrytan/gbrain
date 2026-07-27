/**
 * v0.41.8.0 — drain helper for fire-and-forget last_retrieved_at writes.
 *
 * Closes #1247, #1269, #1290: PGLite CLI commands printed search /
 * query / get_page output then hung at ~95-98% CPU until SIGKILL.
 * The drain helper here is the structural fix paired with the
 * cli.ts narrow timeout-only force-exit guard.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  awaitPendingLastRetrievedWrites,
  bumpLastRetrievedAt,
  _resetTrackRetrievalCacheForTests,
  _resetPendingLastRetrievedWritesForTests,
  _peekPendingLastRetrievedWritesForTests,
} from '../src/core/last-retrieved.ts';

// Minimal BrainEngine stub. The drain helper itself doesn't touch
// the engine — only bumpLastRetrievedAt does — so we control behavior
// through what `executeRaw` does.
function makeStubEngine(opts?: {
  executeRaw?: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  getConfig?: (key: string) => Promise<string | null>;
}): BrainEngine {
  const engine = {
    kind: 'pglite' as const,
    executeRaw:
      opts?.executeRaw ??
      (async () => {
        return [];
      }),
    getConfig:
      opts?.getConfig ??
      (async () => {
        return null;
      }),
  };
  return engine as unknown as BrainEngine;
}

describe('awaitPendingLastRetrievedWrites', () => {
  beforeEach(() => {
    _resetPendingLastRetrievedWritesForTests();
    _resetTrackRetrievalCacheForTests();
  });

  afterEach(() => {
    _resetPendingLastRetrievedWritesForTests();
    _resetTrackRetrievalCacheForTests();
  });

  test('empty set returns drained:0 immediately (fast-path)', async () => {
    const t0 = Date.now();
    const result = await awaitPendingLastRetrievedWrites();
    const dt = Date.now() - t0;
    expect(result).toEqual({ outcome: 'drained', pending: 0 });
    expect(dt).toBeLessThan(50);
  });

  test('single tracked write completes, drain resolves cleanly', async () => {
    let resolved = false;
    const engine = makeStubEngine({
      executeRaw: async () => {
        await new Promise((r) => setTimeout(r, 30));
        resolved = true;
        return [];
      },
    });
    bumpLastRetrievedAt(engine, [1, 2, 3]);
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(1);
    const result = await awaitPendingLastRetrievedWrites();
    expect(result).toEqual({ outcome: 'drained', pending: 0 });
    expect(resolved).toBe(true);
    // Promise removed from set on settle
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
  });

  test('multiple tracked writes all settled via allSettled', async () => {
    let count = 0;
    const engine = makeStubEngine({
      executeRaw: async () => {
        await new Promise((r) => setTimeout(r, 20));
        count++;
        return [];
      },
    });
    bumpLastRetrievedAt(engine, [1]);
    bumpLastRetrievedAt(engine, [2]);
    bumpLastRetrievedAt(engine, [3]);
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(3);
    const result = await awaitPendingLastRetrievedWrites();
    expect(result.outcome).toBe('drained');
    expect(count).toBe(3);
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
  });

  test('throw inside IIFE still settles the promise; drain completes', async () => {
    const engine = makeStubEngine({
      executeRaw: async () => {
        throw new Error('synthetic-failure');
      },
    });
    bumpLastRetrievedAt(engine, [1]);
    // Brief tick so the IIFE has a chance to run and reject
    await new Promise((r) => setTimeout(r, 10));
    const result = await awaitPendingLastRetrievedWrites();
    expect(result.outcome).toBe('drained');
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
  });

  test('permanently-pending promise returns timeout outcome with pending count', async () => {
    // Stage a manually-tracked promise that never resolves so the
    // drain hits the timeout path. We can't use bumpLastRetrievedAt
    // for this (its IIFE always settles via try/catch) — we need
    // the raw track API. Use the public API and a never-resolving
    // executeRaw stub.
    const neverEngine = makeStubEngine({
      executeRaw: () => new Promise<unknown[]>(() => {
        /* never */
      }),
    });
    bumpLastRetrievedAt(neverEngine, [1]);
    await new Promise((r) => setTimeout(r, 10));
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(1);

    const t0 = Date.now();
    const result = await awaitPendingLastRetrievedWrites(100); // 100ms test timeout
    const dt = Date.now() - t0;

    expect(result.outcome).toBe('timeout');
    expect(result.pending).toBe(1);
    // Should return within timeout + small buffer; not block forever
    expect(dt).toBeGreaterThanOrEqual(100);
    expect(dt).toBeLessThan(300);
    // C1 fix: snapshot's tracked promises ARE dropped from the set on
    // timeout so the next drain doesn't see ghosts (daemon leak guard).
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
  });

  test('bumpLastRetrievedAt with empty pageIds does not track a promise', async () => {
    const engine = makeStubEngine();
    bumpLastRetrievedAt(engine, []);
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
    const result = await awaitPendingLastRetrievedWrites();
    expect(result).toEqual({ outcome: 'drained', pending: 0 });
  });

  test('C1 fix: second drain after timeout is clean (daemon leak guard)', async () => {
    // Adversarial-review C1: in `gbrain serve` (long-lived), a timed-out
    // IIFE used to stay tracked forever because its `.finally` never
    // fires. Repeated timeouts would leak references without bound.
    // After the timeout, the next drain MUST see an empty set and
    // return immediately rather than re-timing-out on the same ghost.
    const neverEngine = makeStubEngine({
      executeRaw: () => new Promise<unknown[]>(() => {
        /* never */
      }),
    });
    bumpLastRetrievedAt(neverEngine, [1]);
    await new Promise((r) => setTimeout(r, 10));
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(1);

    const first = await awaitPendingLastRetrievedWrites(100);
    expect(first.outcome).toBe('timeout');
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);

    // Second drain with no new writes returns immediately.
    const t0 = Date.now();
    const second = await awaitPendingLastRetrievedWrites(100);
    const dt = Date.now() - t0;
    expect(second).toEqual({ outcome: 'drained', pending: 0 });
    expect(dt).toBeLessThan(50);
  });
});
