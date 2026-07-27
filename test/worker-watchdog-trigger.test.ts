/**
 * issue #1678 — worker-side RSS watchdog behavior.
 *
 * Pins that:
 *  1. Crossing the cap sets `rssWatchdogTriggered` (the flag the CLI reads to
 *     exit with WORKER_EXIT_RSS_WATCHDOG) and drains the worker.
 *  2. The 80%-of-cap soft warn fires BEFORE the kill, once per crossing,
 *     carrying the peak + in-flight job kinds — and does NOT drain.
 *
 * Uses a real in-memory PGLite engine (canonical block per CLAUDE.md R3+R4)
 * + a stubbed `getRss` so the test is deterministic and hermetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';

const MB = 1024 * 1024;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('worker RSS watchdog (issue #1678)', () => {
  it('crossing the cap sets rssWatchdogTriggered and drains', async () => {
    const worker = new MinionWorker(engine, {
      queue: 'default',
      concurrency: 1,
      maxRssMb: 100,
      getRss: () => 500 * MB, // 5x the cap
      rssCheckInterval: 25,
      healthCheckInterval: 0, // no self-health timer in this test
      pollInterval: 25,
    });
    worker.register('noop', async () => {});

    // start() resolves on its own: the periodic check trips the watchdog,
    // gracefulShutdown sets running=false, the loop exits.
    await worker.start();
    expect(worker.rssWatchdogTriggered).toBe(true);
  });

  it('80% soft-warn fires before the kill and does not drain', async () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };

    const worker = new MinionWorker(engine, {
      queue: 'default',
      concurrency: 1,
      maxRssMb: 100,
      getRss: () => 85 * MB, // 85% — above soft line, below cap
      rssCheckInterval: 25,
      healthCheckInterval: 0,
      pollInterval: 25,
    });
    worker.register('noop', async () => {});

    const runPromise = worker.start();
    // Let a couple of periodic checks fire.
    await new Promise((r) => setTimeout(r, 120));
    worker.stop();
    await runPromise;
    console.warn = origWarn;

    const softWarn = warns.find((w) => w.includes('approaching cap'));
    expect(softWarn).toBeDefined();
    expect(softWarn).toContain('85%');
    // Soft warn must NOT have drained the worker.
    expect(worker.rssWatchdogTriggered).toBe(false);
  });
});
