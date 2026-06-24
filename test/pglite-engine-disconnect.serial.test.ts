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
 *   6. TRACKED DB PROXY: public PGLite getters still use the native
 *      PGLite instance as their receiver, so private-field getters like
 *      `ready` and `closed` keep working after the in-flight wrapper.
 *
 *   7. IN-FLIGHT DRAIN: `disconnect()` waits for PGLite query/sql/
 *      exec/transaction work that is still running underneath an aborted
 *      caller before invoking `db.close()`. PGLite has no kernel-level
 *      cancellation; an abort only releases the JS caller, not the WASM
 *      operation.
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

function newTempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-disconnect-test-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type MutablePgliteDbForDisconnectTest = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (sql: string) => Promise<unknown[]>;
  transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
  ready: boolean;
  closed: boolean;
};

function internals(engine: PGLiteEngine): { _db: MutablePgliteDbForDisconnectTest | null } {
  return engine as unknown as { _db: MutablePgliteDbForDisconnectTest | null };
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

  test('TRACKED DB PROXY: public PGLite getters keep their native receiver', async () => {
    const dataDir = newTempDataDir();
    try {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();

      const db = engine.db as unknown as { ready: boolean; closed: boolean };
      expect(() => db.ready).not.toThrow();
      expect(db.ready).toBe(true);
      expect(() => db.closed).not.toThrow();
      expect(db.closed).toBe(false);

      await engine.disconnect();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('IN-FLIGHT DRAIN: disconnect waits for aborted executeRaw query before close', async () => {
    const dataDir = newTempDataDir();
    try {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();

      const eng = internals(engine);

      let resolveQuery!: () => void;
      let querySettled = false;
      let closeCalled = false;
      let closeSawUnsettledQuery = false;
      const realClose = eng._db!.close.bind(eng._db!);

      eng._db!.query = async () => {
        await new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        querySettled = true;
        return { rows: [{ ok: 1 }] };
      };
      eng._db!.close = async () => {
        closeCalled = true;
        closeSawUnsettledQuery = !querySettled;
        return realClose();
      };

      const controller = new AbortController();
      const raw = engine.executeRaw<{ ok: number }>('SELECT 1 AS ok', [], {
        signal: controller.signal,
      });
      controller.abort();
      await expect(raw).rejects.toThrow('aborted');

      const disconnecting = engine.disconnect();
      await sleep(20);
      expect(closeCalled).toBe(false);

      resolveQuery();
      await disconnecting;
      expect(closeCalled).toBe(true);
      expect(closeSawUnsettledQuery).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('IN-FLIGHT DRAIN: disconnect waits for direct exec before close', async () => {
    const dataDir = newTempDataDir();
    try {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();

      const eng = internals(engine);

      let resolveExec!: () => void;
      let execSettled = false;
      let closeCalled = false;
      let closeSawUnsettledExec = false;
      const realClose = eng._db!.close.bind(eng._db!);

      eng._db!.exec = async () => {
        await new Promise<void>((resolve) => {
          resolveExec = resolve;
        });
        execSettled = true;
        return [];
      };
      eng._db!.close = async () => {
        closeCalled = true;
        closeSawUnsettledExec = !execSettled;
        return realClose();
      };

      const pendingExec = engine.db.exec('SELECT 1');
      const disconnecting = engine.disconnect();
      await sleep(20);
      expect(closeCalled).toBe(false);

      resolveExec();
      await expect(pendingExec).resolves.toEqual([]);
      await disconnecting;
      expect(closeCalled).toBe(true);
      expect(closeSawUnsettledExec).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('IN-FLIGHT DRAIN: disconnect waits for transaction before close', async () => {
    const dataDir = newTempDataDir();
    try {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dataDir });
      await engine.initSchema();

      const eng = internals(engine);

      let resolveTransaction!: () => void;
      let transactionSettled = false;
      let closeCalled = false;
      let closeSawUnsettledTransaction = false;
      const realClose = eng._db!.close.bind(eng._db!);

      eng._db!.transaction = async <T>(fn: (tx: unknown) => Promise<T>) => {
        await new Promise<void>((resolve) => {
          resolveTransaction = resolve;
        });
        transactionSettled = true;
        return fn({});
      };
      eng._db!.close = async () => {
        closeCalled = true;
        closeSawUnsettledTransaction = !transactionSettled;
        return realClose();
      };

      const pendingTransaction = engine.transaction(async () => 'committed');
      const disconnecting = engine.disconnect();
      await sleep(20);
      expect(closeCalled).toBe(false);

      resolveTransaction();
      await expect(pendingTransaction).resolves.toBe('committed');
      await disconnecting;
      expect(closeCalled).toBe(true);
      expect(closeSawUnsettledTransaction).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
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
