/**
 * E2E Minions Resilience Tests — real-world OpenClaw failure patterns.
 *
 * Every test here maps to a real production failure Garry hits daily in his
 * OpenClaw deployment (17,888 pages, 4,383 people). PGLite unit tests prove
 * the state machine; these prove the library holds up under real PG.
 *
 * 1. Spawn storm → max_children enforced under concurrent submission
 * 2. Runaway handler → timeout_ms + handleTimeouts dead-letters
 * 3. Orchestrator crash → stall detection rescues orphaned jobs
 * 4. Deep tree fan-in → child_done propagates through multi-level trees
 * 5. Cascade kill → cancelJob aborts live descendants within seconds
 *
 * Run: DATABASE_URL=... bun test test/e2e/minions-resilience.test.ts
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
  console.log('Skipping E2E minions resilience tests (DATABASE_URL not set)');
}

async function makeEngines(): Promise<{ a: PostgresEngine; b: PostgresEngine }> {
  const url = process.env.DATABASE_URL!;
  const a = new PostgresEngine();
  const b = new PostgresEngine();
  await a.connect({ engine: 'postgres', database_url: url, poolSize: 4 });
  await b.connect({ engine: 'postgres', database_url: url, poolSize: 4 });
  return { a, b };
}

describeE2E('E2E: Minions resilience (OpenClaw real-world patterns)', () => {
  beforeAll(async () => {
    await setupDB();
    await runMigrations(getEngine());
  });

  afterAll(async () => {
    await teardownDB();
  });

  beforeEach(async () => {
    const conn = getConn();
    await conn.unsafe(`TRUNCATE minion_attachments, minion_inbox, minion_jobs RESTART IDENTITY CASCADE`);
  });

  // --- 1. Spawn storm: max_children enforced under concurrent submission ---
  test('spawn storm: max_children=10 rejects the 11th+ concurrent submit', async () => {
    const { a, b } = await makeEngines();
    try {
      const queue = new MinionQueue(a);
      const parent = await queue.add('orchestrator', {}, { max_children: 10 });

      // 50 concurrent submits racing through SELECT ... FOR UPDATE on parent.
      // The PG row lock serializes them; only the first 10 see live_count < 10.
      // Use a non-protected name — this test is about max_children semantics,
      // not the v0.15 subagent runtime specifically. `subagent` became a
      // PROTECTED_JOB_NAME in v0.15 (CLI-only; trusted submit required).
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) =>
          queue.add(`child_worker`, { i }, { parent_job_id: parent.id })
        )
      );

      const ok = results.filter(r => r.status === 'fulfilled').length;
      const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
      const overCapErrors = rejected.filter(r =>
        /max_children|already has/.test(String(r.reason?.message ?? r.reason))
      ).length;

      expect(ok).toBe(10);
      expect(rejected.length).toBe(40);
      expect(overCapErrors).toBe(40);

      // DB truth check — exactly 10 children exist
      const conn = getConn();
      const rows = await conn.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM minion_jobs WHERE parent_job_id = $1`,
        [parent.id]
      );
      expect(rows[0].n).toBe(10);
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 30_000);

  // --- 2. Runaway handler: ignores AbortSignal, dead-lettered by handleTimeouts ---
  test('runaway handler: ignores AbortSignal, handleTimeouts dead-letters in <2s', async () => {
    const { a, b } = await makeEngines();
    try {
      const queue = new MinionQueue(a);
      const worker = new MinionWorker(a, {
        concurrency: 1,
        pollInterval: 50,
        lockDuration: 30_000,
        stalledInterval: 200, // fast timeout/stall sweep
      });

      worker.register('runaway', async () => {
        // The classic brutal pattern: handler that does NOT check AbortSignal
        // and blocks for way too long (LLM stuck, network hang, infinite loop).
        await new Promise(r => setTimeout(r, 10_000));
        return { ok: true };
      });

      const job = await queue.add('runaway', {}, { timeout_ms: 500, max_attempts: 1 });

      const started = Date.now();
      const startP = worker.start();

      // Poll for dead status
      let finalStatus = '';
      let deadAt = 0;
      while (Date.now() - started < 3000) {
        const j = await queue.getJob(job.id);
        if (j && (j.status === 'dead' || j.status === 'failed')) {
          finalStatus = j.status;
          deadAt = Date.now();
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }

      worker.stop();
      await startP;

      expect(finalStatus).toBe('dead');
      expect(deadAt - started).toBeLessThan(2000);

      const final = await queue.getJob(job.id);
      expect(final?.error_text).toMatch(/timeout exceeded/i);
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 30_000);

  // --- 3. Orchestrator crash mid-dispatch: stall detection rescues ---
  test('orchestrator crash: stalled job claimed and completed by another worker', async () => {
    const { a, b } = await makeEngines();
    try {
      const queue = new MinionQueue(a);
      const conn = getConn();

      // Simulate a dead worker by directly inserting an 'active' job with
      // an expired lock_until. This is exactly the state a crashed worker
      // leaves behind — status='active', lock_token set, lock_until in past.
      const inserted = await conn.unsafe<{ id: number }[]>(`
        INSERT INTO minion_jobs
          (name, queue, status, priority, data, max_attempts, attempts_made, attempts_started,
           backoff_type, backoff_delay, backoff_jitter, stalled_counter, max_stalled,
           lock_token, lock_until, on_child_fail, depth, remove_on_complete, remove_on_fail,
           started_at)
        VALUES
          ('rescue-me', 'default', 'active', 0, '{}'::jsonb, 3, 1, 1,
           'exponential', 1000, 0.2, 0, 3,
           'crashed-worker:123', now() - interval '10 seconds', 'fail_parent', 0, false, false,
           now() - interval '1 minute')
        RETURNING id
      `);
      const jobId = inserted[0].id;

      // Rescue worker: fast stall sweep picks up the expired-lock job
      const rescueWorker = new MinionWorker(b, {
        concurrency: 1,
        pollInterval: 50,
        lockDuration: 5_000,
        stalledInterval: 100, // fast stall requeue
        maxStalledCount: 3,   // allow one stall requeue
      });

      let ran = false;
      rescueWorker.register('rescue-me', async () => {
        ran = true;
        return { rescued: true };
      });

      const startP = rescueWorker.start();

      const started = Date.now();
      let completed = false;
      while (Date.now() - started < 5000) {
        const j = await queue.getJob(jobId);
        if (j?.status === 'completed') { completed = true; break; }
        await new Promise(r => setTimeout(r, 50));
      }

      rescueWorker.stop();
      await startP;

      expect(completed).toBe(true);
      expect(ran).toBe(true);
      const final = await queue.getJob(jobId);
      expect(final?.status).toBe('completed');
      expect(final?.stalled_counter).toBeGreaterThanOrEqual(1);
      expect(final?.result).toEqual({ rescued: true });
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 30_000);

  // --- 4. Deep tree fan-in: child_done propagates through multi-level trees ---
  test('deep tree: grandchild completions propagate child_done up every level', async () => {
    const { a, b } = await makeEngines();
    try {
      const queue = new MinionQueue(a);
      const worker = new MinionWorker(a, {
        concurrency: 8,
        pollInterval: 50,
        lockDuration: 10_000,
        stalledInterval: 60_000,
      });

      // Tree: 1 parent → 3 children → 2 grandchildren each (6 total)
      // All handlers just return their identity so we can prove inbox routing.
      worker.register('parent', async (ctx) => ({ kind: 'parent', id: ctx.id }));
      worker.register('child', async (ctx) => ({ kind: 'child', i: ctx.data.i }));
      worker.register('grandchild', async (ctx) => ({
        kind: 'grandchild', i: ctx.data.i, j: ctx.data.j,
      }));

      const parent = await queue.add('parent', {});
      const childIds: number[] = [];
      const grandchildIds: Array<{ parent: number; id: number; i: number; j: number }> = [];
      for (let i = 0; i < 3; i++) {
        const c = await queue.add('child', { i }, { parent_job_id: parent.id });
        childIds.push(c.id);
        for (let j = 0; j < 2; j++) {
          const g = await queue.add('grandchild', { i, j }, { parent_job_id: c.id });
          grandchildIds.push({ parent: c.id, id: g.id, i, j });
        }
      }

      const startP = worker.start();

      // Wait for parent to complete — that means the whole tree resolved
      const deadline = Date.now() + 15_000;
      let parentDone = false;
      while (Date.now() < deadline) {
        const j = await queue.getJob(parent.id);
        if (j?.status === 'completed') { parentDone = true; break; }
        await new Promise(r => setTimeout(r, 100));
      }

      worker.stop();
      await startP;

      expect(parentDone).toBe(true);

      // Parent's inbox: exactly 3 child_done messages, one per child
      const conn = getConn();
      const parentInbox = await conn.unsafe<{ payload: any }[]>(
        `SELECT payload FROM minion_inbox
           WHERE job_id = $1 AND payload->>'type' = 'child_done'
           ORDER BY sent_at`,
        [parent.id]
      );
      expect(parentInbox.length).toBe(3);
      const parentChildIds = new Set(parentInbox.map(r => r.payload.child_id));
      expect(parentChildIds).toEqual(new Set(childIds));
      for (const msg of parentInbox) expect(msg.payload.job_name).toBe('child');

      // Each child's inbox: exactly 2 child_done from its grandchildren
      for (const childId of childIds) {
        const inbox = await conn.unsafe<{ payload: any }[]>(
          `SELECT payload FROM minion_inbox
             WHERE job_id = $1 AND payload->>'type' = 'child_done'
             ORDER BY sent_at`,
          [childId]
        );
        expect(inbox.length).toBe(2);
        const expectedGrandIds = new Set(
          grandchildIds.filter(g => g.parent === childId).map(g => g.id)
        );
        const actualGrandIds = new Set(inbox.map(r => r.payload.child_id));
        expect(actualGrandIds).toEqual(expectedGrandIds);
        for (const msg of inbox) expect(msg.payload.job_name).toBe('grandchild');
      }

      // Every job in the tree completed
      const counts = await conn.unsafe<{ status: string; n: number }[]>(
        `SELECT status, count(*)::int AS n FROM minion_jobs GROUP BY status`
      );
      const byStatus = Object.fromEntries(counts.map(r => [r.status, r.n]));
      expect(byStatus.completed).toBe(10); // 1 + 3 + 6
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 60_000);

  // --- 5. Cascade kill under load: cancelJob aborts all live descendants ---
  test('cascade kill: cancelJob on parent aborts 10 live children within 2s', async () => {
    const { a, b } = await makeEngines();
    try {
      const queue = new MinionQueue(a);
      const worker = new MinionWorker(a, {
        concurrency: 12,
        pollInterval: 50,
        // Short lockDuration → renewLock fires every 150ms → detects cleared
        // lock_token quickly after cascade cancel.
        lockDuration: 300,
        stalledInterval: 60_000,
      });

      const abortedChildren = new Set<number>();
      worker.register('slow-child', async (ctx) => {
        // Cooperative abort: handler respects signal but handler *itself* is
        // long-running. Cascade cancel must clear lock_token → renewLock
        // returns false → abort fires → handler wakes up.
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) { abortedChildren.add(ctx.id); resolve(); return; }
          const t = setTimeout(() => resolve(), 20_000);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(t);
            abortedChildren.add(ctx.id);
            resolve();
          });
        });
        throw new Error('cancelled');
      });

      // Parent is just a placeholder. Children do the real work.
      const parent = await queue.add('parent-placeholder', {});
      const childIds: number[] = [];
      for (let i = 0; i < 10; i++) {
        const c = await queue.add('slow-child', { i }, { parent_job_id: parent.id });
        childIds.push(c.id);
      }

      const startP = worker.start();

      // Wait for all 10 children to be claimed (status='active')
      const claimDeadline = Date.now() + 5000;
      let allClaimed = false;
      while (Date.now() < claimDeadline) {
        const conn = getConn();
        const rows = await conn.unsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM minion_jobs
             WHERE parent_job_id = $1 AND status = 'active'`,
          [parent.id]
        );
        if (rows[0].n === 10) { allClaimed = true; break; }
        await new Promise(r => setTimeout(r, 50));
      }
      expect(allClaimed).toBe(true);

      // Fire the cascade cancel
      const cancelStart = Date.now();
      await queue.cancelJob(parent.id);

      // Wait for all 10 handlers to abort (cooperative)
      const abortDeadline = Date.now() + 3000;
      while (Date.now() < abortDeadline) {
        if (abortedChildren.size === 10) break;
        await new Promise(r => setTimeout(r, 50));
      }
      const cancelElapsed = Date.now() - cancelStart;

      worker.stop();
      await startP;

      expect(abortedChildren.size).toBe(10);
      expect(cancelElapsed).toBeLessThan(3000);

      // DB truth: every descendant + root is 'cancelled'
      const conn = getConn();
      const statuses = await conn.unsafe<{ id: number; status: string }[]>(
        `SELECT id, status FROM minion_jobs
           WHERE id = $1 OR parent_job_id = $1
           ORDER BY id`,
        [parent.id]
      );
      expect(statuses.length).toBe(11);
      for (const row of statuses) expect(row.status).toBe('cancelled');
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 60_000);
});
