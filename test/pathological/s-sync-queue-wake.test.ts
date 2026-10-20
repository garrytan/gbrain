/**
 * GBRA-133 PR 2a.4: a `gbrain jobs work` worker found a queued sync job only on its next idle poll (5 s,
 * worker.ts), so Phase 1 measured a Postgres single-file commit taking 5.3 to 5.5 s to reach search through a submitted
 * sync job even though the sync itself took about 0.3 s.
 *
 * Protects: a queued `sync` job ends the worker's idle wait. On a detected direct session the worker LISTENs on the
 * `minion_jobs` channel; behind a transaction pooler (PgBouncer, prepare=false) it never LISTENs and polls the sync
 * queue every second instead; PGLite has no resident worker and gets no wake. A wake that lands while the loop is
 * claiming makes the next idle wait a no-op instead of being lost.
 * Fails when: the job waits out the idle poll (the test sets it to 10 minutes, so it never completes), LISTEN is used
 * behind a transaction pooler, or a wake during a claim is dropped. Asserts on the worker's recorded idle waits, never
 * on elapsed time. PGLite always, Postgres when DATABASE_URL is set (the E2E backend matrix also runs it through
 * PgBouncer: GBRAIN_TEST_BACKEND=pgbouncer).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { resolvePrepare } from '../../src/core/db.ts';
import { pathologicalArms } from './harness.ts';

const IDLE_POLL_MS = 600_000;
const until = async (what: string, check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 2_000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('timed out waiting for ' + what);
};

async function withIdleWorker(engine: BrainEngine, run: (w: { worker: MinionWorker; queue: MinionQueue; queueName: string; ran: number[] }) => Promise<void>) {
  const queueName = 'wake-' + randomUUID().slice(0, 8);
  const queue = new MinionQueue(engine);
  const worker = new MinionWorker(engine, { queue: queueName, pollInterval: IDLE_POLL_MS, concurrency: 1, healthCheckInterval: 0 });
  const ran: number[] = [];
  worker.register('sync', async job => { ran.push(job.id); return { ok: true }; });
  const running = worker.start();
  try {
    await until('the worker to go idle', () => (worker as unknown as { idleWaiter?: { idle: boolean } }).idleWaiter?.idle === true);
    await run({ worker, queue, queueName, ran });
  } finally { worker.stop(); await running; }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  /** The E2E backend matrix's PgBouncer pass hands this arm a transaction-pooler URL (it must carry prepare=false). */
  const pooled = databaseUrl !== undefined && resolvePrepare(databaseUrl) === false;
  describe('sync-queue wake for the jobs worker (' + (pooled ? 'pgbouncer' : backend) + ')', () => {
    let engine: BrainEngine;
    beforeAll(async () => {
      if (databaseUrl) { const pg = new PostgresEngine(); await pg.connect({ database_url: databaseUrl, poolSize: 3 }); engine = pg; }
      else { engine = new PGLiteEngine(); await engine.connect({}); }
      await engine.initSchema();
    });
    afterAll(async () => { await engine?.disconnect(); });

    test('a sync job queued beside an idle worker ends its idle wait and runs (no 10-minute poll)', async () => {
      await withIdleWorker(engine, async ({ worker, queue, queueName, ran }) => {
        const { startSyncQueueWake } = await import('../../src/core/minions/sync-queue-wake.ts');
        const lines: string[] = [];
        const wake = await startSyncQueueWake(engine, worker.idleWaiter, { queue: queueName, log: line => lines.push(line) });
        try {
          const expected = backend === 'pglite' ? 'off/not_postgres' : pooled ? 'poll/transaction_pooler' : 'listen/direct_session';
          expect(wake.mode + '/' + wake.reason).toBe(expected);
          // PGLite has no resident worker to wake; its \`jobs work\` drains in the foreground. The primitive still works there.
          const job = await queue.add('sync', { sourceId: 'acme-example', noPull: true }, { queue: queueName });
          if (backend === 'pglite') worker.idleWaiter.wake('test');
          await until('the job to run', () => ran.includes(job.id));
          const ended = worker.idleWaiter.history.filter(w => w.ended === 'wake').map(w => w.reason);
          expect(ended).toContain(backend === 'pglite' ? 'test' : pooled ? 'sync_queue_poll' : 'sync_queue_notify');
          expect(worker.idleWaiter.history.every(w => w.ms === IDLE_POLL_MS)).toBe(true);
          if (wake.mode !== 'off') expect(lines).toEqual(['[gbrain jobs] sync-queue wake: ' + (wake.mode === 'listen' ? 'listen (direct_session)' : 'poll every 1000 ms (transaction_pooler)')]);
        } finally { await wake.stop(); }
      });
    }, 120_000);

    test('a wake that lands while the loop is claiming skips the next idle wait instead of being lost', async () => {
      await withIdleWorker(engine, async ({ worker }) => {
        // The next claim finds nothing, and a notification arrives while it runs (after its SELECT, before the wait).
        const queue = (worker as unknown as { queue: { claim: (...args: unknown[]) => Promise<unknown> } }).queue;
        const claim = queue.claim.bind(queue);
        let claims = 0;
        queue.claim = async (...args: unknown[]) => { const found = await claim(...args); if (claims++ === 0) worker.idleWaiter.wake('during_claim'); return found; };
        const before = worker.idleWaiter.history.length;
        worker.idleWaiter.wake('first');
        await until('two more claims', () => claims >= 2 && worker.idleWaiter.idle);
        expect(worker.idleWaiter.history.slice(before - 1).map(w => [w.ended, w.reason ?? null])).toEqual([['wake', 'first'], ['skipped', null], ['waiting', null]]);
      });
    }, 120_000);

    if (backend !== 'pglite') {
      test('behind a transaction pooler the wake never LISTENs; on a direct session it LISTENs (detection from the connection, not the arm)', async () => {
        const { chooseSyncQueueWake } = await import('../../src/core/minions/sync-queue-wake.ts');
        expect(chooseSyncQueueWake(engine, {}).mode).toBe(pooled ? 'poll' : 'listen');
        expect(chooseSyncQueueWake(engine, { GBRAIN_WORKER_SYNC_WAKE: '0' })).toEqual({ mode: 'off', reason: 'disabled' });
      }, 60_000);
    }
  });
}
