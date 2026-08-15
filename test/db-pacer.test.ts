/**
 * Pins the DB-pacer primitive: concurrency cap (the real lever), abort-throws,
 * in-band EWMA, jittered cooperative sleep, fail-open, and the no-op path.
 *
 * Uses a fake sleep + deterministic rng so there's no real wall-clock wait and
 * no flakiness — the whole suite runs in microtask time.
 */
import { describe, expect, test } from 'bun:test';
import { createDbPacer, createNoopPacer, type DbPacer } from '../src/core/db-pacer.ts';
import { AbortError } from '../src/core/abort-check.ts';
import { PACE_BUNDLES, type PaceBundle } from '../src/core/pace-mode.ts';

const BUNDLE: PaceBundle = {
  enabled: true,
  maxConcurrency: 2,
  paceAtMs: 100,
  maxSleepMs: 1000,
  ewmaAlpha: 0.5,
};

/** A fake sleep that resolves immediately but still honors abort. */
function fakeSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortError('aborted'));
  return Promise.resolve();
}

function pacer(over: Partial<PaceBundle> = {}, rng = () => 0.5): DbPacer {
  return createDbPacer({ bundle: { ...BUNDLE, ...over }, sleep: fakeSleep, rng });
}

describe('concurrency cap (the real lever)', () => {
  test('caps simultaneous permits at maxConcurrency; release hands off FIFO', async () => {
    const p = pacer({ maxConcurrency: 2 });
    const a = await p.acquire();
    const b = await p.acquire();
    expect(p.snapshot().active).toBe(2);

    let cResolved = false;
    const cPromise = p.acquire().then((permit) => {
      cResolved = true;
      return permit;
    });
    // c is blocked: still 2 active, 1 waiter.
    await Promise.resolve();
    expect(cResolved).toBe(false);
    expect(p.snapshot().active).toBe(2);
    expect(p.snapshot().maxWaiters).toBe(1);

    a.release(); // hands the slot to c
    const c = await cPromise;
    expect(cResolved).toBe(true);
    expect(p.snapshot().active).toBe(2); // handoff kept the cap, never 3

    b.release();
    c.release();
    expect(p.snapshot().active).toBe(0);
  });

  test('double release is idempotent', async () => {
    const p = pacer({ maxConcurrency: 1 });
    const a = await p.acquire();
    a.release();
    a.release();
    expect(p.snapshot().active).toBe(0);
  });
});

describe('abort throws (never falls into a DB call)', () => {
  test('acquire throws AbortError when the signal fires while waiting', async () => {
    const p = pacer({ maxConcurrency: 1 });
    await p.acquire(); // exhausts the single slot
    const ac = new AbortController();
    const blocked = p.acquire(ac.signal);
    ac.abort();
    await expect(blocked).rejects.toBeInstanceOf(AbortError);
    expect(p.snapshot().maxWaiters).toBe(1);
  });

  test('acquire throws immediately when already aborted', async () => {
    const p = pacer();
    const ac = new AbortController();
    ac.abort();
    await expect(p.acquire(ac.signal)).rejects.toBeInstanceOf(AbortError);
  });

  test('pace throws AbortError when aborted during sleep', async () => {
    // sleep that rejects with AbortError when the signal is set.
    const p = createDbPacer({
      bundle: BUNDLE,
      sleep: (_ms, signal) =>
        signal?.aborted ? Promise.reject(new AbortError('aborted')) : Promise.resolve(),
      rng: () => 0.5,
    });
    p.observe(1000); // EWMA well above paceAtMs → will sleep
    const ac = new AbortController();
    ac.abort();
    await expect(p.pace(ac.signal)).rejects.toBeInstanceOf(AbortError);
  });
});

