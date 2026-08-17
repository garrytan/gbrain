/**
 * E2E: verify-before-evict under real Postgres (#4145, CDX-12/R2-5).
 *
 * The hermetic suite (test/worker-lock-renewal.test.ts) proves the tick's
 * state machine, including the fake-time incident replay. These tests prove
 * the DB-level invariants the verify RELIES on, against real Postgres:
 *
 *   1. renewLock revives an expired-but-UNSTOLEN lease (it fences on
 *      lock_token and deliberately does not check lock_until) — the
 *      foundation of the starved-but-ours recovery path.
 *   2. The stall-sweep reclaim grace holds the sweep off a freshly-lapsed
 *      lease (the same-burst self-steal race), while grace=0 restores the
 *      legacy predicate.
 *   3. After a genuine reclaim, the owner's renewal is fenced-false — the
 *      verify's CERTAIN-loss signal — and the requeue burned no attempt.
 *   4. Worker end-to-end: a synchronously-blocked event loop past lease
 *      expiry does NOT evict a healthy job — it completes with zero
 *      stall bounces (the #4145 incident's user-visible contract).
 *
 * A faithful cross-process starvation replay (blocked worker + concurrent
 * foreign sweeper) needs a second OS process and lives out of scope; the
 * hermetic incident replay carries that contract deterministically.
 *
 * Run: DATABASE_URL=... bun test test/e2e/worker-lock-renewal-starvation.test.ts
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
  console.log('Skipping E2E lock-renewal starvation tests (DATABASE_URL not set)');
}

async function makeEngine(): Promise<PostgresEngine> {
  const engine = new PostgresEngine();
  await engine.connect({ engine: 'postgres', database_url: process.env.DATABASE_URL!, poolSize: 4 });
  return engine;
}

/** Synchronously block the event loop — the incident's starvation shape. */
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

describeE2E('E2E: lock-renewal verify-before-evict foundations (#4145)', () => {
  beforeAll(async () => {
    await setupDB();
    await runMigrations(getEngine());
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
  });

  beforeEach(async () => {
    const conn = getConn();
    await conn.unsafe(`TRUNCATE minion_attachments, minion_inbox, minion_jobs RESTART IDENTITY CASCADE`);
  });

  test('renewLock revives an expired-but-unstolen lease; grace holds the sweep; reclaim yields fenced-false', async () => {
    const engine = await makeEngine();
    try {
      const queue = new MinionQueue(engine);
      const job = await queue.add('starve-target', {});
      const claimed = await queue.claim('tok-owner', 60_000, 'default', ['starve-target']);
      expect(claimed?.id).toBe(job.id);

      // Lapse the lease as a starved owner would (2s past — inside the 15s grace).
      await engine.executeRaw(
        `UPDATE minion_jobs SET lock_until = now() - interval '2 seconds' WHERE id = $1`,
        [job.id],
      );

      // (2) The default-grace sweep does NOT steal the freshly-lapsed lease.
      const held = await queue.handleStalled();
      expect(held.requeued).toHaveLength(0);
      expect(held.dead).toHaveLength(0);

      // (1) The owner's (verify) renewal revives the expired-but-unstolen lease.
      const revived = await queue.renewLock(job.id, 'tok-owner', 60_000);
      expect(revived).toBe(true);
      const afterRevive = await queue.getJob(job.id);
      expect(afterRevive!.status).toBe('active');
      expect(afterRevive!.lock_until!.getTime()).toBeGreaterThan(Date.now() + 30_000);

      // Lapse again; grace=0 restores the legacy predicate and reclaims.
      await engine.executeRaw(
        `UPDATE minion_jobs SET lock_until = now() - interval '2 seconds' WHERE id = $1`,
        [job.id],
      );
      const swept = await queue.handleStalled(0);
      expect(swept.requeued).toHaveLength(1);

      // (3) The owner's next renewal is fenced-false — CERTAIN loss — and
      // the infrastructure requeue burned no attempt.
      const fenced = await queue.renewLock(job.id, 'tok-owner', 60_000);
      expect(fenced).toBe(false);
      const requeued = await queue.getJob(job.id);
      expect(requeued!.status).toBe('waiting');
      expect(requeued!.attempts_made).toBe(0);
      expect(requeued!.stalled_counter).toBe(1);
    } finally {
      await engine.disconnect();
    }
  }, 30_000);

  test('worker survives a blocked event loop past lease expiry: job completes, zero stall bounces', async () => {
    const engine = await makeEngine();
    try {
      const queue = new MinionQueue(engine);
      const job = await queue.add('starved-but-healthy', {});

      const worker = new MinionWorker(engine, {
        concurrency: 1,
        pollInterval: 50,
        lockDuration: 1_000, // lease expires DURING the synchronous block
        stalledInterval: 200,
      });
      let blocked = false;
      worker.register('starved-but-healthy', async () => {
        // The incident shape: the process is healthy but the loop is
        // saturated past the entire lease window. No renewal (and no
        // foreign steal — single worker), so the lease lapses; the
        // post-block renewal must recover it rather than evict.
        blockEventLoop(2_500);
        blocked = true;
        return { survived: true };
      });

      const p = worker.start();
      const started = Date.now();
      let completed = false;
      while (Date.now() - started < 10_000) {
        const j = await queue.getJob(job.id);
        if (j?.status === 'completed') { completed = true; break; }
        await new Promise(r => setTimeout(r, 50));
      }
      worker.stop();
      await p;

      expect(blocked).toBe(true);
      expect(completed).toBe(true);
      const final = await queue.getJob(job.id);
      expect(final!.status).toBe('completed');
      expect(final!.result).toEqual({ survived: true });
      // The user-visible #4145 contract: a starved-but-healthy job is not
      // bounced through the stall detector, and no attempt is burned
      // (attempts_made only bumps on failure; one clean claim).
      expect(final!.stalled_counter).toBe(0);
      expect(final!.attempts_made).toBe(0);
      expect(final!.attempts_started).toBe(1);
    } finally {
      await engine.disconnect();
    }
  }, 30_000);
});
