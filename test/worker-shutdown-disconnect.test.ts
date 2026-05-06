/**
 * Tests for the new try/catch around `engine.disconnect()` in
 * MinionWorker.start()'s finally block (worker.ts:425-432).
 *
 * Two cases:
 *   - Happy path: disconnect resolves, worker shuts down cleanly.
 *   - Error path: disconnect rejects, error is logged via console.error
 *     prefixed with "[worker] disconnect failed during shutdown:", and
 *     start() still resolves (no rethrow — shutdown is best-effort).
 *
 * The test instance-patches `engine.disconnect` via `spyOn` — this is
 * object-level monkey-patching (parallel-safe), NOT module-level mocking
 * which R2 of scripts/check-test-isolation.sh forbids in non-serial tests.
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  // The tests below replace engine.disconnect; restore the real one before
  // tearing down so afterAll's disconnect actually closes the pool.
  // spyOn's mockRestore handles this on a per-test basis when called in
  // each test's finally; here we just call the real disconnect best-effort.
  try { await engine.disconnect(); } catch { /* already disconnected */ }
});

describe('MinionWorker shutdown disconnect', () => {
  test('happy path: engine.disconnect is called once during shutdown', async () => {
    const worker = new MinionWorker(engine, { queue: 'test-shutdown-happy', pollInterval: 10 });
    worker.register('noop', async () => ({ ok: true }));

    // Intercept (don't call through) so the shared engine stays connected
    // for the next test in this file. afterAll handles the real disconnect.
    const disconnectSpy = spyOn(engine, 'disconnect').mockImplementation(async () => {});

    setTimeout(() => worker.stop(), 50);
    await worker.start();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    disconnectSpy.mockRestore();
  });

  test('error path: disconnect rejects → logged to stderr, start() still resolves', async () => {
    const worker = new MinionWorker(engine, { queue: 'test-shutdown-error', pollInterval: 10 });
    worker.register('noop', async () => ({ ok: true }));

    const errorSpy = spyOn(console, 'error');
    const disconnectSpy = spyOn(engine, 'disconnect').mockImplementation(
      async () => { throw new Error('boom-test-only'); },
    );

    setTimeout(() => worker.stop(), 50);
    // Must not throw — the catch in worker.ts:431-432 swallows + logs.
    await worker.start();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    // Find the matching log line (other shutdown logs go through the same
    // console.error in this codebase, so we can't assert a single call).
    const calls = errorSpy.mock.calls;
    const matched = calls.find(args =>
      typeof args[0] === 'string'
      && args[0].includes('[worker] disconnect failed during shutdown:'),
    );
    expect(matched).toBeDefined();
    // Second arg should be the thrown Error.
    expect((matched?.[1] as Error)?.message).toBe('boom-test-only');

    disconnectSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
