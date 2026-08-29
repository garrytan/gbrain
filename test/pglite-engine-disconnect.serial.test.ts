/**
 * v0.41.8.0 — PGLiteEngine.disconnect() lifecycle regression tests.
 *
 * Pins the invariants the v0.41.8.0 hang fix wave depends on:
 *
 *   1. ORDERING: `db.close()` is called BEFORE the file lock is
 *      released. A sibling process must not be able to acquire the
 *      lock and try to connect to a still-closing brain. PR #1337's
 *      original diff swapped this to release-then-close — we
 *      explicitly REJECTED that ordering. This test fails if a
 *      future maintainer reads the PR and applies the swap.
 *
 *   2. SNAPSHOT + EARLY-NULL: `this._db` is nulled BEFORE awaiting
 *      `close()`, so a concurrent `connect()` cannot observe a
 *      partial mid-close state. PR #1337's load-bearing contribution
 *      that we DID take.
 *
 *   3. LOCK LEAK GUARD: if `db.close()` throws, the file lock STILL
 *      releases. Codex outside-voice finding #7 in the eng review:
 *      without try/finally, a close-throw would wedge every next
 *      gbrain invocation on the stale lock.
 *
 *   4. IDEMPOTENCY: calling disconnect() twice is a clean no-op on
 *      the second call (no throw, no double-close attempt).
 *
 *   5. DOUBLE-DISCONNECT THEN CONNECT: after disconnect, a fresh
 *      connect() sees clean state and succeeds.
 *
 * Marked .serial because PGLite WASM cold-start dominates wallclock
 * for fresh-engine-per-test cases — running these in the parallel
 * shard pool would starve other PGLite tests of cold-start time.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __registerDrainerForTest } from '../src/core/background-work.ts';
import { _resetWarnOnceForTests } from '../src/core/utils.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * Capture console.warn lines for the duration of `fn` (warnOncePerProcess
 * routes through console.warn). Restores in finally.
 */
async function captureWarns<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, warns };
  } finally {
    console.warn = orig;
  }
}

function newTempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-disconnect-test-'));
}

