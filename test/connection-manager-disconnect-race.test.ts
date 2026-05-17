/**
 * Regression: `disconnect()` must cancel an in-flight `initDirectPool()`
 * chain so a pool that finishes initializing *after* disconnect can't
 * resurrect `_directPool` and leak its socket.
 *
 * Pre-fix shape (commit 7 of dual-pool work, pre-this-PR):
 *
 *     async disconnect(): Promise<void> {
 *       if (this._directPool) {                // ← guard
 *         try { await this._directPool.end(); } catch { … }
 *         this._directPool = null;
 *         this._directInit = null;             // ← only cleared inside guard
 *       }
 *       …
 *     }
 *
 * Two race holes the pre-fix code allowed:
 *
 *  1. `disconnect()` runs while `getDirectPool()` is mid-init. The
 *     `if (this._directPool)` guard fails (pool not assigned yet), so
 *     `_directInit` stays pointing at the in-flight Promise. When the
 *     Promise resolves, its `.then(pool => { this._directPool = pool; ... })`
 *     callback fires and **resurrects `_directPool` after disconnect**.
 *
 *  2. The resurrected pool's socket is now held by `_directPool` without
 *     anyone tracking it for shutdown — a clean fd leak across rapid
 *     reconnect cycles (the kind tests + Conductor worktrees + worker
 *     pools all exhibit).
 *
 * Fix wires three pieces:
 *
 *   - a `_disconnected` flag flipped in `disconnect()` before anything else
 *   - the `.then()` callback in `getDirectPool` checks the flag, closes
 *     the orphan pool (`pool.end()`), and resolves `null`
 *   - `disconnect()` always clears `_directInit` (lifted out of the guard)
 *     and awaits the pending init Promise so the orphan close actually
 *     completes before disconnect resolves
 *
 * This test exercises the exact race: spy on the private `initDirectPool`
 * to return a delayable Promise, start the caller, kick `disconnect()`
 * before the init resolves, then resolve the init and assert (a) no
 * pool resurrection, (b) the orphan pool's `.end()` got called, (c) any
 * subsequent `getDirectPool()` throws cleanly instead of silently
 * starting a fresh init.
 *
 * spyOn on a method via `as any` is parallel-safe (instance-level
 * monkey-patching, never touches process globals). No `mock.module`,
 * no `.serial` rename needed under R2 of scripts/check-test-isolation.sh.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { ConnectionManager } from '../src/core/connection-manager.ts';

// Minimal duck-typed mock that mimics a `postgres.js` Sql handle for the
// fields ConnectionManager touches during init + disconnect. The real
// postgres.js Sql object has many more members; we only need `.end()`
// for the lifecycle path under test.
function makeMockPool() {
  const endCalls: number[] = [];
  const handle = {
    end: () => {
      endCalls.push(Date.now());
      return Promise.resolve();
    },
  };
  return { handle, endCalls };
}

describe('ConnectionManager — disconnect cancels in-flight init', () => {
  test('orphan pool from racing init is closed, _directPool stays null', async () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
    });

    const { handle, endCalls } = makeMockPool();

    // Build a controllable Promise the spied init returns. We hold the
    // resolver so we can fire it *after* disconnect has run, exercising
    // the exact race the fix addresses.
    let resolveInit!: (pool: unknown) => void;
    const initPromise = new Promise<unknown>((res) => {
      resolveInit = res;
    });

    const initSpy = spyOn(
      cm as unknown as { initDirectPool: () => Promise<unknown> },
      'initDirectPool',
    ).mockImplementation(() => initPromise);

    // Caller starts requesting the direct pool. This kicks initDirectPool
    // and stores the chained Promise in _directInit.
    const callerPromise = (
      cm as unknown as { getDirectPool: () => Promise<unknown> }
    )
      .getDirectPool()
      .then(
        () => 'unexpectedly resolved',
        (err: Error) => err.message,
      );

    // Yield once so the spy actually fires + _directInit gets stored.
    await Promise.resolve();
    expect(
      (cm as unknown as { _directInit: unknown })._directInit,
    ).not.toBeNull();

    // Race: disconnect BEFORE init resolves.
    const disconnectPromise = cm.disconnect();

    // Yield so disconnect runs to its `await pendingInit` point. The
    // init Promise is still pending here, so disconnect parks on it.
    await Promise.resolve();

    // Now let init complete. The .then callback in getDirectPool sees
    // _disconnected === true, calls pool.end() to clean up the orphan,
    // and resolves to null. Disconnect's await pendingInit unblocks
    // and finishes.
    resolveInit(handle);

    await disconnectPromise;
    const callerResult = await callerPromise;

    // (a) The orphan pool got closed — exactly once.
    expect(endCalls).toHaveLength(1);

    // (b) No pool resurrection — _directPool stays null after disconnect.
    expect(
      (cm as unknown as { _directPool: unknown })._directPool,
    ).toBeNull();

    // (c) _directInit is cleared regardless of whether the pool ever
    // landed (pre-fix this was only cleared inside the if-guard).
    expect(
      (cm as unknown as { _directInit: unknown })._directInit,
    ).toBeNull();

    // (d) The original caller surfaced a clean "init returned null" /
    // disconnect error rather than a silently-leaked pool reference.
    expect(callerResult).toMatch(/disconnect|returned null/);

    initSpy.mockRestore();
  });

  test('post-disconnect getDirectPool throws instead of silently re-initializing', async () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
    });

    await cm.disconnect();

    // Without the fix, this would silently call initDirectPool() again
    // and try to bring up a brand-new direct pool against the Supabase
    // URL — a "disconnected" handle springing back to life. The fix
    // makes the contract explicit: post-disconnect, the manager is dead.
    await expect(
      (cm as unknown as { getDirectPool: () => Promise<unknown> }).getDirectPool(),
    ).rejects.toThrow(/disconnect\(\) was called/);
  });

  test('disconnect with no pending init + no pool is still idempotent', async () => {
    // Sanity: the trivial path — disconnect a fresh manager that never
    // initialized a direct pool — still works and remains idempotent.
    const cm = new ConnectionManager({ url: 'postgresql://u:p@localhost:5432/db' });
    await cm.disconnect();
    await cm.disconnect(); // second call must not throw
  });
});
