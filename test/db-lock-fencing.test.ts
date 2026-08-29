/**
 * W0 fix-wave (Tier-1 #1, D5.10) — per-acquisition lock fencing.
 *
 * The refresh/release predicates require (id, holder_pid, acquired_at::text),
 * so a handle from a PREVIOUS acquisition — a PID-reuse impostor, or this
 * process after its row was stolen — can never refresh or delete a
 * successor's row. Pre-fix the predicates were (id, holder_pid) only, and an
 * expired holder could refresh a successor's lock while reporting success
 * (Codex eng-review #1 on the fix-wave plan).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock, LockStolenError } from '../src/core/db-lock.ts';
import { startCycleLockRefresher, buildYieldDuringPhase, isLockStolenAbort, type LockHandle } from '../src/core/cycle.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'test-fence-%'`);
});

/** Simulate a successor stealing the row: rewrite acquisition identity in place. */
async function stealRow(lockId: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE gbrain_cycle_locks
        SET holder_pid = holder_pid,
            acquired_at = acquired_at + INTERVAL '1 millisecond',
            ttl_expires_at = NOW() + INTERVAL '5 minutes',
            last_refreshed_at = NOW()
      WHERE id = $1`,
    [lockId],
  );
}

describe('fenced refresh/release (D5.10)', () => {
  test('handle carries its acquisition fence and refresh() returns true while owned', async () => {
    const handle = await tryAcquireDbLock(engine, 'test-fence-own', 5);
    expect(handle).not.toBeNull();
    expect(typeof handle!.acquiredAt).toBe('string');
    expect(handle!.acquiredAt.length).toBeGreaterThan(0);
    expect(await handle!.refresh()).toBe(true);
    // Refresh must not change the acquisition identity.
    expect(await handle!.refresh()).toBe(true);
    await handle!.release();
  });

  test('after a steal, the old handle refresh() returns false and cannot re-take the row', async () => {
    const handle = await tryAcquireDbLock(engine, 'test-fence-steal', 5);
    expect(handle).not.toBeNull();
    await stealRow('test-fence-steal');

    expect(await handle!.refresh()).toBe(false);
    // The failed refresh must not have bumped the successor's TTL under the
    // OLD identity — i.e. the row still exists and refresh stays false.
    expect(await handle!.refresh()).toBe(false);
  });

  test("release() after a steal is a fenced no-op — the successor's row survives", async () => {
    const handle = await tryAcquireDbLock(engine, 'test-fence-release', 5);
    expect(handle).not.toBeNull();
    await stealRow('test-fence-release');

    await handle!.release(); // must NOT delete the successor's row
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM gbrain_cycle_locks WHERE id = $1`,
      ['test-fence-release'],
    );
    expect(rows.length).toBe(1);
  });

  test('release() while still owned deletes the row (normal path unchanged)', async () => {
    const handle = await tryAcquireDbLock(engine, 'test-fence-normal', 5);
    expect(handle).not.toBeNull();
    await handle!.release();
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM gbrain_cycle_locks WHERE id = $1`,
      ['test-fence-normal'],
    );
    expect(rows.length).toBe(0);
  });
});

describe('startCycleLockRefresher (Tier-1 #1 + D5.11)', () => {
  const fakeLock = (impl: () => Promise<boolean>): LockHandle => ({
    refresh: impl,
    release: async () => {},
  });

  test('aborts the controller with LockStolenError when a fenced refresh returns false', async () => {
    const controller = new AbortController();
    const stop = startCycleLockRefresher(fakeLock(async () => false), controller, 'test-lock', 15);
    try {
      // Poll instead of a fixed sleep: under full-suite shard load, timer
      // ticks can be starved well past the nominal interval. Poll on the
      // REASON, not just `aborted`: one loaded-CI run (2026-08-16, shard 9)
      // observed `aborted === true` with `reason === undefined` at the first
      // post-abort read — unreproduced locally/in-container across 50+ runs,
      // so treat reason visibility as part of the awaited condition and keep
      // the assertion diagnostic when it genuinely never arrives.
      const deadline = Date.now() + 5_000;
      while (!(controller.signal.reason instanceof LockStolenError) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
      }
      expect(controller.signal.aborted).toBe(true);
      if (!(controller.signal.reason instanceof LockStolenError)) {
        throw new Error(
          `expected LockStolenError abort reason within 5s; aborted=${controller.signal.aborted} reason=${String(controller.signal.reason)}`,
        );
      }
    } finally {
      stop();
    }
  });

  test('serializes refreshes — a slow refresh never overlaps the next tick', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const controller = new AbortController();
    const stop = startCycleLockRefresher(fakeLock(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 60));
      inFlight--;
      return true;
    }), controller, 'test-lock', 15);
    try {
      await new Promise(r => setTimeout(r, 250));
      expect(maxInFlight).toBe(1);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      stop();
    }
  });

  test('a THROWN refresh error is transient — logged, retried, never treated as a steal', async () => {
    let calls = 0;
    const controller = new AbortController();
    const stop = startCycleLockRefresher(fakeLock(async () => {
      calls++;
      throw new Error('pooler blip');
    }), controller, 'test-lock', 15);
    try {
      await new Promise(r => setTimeout(r, 120));
      expect(calls).toBeGreaterThan(1); // kept retrying
      expect(controller.signal.aborted).toBe(false);
    } finally {
      stop();
    }
  });

  test('stop() halts ticking', async () => {
    let calls = 0;
    const controller = new AbortController();
    const stop = startCycleLockRefresher(fakeLock(async () => { calls++; return true; }), controller, 'test-lock', 15);
    await new Promise(r => setTimeout(r, 50));
    stop();
    const after = calls;
    await new Promise(r => setTimeout(r, 60));
    expect(calls).toBe(after);
  });

  // #4309: the tick gate used to check ONLY the internal steal controller. An
  // external abort (opts.signal) with a hung phase never reaches runCycle's
  // finally, so the leaked timer renewed the fenced lock forever and no
  // successor could ever take over.
  test('external abort stops renewals even when stop() is never called (#4309)', async () => {
    let calls = 0;
    const controller = new AbortController();
    const external = new AbortController();
    const stop = startCycleLockRefresher(
      fakeLock(async () => { calls++; return true; }),
      controller, 'test-lock', 15, external.signal,
    );
    try {
      const deadline = Date.now() + 5_000;
      while (calls === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
      }
      expect(calls).toBeGreaterThan(0); // was renewing while un-aborted
      external.abort();
      // Deliberately do NOT call stop() — this is the hung-phase leak shape.
      const after = calls;
      await new Promise(r => setTimeout(r, 100));
      expect(calls).toBe(after);
      // An external abort is not a steal — the internal controller stays quiet.
      expect(controller.signal.aborted).toBe(false);
    } finally {
      stop();
    }
  });

  test('an already-aborted external signal never ticks (#4309)', async () => {
    let calls = 0;
    const controller = new AbortController();
    const external = new AbortController();
    external.abort();
    const stop = startCycleLockRefresher(
      fakeLock(async () => { calls++; return true; }),
      controller, 'test-lock', 15, external.signal,
    );
    try {
      await new Promise(r => setTimeout(r, 80));
      expect(calls).toBe(0);
    } finally {
      stop();
    }
  });

  test('stop() after external abort is safe and idempotent (#4309)', async () => {
    const controller = new AbortController();
    const external = new AbortController();
    const stop = startCycleLockRefresher(
      fakeLock(async () => true),
      controller, 'test-lock', 15, external.signal,
    );
    external.abort();
    stop();
    stop(); // second call must not throw
  });
});

describe('buildYieldDuringPhase steal reporting', () => {
  test('invokes onStolen when refresh() returns false, still fires the outer hook', async () => {
    let stolenErr: LockStolenError | undefined;
    let outerRan = false;
    const fn = buildYieldDuringPhase(
      { refresh: async () => false, release: async () => {} },
      async () => { outerRan = true; },
      (e) => { stolenErr = e; },
    );
    await fn!();
    expect(stolenErr).toBeInstanceOf(LockStolenError);
    expect(outerRan).toBe(true);
  });

  test('does NOT invoke onStolen on a thrown (transient) refresh error', async () => {
    let stolen = false;
    const fn = buildYieldDuringPhase(
      { refresh: async () => { throw new Error('blip'); }, release: async () => {} },
      undefined,
      () => { stolen = true; },
    );
    await fn!();
    expect(stolen).toBe(false);
  });
});

describe('isLockStolenAbort — the steal decision does not depend on the reason (#4140)', () => {
  // Duck-typed signals on purpose: `abort()` and `abort(undefined)` BOTH yield a
  // DOMException, so `reason: undefined` — the state the runtime actually
  // delivers — is unreachable through AbortController. This is the only way to
  // pin it deterministically instead of waiting for the ~1-in-20 flake.

  test('a steal with the reason DROPPED still classifies as a steal', () => {
    expect(isLockStolenAbort({ aborted: true, reason: undefined }, undefined)).toBe(true);
  });

  test('a steal with the reason intact classifies as a steal (unchanged)', () => {
    expect(isLockStolenAbort({ aborted: true, reason: new LockStolenError('x') }, undefined)).toBe(true);
  });

  test('no steal when the controller never fired', () => {
    expect(isLockStolenAbort({ aborted: false }, undefined)).toBe(false);
    expect(isLockStolenAbort(undefined, undefined)).toBe(false);
  });

  test('an external abort still wins — it keeps the throw-out contract', () => {
    // Both with and without a surviving reason, so the external conjunct is
    // pinned independently of the reason.
    expect(isLockStolenAbort({ aborted: true, reason: new LockStolenError('x') }, { aborted: true })).toBe(false);
    expect(isLockStolenAbort({ aborted: true, reason: undefined }, { aborted: true })).toBe(false);
  });

  test('a non-aborted external signal does not suppress the steal', () => {
    expect(isLockStolenAbort({ aborted: true, reason: undefined }, { aborted: false })).toBe(true);
  });
});
