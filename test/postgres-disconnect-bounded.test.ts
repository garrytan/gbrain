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
});
