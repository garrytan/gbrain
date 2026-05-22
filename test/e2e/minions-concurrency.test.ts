/**
 * E2E Minions Concurrency Test — Tier 1 (no API keys required)
 *
 * Proves `FOR UPDATE SKIP LOCKED` correctness under real concurrent claim.
 * Two MinionWorker instances on separate connection pools race to claim
 * 20 jobs. Every job must run exactly once: zero double-claims, zero misses.
 *
 * The PGLite unit tests can't verify this — PGLite runs on a single
 * connection so SKIP LOCKED effectively serializes. This test is the only
 * one that exercises real PG-level concurrency.
 *
 * Run: DATABASE_URL=... bun test test/e2e/minions-concurrency.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { runMigrations } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E minions concurrency tests (DATABASE_URL not set)');
}

describeE2E('E2E: Minions concurrent claim (FOR UPDATE SKIP LOCKED)', () => {
  beforeAll(async () => {
    await setupDB();
    // setupDB() runs SCHEMA_SQL but not migrations; bump config.version
    // so MinionQueue.ensureSchema() passes (needs version >= 7).
    await runMigrations(getEngine());
  });

  afterAll(async () => {
    await teardownDB();
  });

  beforeEach(async () => {
    const conn = getConn();
    await conn.unsafe(`TRUNCATE minion_attachments, minion_inbox, minion_jobs RESTART IDENTITY CASCADE`);
  });

  test('2 workers + 20 jobs → exactly 20 unique completions, zero double-claim', async () => {
    const url = process.env.DATABASE_URL!;

    // Two PostgresEngine instances on separate pools so the workers compete
    // through real PG connections (not a shared single connection).
    const engineA = new PostgresEngine();
    const engineB = new PostgresEngine();
    await engineA.connect({ engine: 'postgres', database_url: url, poolSize: 4 });
    await engineB.connect({ engine: 'postgres', database_url: url, poolSize: 4 });

    try {
      // Submit 20 jobs through whichever engine; the queue table is shared
      const submitQueue = new MinionQueue(engineA);
      const submitted: number[] = [];
      for (let i = 0; i < 20; i++) {
        const job = await submitQueue.add('echo', { i });
        submitted.push(job.id);
      }
      expect(submitted.length).toBe(20);

      // Each worker records every job it claims into its own array.
      // If FOR UPDATE SKIP LOCKED fails, the same id will appear in both.
      const claimedByA: number[] = [];
      const claimedByB: number[] = [];

      const handlerA = async (ctx: any) => {
        claimedByA.push(ctx.id);
        await new Promise(r => setTimeout(r, 20));
        return { i: ctx.data.i, by: 'A' };
      };
      const handlerB = async (ctx: any) => {
        claimedByB.push(ctx.id);
        await new Promise(r => setTimeout(r, 20));
        return { i: ctx.data.i, by: 'B' };
      };

      const workerA = new MinionWorker(engineA, {
        concurrency: 4,
        pollInterval: 50,
        lockDuration: 10_000,
        stalledInterval: 60_000,
      });
      const workerB = new MinionWorker(engineB, {
        concurrency: 4,
        pollInterval: 50,
        lockDuration: 10_000,
        stalledInterval: 60_000,
      });

      workerA.register('echo', handlerA);
      workerB.register('echo', handlerB);

      // Start both workers; they race to drain the 20 jobs
      const startA = workerA.start();
      const startB = workerB.start();

      // Poll until all 20 jobs are completed (or timeout safety)
      const deadline = Date.now() + 30_000;
      let done = false;
      while (Date.now() < deadline) {
        const conn = getConn();
        const rows = await conn.unsafe(
          `SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'completed'`
        );
        if (rows[0].n === 20) { done = true; break; }
        await new Promise(r => setTimeout(r, 50));
      }

      workerA.stop();
      workerB.stop();
      await Promise.all([startA, startB]);

      expect(done).toBe(true);

      // Core correctness assertions
      const totalClaimed = claimedByA.length + claimedByB.length;
      expect(totalClaimed).toBe(20);

      const allClaimedIds = [...claimedByA, ...claimedByB];
      const uniqueIds = new Set(allClaimedIds);
      expect(uniqueIds.size).toBe(20); // zero double-claim

      const overlap = claimedByA.filter(id => claimedByB.includes(id));
      expect(overlap.length).toBe(0);

      // Both workers should have done some work (with concurrency=4 each
      // and 20 jobs, neither should have starved)
      expect(claimedByA.length).toBeGreaterThan(0);
      expect(claimedByB.length).toBeGreaterThan(0);

      // Final DB state: every submitted job is completed
      const conn = getConn();
      const completed = await conn.unsafe(
        `SELECT id FROM minion_jobs WHERE status = 'completed' ORDER BY id`
      );
      expect(completed.length).toBe(20);
      expect(completed.map((r: any) => r.id).sort((a: number, b: number) => a - b))
        .toEqual([...submitted].sort((a, b) => a - b));
    } finally {
      await engineA.disconnect();
      await engineB.disconnect();
    }
  }, 60_000);
});
