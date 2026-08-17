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
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();

      // Force the deadlock shape directly: close() never settles.
      const eng = engine as unknown as { _db: { close: () => Promise<void> } | null };
      eng._db!.close = () => new Promise<void>(() => { /* never settles */ });

      const started = Date.now();
      await engine.disconnect(); // must resolve via the bounded race (~5s), not hang
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(9_000); // 5s bound + generous slack

      // Lock released despite the abandoned close: a fresh engine can
      // connect to the SAME dataDir without lock contention.
      const engine2 = new PGLiteEngine();
      await engine2.connect({ database_path: dataDir });
      const result = await engine2.executeRaw<{ ok: number }>('SELECT 1 AS ok');
      expect(result[0].ok).toBe(1);
      await engine2.disconnect();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
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