describe('in-band EWMA + observe guard', () => {
  test('first sample seeds EWMA; later samples smooth it', () => {
    const p = pacer({ ewmaAlpha: 0.5 });
    expect(p.snapshot().ewmaMs).toBeNull();
    p.observe(200);
    expect(p.snapshot().ewmaMs).toBe(200);
    p.observe(400);
    expect(p.snapshot().ewmaMs).toBe(300); // 0.5*400 + 0.5*200
    expect(p.snapshot().sampleCount).toBe(2);
  });

  test('NaN / negative samples are ignored', () => {
    const p = pacer();
    p.observe(Number.NaN);
    p.observe(-5);
    p.observe(Infinity);
    expect(p.snapshot().ewmaMs).toBeNull();
    expect(p.snapshot().sampleCount).toBe(0);
  });
});

describe('cooperative sleep', () => {
  test('no sleep when EWMA is below paceAtMs', async () => {
    const p = pacer({ paceAtMs: 100 });
    p.observe(50);
    await p.pace();
    expect(p.snapshot().sleepCount).toBe(0);
    expect(p.snapshot().totalSleptMs).toBe(0);
  });

  test('sleeps when EWMA exceeds paceAtMs; jittered to 50-100% of base, capped', async () => {
    // rng=0 → jitter factor 0.5 → ms = round(base * 0.5).
    const p = pacer({ paceAtMs: 100, maxSleepMs: 1000 }, () => 0);
    p.observe(800); // base = min(1000, 800) = 800; ms = 400
    await p.pace();
    expect(p.snapshot().sleepCount).toBe(1);
    expect(p.snapshot().totalSleptMs).toBe(400);
  });

  test('sleep base is capped at maxSleepMs', async () => {
    const p = pacer({ paceAtMs: 100, maxSleepMs: 300 }, () => 1); // jitter factor 1.0
    p.observe(5000); // base = min(300, 5000) = 300; ms = 300
    await p.pace();
    expect(p.snapshot().totalSleptMs).toBe(300);
  });

  test('different rng values decorrelate sleep durations (anti-thundering-herd)', async () => {
    const lo = pacer({ paceAtMs: 100 }, () => 0); // factor 0.5
    const hi = pacer({ paceAtMs: 100 }, () => 1); // factor 1.0
    lo.observe(800);
    hi.observe(800);
    await lo.pace();
    await hi.pace();
    expect(lo.snapshot().totalSleptMs).toBe(400);
    expect(hi.snapshot().totalSleptMs).toBe(800);
  });
});

describe('fail-open', () => {
  test('an unexpected (non-abort) sleep failure does not throw', async () => {
    const p = createDbPacer({
      bundle: BUNDLE,
      sleep: () => Promise.reject(new Error('boom')),
      rng: () => 0.5,
    });
    p.observe(1000);
    await expect(p.pace()).resolves.toBeUndefined();
    // The failed sleep is not counted.
    expect(p.snapshot().sleepCount).toBe(0);
  });
});

describe('no-op pacer (off mode / PGLite)', () => {
  test('createNoopPacer: unbounded acquire, zero sleeps', async () => {
    const p = createNoopPacer();
    const permits = await Promise.all([p.acquire(), p.acquire(), p.acquire()]);
    expect(permits).toHaveLength(3);
    p.observe(99999);
    await p.pace();
    expect(p.snapshot().enabled).toBe(false);
    expect(p.snapshot().totalSleptMs).toBe(0);
  });

  test('an off bundle yields a no-op pacer', async () => {
    const p = createDbPacer({ bundle: PACE_BUNDLES.off });
    expect(p.snapshot().enabled).toBe(false);
    await p.acquire();
    await p.acquire(); // never blocks despite maxConcurrency 0
    expect(p.snapshot().active).toBe(0);
  });
});

describe('dispose', () => {
  test('dispose releases blocked acquirers with a no-op permit', async () => {
    const p = pacer({ maxConcurrency: 1 });
    await p.acquire();
    const blocked = p.acquire();
    p.dispose();
    const permit = await blocked; // resolves instead of hanging
    expect(permit).toBeDefined();
  });
});
