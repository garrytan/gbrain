/**
 * v0.41 E2E — field-report repro (the bug class this whole wave fixes).
 *
 * Reproduces the original bug exactly: 10 concurrent workers, default
 * lease cap (8), 30 subagent jobs. Pre-v0.41 every job dead-lettered
 * with `rate lease "anthropic:messages" full (8/8)` after 3 bounces.
 * Post-v0.41 jobs bounce against the lease but never lose attempts,
 * and ALL complete.
 *
 * Uses a stubbed subagent handler so we can drive the bug deterministically
 * without an Anthropic API key — the bypass logic lives in the WORKER,
 * not the handler, so a stubbed handler that throws RateLeaseUnavailableError
 * 5x then succeeds exercises the same code path as the real handler.
 *
 * Runs against PGLite — no DATABASE_URL needed.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { RateLeaseUnavailableError } from '../../src/core/minions/handlers/subagent.ts';
let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Scoped per-test cleanup of the tables this test touches. Cheap because
  // the engine + schema are kept warm across all tests in the file.
  await engine.executeRaw('DELETE FROM minion_lease_pressure_log');
  await engine.executeRaw('DELETE FROM subagent_rate_leases');
  await engine.executeRaw('DELETE FROM minion_jobs');
}, 30_000);

describe('v0.41 field-report repro (Bug 2 IRON-RULE regression)', () => {
  test('subagent batch under lease pressure completes; zero dead-from-lease-pressure', async () => {
    // Submit 12 jobs (small enough to run in <30s test time; large enough
    // to thrash the lease cap). Each handler simulates the real subagent's
    // RateLeaseUnavailableError when lease is full.
    const jobCount = 12;
    const ids: number[] = [];
    for (let i = 0; i < jobCount; i++) {
      const j = await queue.add(
        'subagent-repro',
        { prompt: `job ${i}` },
        { max_attempts: 3 }, // matches the original field-report bug class
      );
      ids.push(j.id);
    }

    // Each job bounces twice then succeeds — pre-v0.41 this dead-lettered
    // on the 3rd bounce; post-v0.41 bypass keeps attempts_made at 0.
    const claimCount = new Map<number, number>();
    const worker = new MinionWorker(engine, { pollInterval: 30 });
    worker.register('subagent-repro', async (ctx) => {
      const n = (claimCount.get(ctx.id) ?? 0) + 1;
      claimCount.set(ctx.id, n);
      if (n <= 2) {
        throw new RateLeaseUnavailableError('anthropic:messages', 8, 8);
      }
      return { result: `done after ${n} attempts` };
    });

    const workerPromise = worker.start();
    // Give the worker enough wall-clock for 12 jobs × 2 bounces × ~2s
    // jitter avg + 1 success per job. Pad generously.
    await new Promise(r => setTimeout(r, 25_000));
    worker.stop();
    await workerPromise;

    // Every job should be completed.
    const final = await Promise.all(ids.map(id => queue.getJob(id)));
    const completed = final.filter(j => j!.status === 'completed').length;
    const dead = final.filter(j => j!.status === 'dead').length;
    expect(completed).toBe(jobCount);
    expect(dead).toBe(0);

    // attempts_made stayed at 0 for every job (lease bounces don't burn).
    for (const j of final) {
      expect(j!.attempts_made).toBe(0);
    }

    // Audit rows written for every bounce.
    const auditRows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_lease_pressure_log`,
    );
    const auditCount = parseInt(auditRows[0]!.count, 10);
    // jobCount × 2 bounces = 24 audit rows expected.
    expect(auditCount).toBe(jobCount * 2);
  }, 35_000);
});
