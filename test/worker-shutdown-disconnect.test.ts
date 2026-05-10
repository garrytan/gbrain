/**
 * Regression guard for engine-ownership invariant on worker shutdown.
 *
 * Earlier waves of this branch experimented with calling
 * `engine.disconnect()` inside `MinionWorker.start()`'s finally block to
 * free PgBouncer pool slots faster on shutdown. That violated engine
 * ownership: the worker doesn't create the engine, it's passed in. Tests
 * that share an engine across multiple worker.start() / worker.stop()
 * cycles (every PGLite-shared E2E + every Postgres test that calls
 * makeEngine() + engine.disconnect() in its own finally) all broke
 * because the engine got disconnected behind their back.
 *
 * Final design (commit 7 of this branch): the worker leaves the engine
 * alone. The CLI handler in src/commands/jobs.ts case 'work' calls
 * engine.disconnect() itself in its own try/finally — the CLI owns the
 * engine, so the CLI disposes of it.
 *
 * This test pins the invariant so future refactors can't silently
 * reintroduce the regression. The check uses spyOn against the engine
 * instance (object-level monkey-patching, parallel-safe) rather than
 * module-level mocking which R2 of scripts/check-test-isolation.sh
 * forbids in non-serial unit tests.
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
  try { await engine.disconnect(); } catch { /* already disconnected */ }
});

describe('MinionWorker engine-ownership invariant', () => {
  test('worker.start() shutdown does NOT call engine.disconnect()', async () => {
    const worker = new MinionWorker(engine, { queue: 'test-no-disconnect', pollInterval: 10 });
    worker.register('noop', async () => ({ ok: true }));

    const disconnectSpy = spyOn(engine, 'disconnect');

    setTimeout(() => worker.stop(), 50);
    await worker.start();

    // Critical invariant: worker leaves engine.disconnect() to its caller.
    expect(disconnectSpy).not.toHaveBeenCalled();
    disconnectSpy.mockRestore();
  });

  test('engine remains usable after worker.start() returns', async () => {
    const worker = new MinionWorker(engine, { queue: 'test-still-usable', pollInterval: 10 });
    worker.register('noop', async () => ({ ok: true }));

    setTimeout(() => worker.stop(), 50);
    await worker.start();

    // Engine must still be connected and queryable. If worker.start()
    // ever disconnects again, this throws "PGLite not connected" and the
    // regression is loud.
    const result = await engine.executeRaw('SELECT 1 as ok');
    expect(result.length).toBe(1);
    expect((result[0] as { ok: number }).ok).toBe(1);
  });
});
