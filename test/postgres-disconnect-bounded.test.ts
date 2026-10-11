/**
 * #1972 — gbrain-owned hard bound on pool teardown.
 *
 * The bug: `pool.end()` against PgBouncer transaction-mode never drains, so
 * disconnect blocked until the CLI's 10s force-exit fired and truncated stdout.
 * postgres.js's own `{ timeout }` is internal (a stub ignores it; it's not a
 * guarantee we own), so `endPoolBounded` wraps every end in a Promise.race we
 * control. These tests assert the bound is real (resolves even when `.end()`
 * never settles) and that we still pass `{ timeout }` so a healthy drain is fast.
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { endPoolBounded, POOL_END_TIMEOUT_SECONDS } from '../src/core/db.ts';

describe('endPoolBounded', () => {
  test('resolves fast when .end() settles quickly, forwarding { timeout }', async () => {
    let calledWith: unknown;
    const pool = { end: async (opts?: { timeout?: number }) => { calledWith = opts; } };
    const t0 = Date.now();
    await endPoolBounded(pool);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(calledWith).toEqual({ timeout: POOL_END_TIMEOUT_SECONDS });
  });

  test('resolves within the gbrain bound even when .end() NEVER settles', async () => {
    // This is the PgBouncer hang: .end() returns a promise that never resolves.
    // The bare `await pool.end()` would hang until the CLI's 10s force-exit.
    const pool = { end: () => new Promise<void>(() => { /* never resolves */ }) };
    const t0 = Date.now();
    await endPoolBounded(pool);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(POOL_END_TIMEOUT_SECONDS * 1000);
    expect(elapsed).toBeLessThan(5000); // well under the CLI's 10s force-exit deadline
  });

  test('never throws when .end() rejects (teardown must not propagate)', async () => {
    const pool = { end: async () => { throw new Error('pool boom'); } };
    await expect(endPoolBounded(pool)).resolves.toBeUndefined();
  });

  // #5332: the guard timer used to be unref'd, so a runtime with nothing else
  // pending dropped it and the await never came back (under `bun test` on
  // Windows the file parked forever). A separate bun process is the only
  // honest witness: it must print the settled line and exit by itself.
  test('a child process awaiting the bound against a never-settling .end() settles and exits on its own (#5332)', async () => {
    const wall = POOL_END_TIMEOUT_SECONDS * 1000 + 10_000;
    const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'helpers', 'end-pool-bounded-probe.ts')], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_NO_BANNER: '1' },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { child.kill(9); } catch { /* already exited */ }
        reject(new Error(`endPoolBounded probe child did not exit within ${wall}ms (#5332)`));
      }, wall);
    });
    try {
      const [stdout, stderr, code] = await Promise.race([
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
        expiry,
      ]);
      expect({ code, stderr }).toMatchObject({ code: 0 });
      const settled = /settled (\d+)/.exec(stdout);
      expect(settled).not.toBeNull();
      expect(Number(settled![1])).toBeGreaterThanOrEqual(POOL_END_TIMEOUT_SECONDS * 1000);
    } finally {
      clearTimeout(timer);
    }
  }, 30_000);
});