describe('PGLiteEngine.disconnect() — v0.41.8.0 lifecycle invariants', () => {
  test('ORDERING: db.close() is called BEFORE releaseLock()', async () => {
    const dataDir = newTempDataDir();
    try {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();

      // Record the actual call order. We spy by replacing the db
      // handle's close + the lock handle's release with timestamped
      // wrappers.
      const calls: string[] = [];
      const eng = engine as unknown as {
        _db: { close: () => Promise<void> } | null;
        _lock: { lockDir: string; acquired: boolean } | null;
      };

      const realClose = eng._db!.close.bind(eng._db!);
      eng._db!.close = async () => {
        // Tiny delay so a flipped ordering would actually show up
        // (release-before-close would beat us if we returned instantly).
        await new Promise((r) => setTimeout(r, 10));
        calls.push('db.close');
        return realClose();
      };

      // releaseLock is module-level in pglite-lock.ts — to spy we have
      // to swap the lock object's `acquired` flag detection won't
      // route through us. Easier: monkey-patch by replacing the lock
      // ref with one whose presence forces releaseLock to no-op (so
      // we just measure that the close ran during disconnect and that
      // the no-op happened in the same call).
      //
      // For the ORDERING test specifically, we wrap close and
      // measure that the lockDir mkdir is still present immediately
      // before close runs and gone after disconnect returns. The
      // lockDir's existence is observable on disk.
      const { existsSync } = await import('fs');
      const lockDir = eng._lock!.lockDir;
      expect(existsSync(lockDir)).toBe(true);

      // Spy on the lock-release moment by polling lockDir existence
      // from another timer: when close completes, the lock should
      // STILL be present (close-then-release contract).
      let lockStillPresentAtCloseFinish = false;
      const origClose = eng._db!.close;
      eng._db!.close = async () => {
        await origClose();
        // Right after close resolves, the lock has NOT yet been
        // released (the finally branch hasn't run yet). Check
        // synchronously before yielding the event loop again.
        lockStillPresentAtCloseFinish = existsSync(lockDir);
      };

      await engine.disconnect();

      expect(calls).toContain('db.close');
      expect(lockStillPresentAtCloseFinish).toBe(true);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('SNAPSHOT + EARLY-NULL: _db is nulled before await close', async () => {
    const dataDir = newTempDataDir();
    try {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();

      const eng = engine as unknown as {
        _db: { close: () => Promise<void> } | null;
      };

      let dbWasNullWhenCloseRan = false;
      const realClose = eng._db!.close.bind(eng._db!);
      eng._db!.close = async () => {
        // Inside close, the engine's _db field should ALREADY be null
        // (snapshot pattern). If it's not, the partial-state race is
        // back.
        dbWasNullWhenCloseRan = eng._db === null;
        return realClose();
      };

      await engine.disconnect();
      expect(dbWasNullWhenCloseRan).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('LOCK LEAK GUARD: if db.close() throws, lock still releases', async () => {
    const dataDir = newTempDataDir();
    try {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();

      const eng = engine as unknown as {
        _db: { close: () => Promise<void> } | null;
        _lock: { lockDir: string; acquired: boolean } | null;
      };

      const { existsSync } = await import('fs');
      const lockDir = eng._lock!.lockDir;
      expect(existsSync(lockDir)).toBe(true);

      // Force close to throw. The lock MUST still release.
      eng._db!.close = async () => {
        throw new Error('synthetic close failure');
      };

      // The throw will propagate out of disconnect — that's fine.
      // The contract is "lock releases regardless."
      let threw = false;
      try {
        await engine.disconnect();
      } catch (e) {
        threw = true;
        expect(e instanceof Error && e.message).toContain('synthetic close failure');
      }
      expect(threw).toBe(true);
      // CRITICAL: lock must be gone even though close threw.
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('IDEMPOTENCY: double disconnect is a clean no-op on the second call', async () => {
    const dataDir = newTempDataDir();
    try {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();

      let closeCallCount = 0;
      const eng = engine as unknown as {
        _db: { close: () => Promise<void> } | null;
      };
      const realClose = eng._db!.close.bind(eng._db!);
      eng._db!.close = async () => {
        closeCallCount++;
        return realClose();
      };

      await engine.disconnect();
      expect(closeCallCount).toBe(1);

      // Second call: no throw, no second close
      await engine.disconnect();
      expect(closeCallCount).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('RECONNECT after disconnect sees clean state', async () => {
    const dataDir = newTempDataDir();
    try {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();
      await engine.disconnect();

      // Same dataDir, fresh connect. Must succeed without lock contention.
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();
      // Smoke: a SELECT 1 round-trip proves the new handle is alive.
      const result = await engine.executeRaw<{ ok: number }>('SELECT 1 AS ok');
      expect(result[0].ok).toBe(1);
      await engine.disconnect();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('#6 DRAIN (#4143): disconnect() drains in-flight background statements after early-null, before close', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' }); // in-memory
    await engine.initSchema();

    // Simulate the telemetry-flush shape: a fire-and-forget CHAIN of two
    // sequential statements (statement 2 only issues after statement 1
    // settles) — the exact primitive that deadlocked PGLite's close()
    // pre-fix. The sink registers a drainer, like every production sink.
    let secondStatementError: unknown = null;
    const chain = engine
      .executeRaw('SELECT 1')
      .then(() => engine.executeRaw('SELECT 1'))
      .catch((e) => { secondStatementError = e; });
    const unregister = __registerDrainerForTest({
      name: 'test-4143-inflight',
      order: 99,
      drain: async () => { await chain; return { unfinished: 0 }; },
    });

    try {
      // Pre-fix this raced close() against the in-flight INSERT and hung
      // forever (600s CI kill). Post-fix the drain settles the chain first.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const winner = await Promise.race([
        engine.disconnect().then(() => 'disconnected' as const),
        new Promise<'hung'>((r) => { timer = setTimeout(() => r('hung'), 10_000); }),
      ]);
      if (timer) clearTimeout(timer);
      expect(winner).toBe('disconnected');
      // The chain's SECOND statement raced the early-null: either it slipped
      // in before the null (fine) or it failed fast with 'not connected'
      // (fine, and intended) — what it must NEVER do is wedge disconnect.
      if (secondStatementError !== null) {
        expect(String(secondStatementError)).toContain('not connected');
      }
    } finally {
      unregister();
    }
  }, 20_000);

  test('#7 BOUNDED CLOSE (#4143): a close() that never settles cannot wedge disconnect, and the lock still releases', async () => {
    const dataDir = newTempDataDir();
    try {
      // env floor is 1000ms — shaving ~4s off the default 5s bound per run.
      await withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '1000' }, async () => {
        const engine = new PGLiteEngine();
        await engine.connect({ database_path: dataDir });
        await engine.initSchema();

        // Force the deadlock shape directly: close() never settles.
        const eng = engine as unknown as { _db: { close: () => Promise<void> } | null };
        eng._db!.close = () => new Promise<void>(() => { /* never settles */ });

        const started = Date.now();
        await engine.disconnect(); // must resolve via the bounded race (~1s), not hang
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(4_000); // 1s bound + generous slack

        // Lock released despite the abandoned close: a fresh engine can
        // connect to the SAME dataDir without lock contention.
        const engine2 = new PGLiteEngine();
        await engine2.connect({ database_path: dataDir });
        const result = await engine2.executeRaw<{ ok: number }>('SELECT 1 AS ok');
        expect(result[0].ok).toBe(1);
        await engine2.disconnect();
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  // ───────────────────────────────────────────────────────────────
  // #4284 — the in-loop close bound, made honest. These pin the arm-
  // before-close rework, the env floor/ceiling, the warn text, and the
  // abandoned-close rejection swallow. The wedged-loop case (where NO
  // in-loop timer can fire) lives in the spawned-fixture suite:
  // test/pglite-disconnect-watchdog.serial.test.ts.
  // ───────────────────────────────────────────────────────────────

  test('#8 TIMEOUT WARN (#4284): a timed-out close warns once, names both env knobs, and teardown proceeds', async () => {
    const dataDir = newTempDataDir();
    try {
      await withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '1000' }, async () => {
        _resetWarnOnceForTests(); // 'pglite-close-timeout' is burned by test #7 in this process
        const engine = new PGLiteEngine();
        await engine.connect({ database_path: dataDir });
        const eng = engine as unknown as {
          _db: { close: () => Promise<void> } | null;
          _lock: { lockDir: string; acquired: boolean } | null;
        };
        const { existsSync } = await import('fs');
        const lockDir = eng._lock!.lockDir;
        expect(existsSync(lockDir)).toBe(true);
        eng._db!.close = () => new Promise<void>(() => { /* never settles */ });

        const started = Date.now();
        const { warns } = await captureWarns(() => engine.disconnect());
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(2_500); // resolved via the 1000ms bound

        const timeoutWarns = warns.filter((w) => w.includes('did not settle within 1000ms'));
        expect(timeoutWarns.length).toBe(1);
        // The warn is the operator runbook: it must name the override AND the
        // out-of-band watchdog (an in-loop bound cannot catch a wedged close).
        expect(timeoutWarns[0]).toContain('GBRAIN_PGLITE_CLOSE_TIMEOUT_MS');
        expect(timeoutWarns[0]).toContain('GBRAIN_PGLITE_CLOSE_WATCHDOG_MS');

        // Lock released despite the abandoned close.
        expect(existsSync(lockDir)).toBe(false);
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('#9 ABANDONED-CLOSE REJECTION (#4284): a close that rejects after the timeout never becomes an unhandledRejection', async () => {
    await withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '1000' }, async () => {
      _resetWarnOnceForTests();
      const engine = new PGLiteEngine();
      await engine.connect({ engine: 'pglite' }); // in-memory
      const eng = engine as unknown as { _db: { close: () => Promise<void> } | null };
      // Rejects 200ms AFTER the 1000ms bound fires — the abandoned-promise path.
      eng._db!.close = () =>
        new Promise<void>((_resolve, reject) =>
          setTimeout(() => reject(new Error('late synthetic close failure')), 1_200));

      const unhandled: unknown[] = [];
      const onUnhandled = (err: unknown) => { unhandled.push(err); };
      process.on('unhandledRejection', onUnhandled);
      try {
        await captureWarns(() => engine.disconnect()); // resolves ~1s via the bound
        // Let the late rejection actually fire, then a settle tick.
        await new Promise((r) => setTimeout(r, 600));
        await new Promise((r) => setTimeout(r, 50));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  }, 30_000);

  test('#10 OVERFLOW CLAMP (#4284): a huge env value means a longer bound, never a ~1ms spurious fire — with a positive control', async () => {
    // Phase 1: absurd env. Pre-clamp, setTimeout(9.9e13) overflow-fires at
    // ~1ms and the bound would spuriously abandon a healthy 50ms close.
    await withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '99999999999999' }, async () => {
      _resetWarnOnceForTests(); // burned by earlier tests — without this the assert is vacuous
      const engine = new PGLiteEngine();
      await engine.connect({ engine: 'pglite' });
      const eng = engine as unknown as { _db: { close: () => Promise<void> } | null };
      const realClose = eng._db!.close.bind(eng._db!);
      eng._db!.close = () => new Promise<void>((resolve) => setTimeout(() => resolve(realClose()), 50));

      const { warns } = await captureWarns(() => engine.disconnect());
      expect(warns.filter((w) => w.includes('did not settle')).length).toBe(0);
    });

    // Phase 2 (positive control): prove this rig CAN see the warn — same spy,
    // same reset, a bound that genuinely fires.
    await withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '1000' }, async () => {
      _resetWarnOnceForTests();
      const engine = new PGLiteEngine();
      await engine.connect({ engine: 'pglite' });
      const eng = engine as unknown as { _db: { close: () => Promise<void> } | null };
      eng._db!.close = () => new Promise<void>(() => { /* never settles */ });

      const { warns } = await captureWarns(() => engine.disconnect());
      expect(warns.filter((w) => w.includes('did not settle within 1000ms')).length).toBe(1);
    });
  }, 30_000);

  test('#12 WATCHDOG ENV MATRIX (#4284): off-variants stay off, garbage warns, grace 0 is honored', async () => {
    const { backgroundWorkSinkCount } = await import('../src/core/background-work.ts');
    // The engine-only import graph registers no sinks, so with close-timeout
    // 1000 the lethal-knob floor is max(5000, sinks*2000 + 1000 + 2000).
    const floor = Math.max(5000, backgroundWorkSinkCount() * 2000 + 1000 + 2000);
    const DEADLINE = String(floor + 1000); // above the floor: no clamp warn expected

    async function healthyDisconnect(env: Record<string, string | undefined>): Promise<string[]> {
      return withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '1000', ...env }, async () => {
        _resetWarnOnceForTests();
        const engine = new PGLiteEngine();
        await engine.connect({ engine: 'pglite' });
        const { warns } = await captureWarns(() => engine.disconnect());
        return warns;
      });
    }

    // Deliberate OFF spellings: no arm, no complaint.
    for (const off of ['0', '-5']) {
      const warns = await healthyDisconnect({ GBRAIN_PGLITE_CLOSE_WATCHDOG_MS: off });
      expect(warns.filter((w) => w.includes('watchdog')).length).toBe(0);
    }

    // Garbage ("30s" units typo) must NOT silently disarm: loud warn, still off.
    {
      const warns = await healthyDisconnect({ GBRAIN_PGLITE_CLOSE_WATCHDOG_MS: '30s' });
      expect(warns.filter((w) => w.includes('is not a number')).length).toBe(1);
      expect(warns.filter((w) => w.includes('watchdog armed')).length).toBe(0);
    }

    // Explicit grace 0 is honored: SIGKILL lands AT the deadline.
    {
      const warns = await healthyDisconnect({
        GBRAIN_PGLITE_CLOSE_WATCHDOG_MS: DEADLINE,
        GBRAIN_PGLITE_CLOSE_WATCHDOG_GRACE_MS: '0',
      });
      const armed = warns.filter((w) => w.includes('watchdog armed'));
      expect(armed.length).toBe(1);
      expect(armed[0]).toContain(`SIGTERM at ${DEADLINE}ms, SIGKILL at ${DEADLINE}ms`);
    }

    // Garbage grace warns and falls back to the 30000 default.
    {
      const warns = await healthyDisconnect({
        GBRAIN_PGLITE_CLOSE_WATCHDOG_MS: DEADLINE,
        GBRAIN_PGLITE_CLOSE_WATCHDOG_GRACE_MS: 'oops',
      });
      expect(warns.filter((w) => w.includes('Ignoring invalid GBRAIN_PGLITE_CLOSE_WATCHDOG_GRACE_MS')).length).toBe(1);
      const armed = warns.filter((w) => w.includes('watchdog armed'));
      expect(armed.length).toBe(1);
      expect(armed[0]).toContain(`SIGKILL at ${Number(DEADLINE) + 30_000}ms`);
    }
  }, 60_000);

  test('#11 FLOOR BRANCH (#4284): env below the 1000ms floor is floored, not applied literally', async () => {
    await withEnv({ GBRAIN_PGLITE_CLOSE_TIMEOUT_MS: '10' }, async () => {
      _resetWarnOnceForTests(); // burned by earlier tests — without this the assert is vacuous
      const engine = new PGLiteEngine();
      await engine.connect({ engine: 'pglite' });
      const eng = engine as unknown as { _db: { close: () => Promise<void> } | null };
      const realClose = eng._db!.close.bind(eng._db!);
      // Settles at ~300ms: under a literal 10ms bound the timer wins and warns;
      // under the floored 1000ms bound the close wins and nothing warns.
      eng._db!.close = () => new Promise<void>((resolve) => setTimeout(() => resolve(realClose()), 300));

      const { warns } = await captureWarns(() => engine.disconnect());
      expect(warns.filter((w) => w.includes('did not settle')).length).toBe(0);
    });
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────
// #2084 — preservingProcessExitCode behavioral containment
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Emscripten process.exitCode containment (#2084)', () => {
  test('connect() leaves process.exitCode pinned at 0, not the Emscripten 99', async () => {
    const prev = process.exitCode;
    const eng = new PGLiteEngine();
    try {
      await eng.connect({ engine: 'pglite' });
      // Emscripten writes 99 during create; the wrapper pins explicit 0 when
      // nothing was set before (undefined cannot be restored — the accessor
      // falls back to the WASM status).
      expect(Number(process.exitCode)).toBe(0);
    } finally {
      await eng.disconnect();
      process.exitCode = prev;
    }
  }, 60_000);

  test('a pre-call verdict survives the create-throw path (finally restores)', async () => {
    const prev = process.exitCode;
    const eng = new PGLiteEngine();
    try {
      process.exitCode = 3;
      // A dataDir under a regular FILE cannot be created — PGlite.create rejects.
      await expect(
        eng.connect({ engine: 'pglite', database_path: '/dev/null/nope/brain' }),
      ).rejects.toThrow();
      expect(Number(process.exitCode)).toBe(3);
    } finally {
      process.exitCode = prev;
    }
  }, 60_000);
});
