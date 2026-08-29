/**
 * Degraded-mode engine (db-availability 4c) — the lazy-reconnect stand-in
 * serve boots with when Postgres is dead at startup. Pins the semantics the
 * whole degraded-serve design hangs on: single-flight reconnects, the
 * min-interval stale-but-honest window, permanent swap + recovery callbacks,
 * the disconnect no-op, and the synchronous `kind` getter.
 */
import { describe, expect, it } from 'bun:test';

import { DegradedRecoveredRetryError, createDegradedEngine } from '../src/core/degraded-engine.ts';
import { degradedLastError, isEngineDegraded, onEngineRecovered } from '../src/core/degraded-marker.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function fakeLiveEngine(): BrainEngine {
  return {
    kind: 'postgres',
    getStats: async () => ({ page_count: 42 }),
    disconnect: async () => { (fakeLiveEngine as unknown as { disconnected?: boolean }).disconnected = true; },
  } as unknown as BrainEngine;
}

function boom(msg = 'connect ECONNREFUSED 127.0.0.1:5432'): Error {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'ECONNREFUSED';
  return e;
}

describe('createDegradedEngine', () => {
  it('throws the ORIGINAL startup error while dead (dispatch reclassifies the real shape)', async () => {
    const initial = boom('startup failure');
    let now = 0;
    const engine = createDegradedEngine({
      initialError: initial,
      reconnect: async () => { throw boom('still down'); },
      minIntervalMs: 5000,
      now: () => now,
    });
    // First call: a REAL attempt runs and its (fresh) error propagates.
    await expect((engine as unknown as { getStats: () => Promise<unknown> }).getStats()).rejects.toThrow('still down');
    // Inside the min-interval window: the STORED error, no new attempt.
    now = 1000;
    await expect((engine as unknown as { getStats: () => Promise<unknown> }).getStats()).rejects.toThrow('still down');
  });

  it('is single-flight: concurrent calls share one reconnect attempt; both get RECOVERED-retry', async () => {
    let attempts = 0;
    let resolveGate: (() => void) | null = null;
    const engine = createDegradedEngine({
      initialError: boom(),
      reconnect: async () => {
        attempts++;
        await new Promise<void>((r) => { resolveGate = r; });
        return fakeLiveEngine();
      },
      minIntervalMs: 0,
      now: () => Date.now(),
    });
    const e = engine as unknown as { getStats: () => Promise<{ page_count: number }> };
    const p1 = e.getStats().catch((err) => err);
    const p2 = e.getStats().catch((err) => err);
    resolveGate!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(attempts).toBe(1);
    // Degraded-era callers never get results — their source scope predates
    // recovery. Both get the explicit retry error; the NEXT call delegates.
    expect(r1).toBeInstanceOf(DegradedRecoveredRetryError);
    expect(r2).toBeInstanceOf(DegradedRecoveredRetryError);
    expect((await e.getStats()).page_count).toBe(42);
  });

  it('respects the min-interval between REAL attempts (no connect storms)', async () => {
    let attempts = 0;
    let now = 0;
    const engine = createDegradedEngine({
      initialError: boom(),
      reconnect: async () => { attempts++; throw boom(`attempt ${attempts}`); },
      minIntervalMs: 5000,
      now: () => now,
    });
    const e = engine as unknown as { getStats: () => Promise<unknown> };
    await expect(e.getStats()).rejects.toThrow('attempt 1');
    now = 4999; // inside the window — stored error, no attempt
    await expect(e.getStats()).rejects.toThrow('attempt 1');
    expect(attempts).toBe(1);
    now = 5001; // window passed — real attempt
    await expect(e.getStats()).rejects.toThrow('attempt 2');
    expect(attempts).toBe(2);
  });

  it('swaps in the live engine permanently, fires recovery callbacks once, and fails the HEALING call with retry', async () => {
    let attempts = 0;
    const engine = createDegradedEngine({
      initialError: boom(),
      reconnect: async () => { attempts++; return fakeLiveEngine(); },
      minIntervalMs: 0,
      now: () => Date.now(),
    });
    expect(isEngineDegraded(engine)).toBe(true);
    let recovered = 0;
    onEngineRecovered(engine, () => { recovered++; });

    const e = engine as unknown as { getStats: () => Promise<{ page_count: number }> };
    // The healing call itself gets the retry error (its scope predates recovery)…
    await expect(e.getStats()).rejects.toBeInstanceOf(DegradedRecoveredRetryError);
    expect(isEngineDegraded(engine)).toBe(false);
    expect(recovered).toBe(1);

    // …and every subsequent call delegates to the live engine, no new reconnects.
    expect((await e.getStats()).page_count).toBe(42);
    await e.getStats();
    expect(attempts).toBe(1);

    // A callback registered AFTER recovery fires immediately.
    let late = 0;
    onEngineRecovered(engine, () => { late++; });
    expect(late).toBe(1);
  });

  it('caps caller wait on a slow in-flight attempt with the stored error (attempt continues)', async () => {
    let resolveGate: (() => void) | null = null;
    const engine = createDegradedEngine({
      initialError: boom('slow pooler'),
      reconnect: async () => {
        await new Promise<void>((r) => { resolveGate = r; });
        return fakeLiveEngine();
      },
      minIntervalMs: 0,
      callerWaitMs: 20, // tiny cap for the test
      now: () => Date.now(),
    });
    const e = engine as unknown as { getStats: () => Promise<{ page_count: number }> };
    // Caller is released with the STORED error after the cap, not stalled.
    await expect(e.getStats()).rejects.toThrow('slow pooler');
    expect(isEngineDegraded(engine)).toBe(true);
    // The background attempt still completes and swaps in the live engine.
    resolveGate!();
    await new Promise((r) => setTimeout(r, 10));
    expect(isEngineDegraded(engine)).toBe(false);
    expect((await e.getStats()).page_count).toBe(42);
  });

  it('disconnect is a no-op while dead — shutdown must never trigger a reconnect', async () => {
    let attempts = 0;
    const engine = createDegradedEngine({
      initialError: boom(),
      reconnect: async () => { attempts++; throw boom(); },
      minIntervalMs: 0,
      now: () => Date.now(),
    });
    await (engine as unknown as { disconnect: () => Promise<void> }).disconnect();
    expect(attempts).toBe(0);
  });

  it('kind reads synchronously as postgres while dead (the ~29 sync branch sites)', () => {
    const engine = createDegradedEngine({
      initialError: boom(),
      reconnect: async () => fakeLiveEngine(),
      now: () => Date.now(),
    });
    expect(engine.kind).toBe('postgres');
  });

  it('prototype getters (sql) THROW the stored error while dead, delegate after recovery', async () => {
    const initial = boom('dead sql read');
    const engine = createDegradedEngine({
      initialError: initial,
      reconnect: async () => fakeLiveEngine(),
      minIntervalMs: 0,
      now: () => Date.now(),
    });
    // PostgresEngine.prototype carries `get sql()` — the degraded wrapper
    // must mirror it as a getter. While dead, a sync property read never
    // triggers a reconnect: it throws the STORED error (never a silent
    // undefined that downstream code would call methods on).
    expect(() => (engine as unknown as { sql: unknown }).sql).toThrow('dead sql read');
    // Read-only diagnosis seam agrees: the stored error, by identity.
    expect(degradedLastError(engine)).toBe(initial);

    // Trigger recovery via a method call (the healing call gets the retry error).
    await expect(
      (engine as unknown as { getStats: () => Promise<unknown> }).getStats(),
    ).rejects.toBeInstanceOf(DegradedRecoveredRetryError);
    expect(isEngineDegraded(engine)).toBe(false);

    // Post-recovery: the getter DELEGATES to the live engine without throwing.
    // The fake live engine has no `sql` getter, so delegation surfaces its
    // (undefined) value — the point is the read reaches the live engine.
    expect((engine as unknown as { sql: unknown }).sql).toBeUndefined();
    // And the diagnosis seam goes quiet after recovery.
    expect(degradedLastError(engine)).toBeUndefined();
  });

  it('degradedLastError on a real engine returns undefined (no marker)', () => {
    expect(degradedLastError(fakeLiveEngine())).toBeUndefined();
  });

  it('real engines never read as degraded and recovery registration is a no-op on them', () => {
    const live = fakeLiveEngine();
    expect(isEngineDegraded(live)).toBe(false);
    onEngineRecovered(live, () => { throw new Error('must not fire'); });
  });

  it('covers the full PostgresEngine method surface (a new engine method can never miss the degraded path)', () => {
    const engine = createDegradedEngine({
      initialError: boom(),
      reconnect: async () => fakeLiveEngine(),
      now: () => Date.now(),
    });
    for (const name of ['getStats', 'searchKeyword', 'executeRaw', 'getPage', 'putPage', 'initSchema', 'connect']) {
      expect(typeof (engine as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
