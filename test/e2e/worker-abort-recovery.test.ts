/**
 * test/e2e/worker-abort-recovery.test.ts — E2E smoke test for worker
 * recovery after handler timeout.
 *
 * Exercises the full path: submit job → handler runs → timeout fires →
 * abort propagates → worker recovers → claims next job.
 *
 * This is the end-to-end regression test for the 2026-04-24 incident
 * where a stuck autopilot-cycle handler wedged the worker with 98 jobs
 * waiting and 0 active.
 *
 * Uses PGLite (in-memory), no external services needed.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('E2E: worker abort recovery (2026-04-24 regression)', () => {
  test('worker recovers from timed-out handler and processes next job', async () => {
    // Step 1: Submit a slow job with a short timeout
    const slowJob = await queue.add('slow-handler', { type: 'slow' }, {
      timeout_ms: 200,
      max_attempts: 1,
    });

    // Step 2: Submit a fast job that should run AFTER the slow one times out
    const fastJob = await queue.add('fast-handler', { type: 'fast' }, {
      max_attempts: 1,
    });

    let slowHandlerAborted = false;
    let fastHandlerExecuted = false;

    const worker = new MinionWorker(engine, {
      pollInterval: 50,
      concurrency: 1, // Single slot — forces sequential execution
    });

    // Slow handler: respects AbortSignal (the fix path)
    worker.register('slow-handler', async (ctx) => {
      // Simulate expensive work (like extract scanning 54K pages)
      while (!ctx.signal.aborted) {
        await new Promise(r => setTimeout(r, 20));
      }
      slowHandlerAborted = true;
      throw ctx.signal.reason || new Error('aborted');
    });

    // Fast handler: just completes
    worker.register('fast-handler', async () => {
      fastHandlerExecuted = true;
      return { done: true };
    });

    // Step 3: Start worker
    const workerPromise = worker.start();

    // Step 4: Wait for slow job timeout (200ms) + handler abort + fast job execution
    await new Promise(r => setTimeout(r, 1000));

    // Step 5: Stop worker
    worker.stop();
    await workerPromise;

    // Step 6: Verify
    expect(slowHandlerAborted).toBe(true);
    expect(fastHandlerExecuted).toBe(true);

    const slowResult = await queue.getJob(slowJob.id);
    expect(slowResult!.status).toBe('dead');

    const fastResult = await queue.getJob(fastJob.id);
    expect(fastResult!.status).toBe('completed');
    expect(fastResult!.result).toEqual({ done: true });
  });

  test('concurrency=2 worker still processes jobs while one slot is timing out', async () => {
    const slowJob = await queue.add('slow-c2', {}, {
      timeout_ms: 200,
      max_attempts: 1,
    });
    const fastJob = await queue.add('fast-c2', {}, { max_attempts: 1 });

    let slowAborted = false;
    let fastDone = false;

    const worker = new MinionWorker(engine, {
      pollInterval: 50,
      concurrency: 2, // Two slots — fast job can run in parallel
    });

    worker.register('slow-c2', async (ctx) => {
      while (!ctx.signal.aborted) {
        await new Promise(r => setTimeout(r, 10));
      }
      slowAborted = true;
      throw new Error('aborted');
    });

    worker.register('fast-c2', async () => {
      fastDone = true;
      return { fast: true };
    });

    const workerPromise = worker.start();
    await new Promise(r => setTimeout(r, 600));
    worker.stop();
    await workerPromise;

    expect(slowAborted).toBe(true);
    expect(fastDone).toBe(true);

    const slowResult = await queue.getJob(slowJob.id);
    expect(slowResult!.status).toBe('dead');

    const fastResult = await queue.getJob(fastJob.id);
    expect(fastResult!.status).toBe('completed');
  });

  test('multiple timeouts in sequence dont permanently wedge worker', async () => {
    // Submit 3 slow jobs that all timeout + 1 fast job
    // The fast job MUST execute
    const slow1 = await queue.add('multi-slow', {}, { timeout_ms: 100, max_attempts: 1 });
    const slow2 = await queue.add('multi-slow', {}, { timeout_ms: 100, max_attempts: 1 });
    const slow3 = await queue.add('multi-slow', {}, { timeout_ms: 100, max_attempts: 1 });
    const fast = await queue.add('multi-fast', {}, { max_attempts: 1 });

    let timeoutsHit = 0;
    let fastDone = false;

    const worker = new MinionWorker(engine, { pollInterval: 50, concurrency: 1 });

    worker.register('multi-slow', async (ctx) => {
      while (!ctx.signal.aborted) {
        await new Promise(r => setTimeout(r, 10));
      }
      timeoutsHit++;
      throw new Error('aborted');
    });

    worker.register('multi-fast', async () => {
      fastDone = true;
      return { ok: true };
    });

    const workerPromise = worker.start();
    // 3 slow jobs × (100ms timeout + overhead) + fast job + margin
    await new Promise(r => setTimeout(r, 2000));
    worker.stop();
    await workerPromise;

    expect(timeoutsHit).toBe(3);
    expect(fastDone).toBe(true);

    const fastResult = await queue.getJob(fast.id);
    expect(fastResult!.status).toBe('completed');
  });
});
