// Wait discipline: no fixed sleep-waits for async conditions — poll with
// waitFor/waitForValue (helpers/wait-for.ts) against the condition the wait
// exists for (job terminal, handler entered, event emitted). Fixed sleeps
// remain only where the window itself is the contract (negative assertions,
// timestamp separation) and carry an inline justification. Env mutation goes
// through withEnv (helpers/with-env.ts) — never bare process.env writes.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { calculateBackoff } from '../src/core/minions/backoff.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import type { MinionJob } from '../src/core/minions/types.ts';
import { waitFor, waitForValue } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let workerBackedQueue: MinionQueue;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'dead', 'cancelled']);

/** Poll the shared table until job `id` reaches `status` (or any terminal status). */
async function waitForJobStatus(
  id: number,
  status: string | Set<string> = TERMINAL_STATUSES,
  timeoutMs = 5_000,
): Promise<void> {
  const want = typeof status === 'string' ? new Set([status]) : status;
  await waitFor(async () => {
    const j = await queue.getJob(id);
    return j !== null && want.has(j.status);
  }, { timeoutMs, label: `job ${id} → ${[...want].join('|')}` });
}

/** Poll promoteDelayed until it promotes something; returns that batch. */
async function promoteDelayedEventually(): Promise<MinionJob[]> {
  return waitForValue(async () => {
    const promoted = await queue.promoteDelayed();
    return promoted.length > 0 ? promoted : null;
  }, { timeoutMs: 5_000, label: 'promoteDelayed picked up the expired delay' });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
  queue = new MinionQueue(engine);
  const workerBackedEngine = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'kind') return 'postgres';
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
  workerBackedQueue = new MinionQueue(workerBackedEngine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

// --- Queue CRUD (9 tests) ---

describe('MinionQueue: CRUD', () => {
  test('add creates a job with waiting status', async () => {
    const job = await queue.add('sync', { full: true });
    expect(job.name).toBe('sync');
    expect(job.status).toBe('waiting');
    expect(job.data).toEqual({ full: true });
    expect(job.queue).toBe('default');
    expect(job.priority).toBe(0);
    expect(job.max_attempts).toBe(3);
    expect(job.attempts_made).toBe(0);
  });

  test('add with empty name throws', async () => {
    await expect(queue.add('', {})).rejects.toThrow('Job name cannot be empty');
  });

  test('getJob returns job by ID', async () => {
    const created = await queue.add('embed', {});
    const found = await queue.getJob(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.name).toBe('embed');
  });

  test('getJob returns null for missing ID', async () => {
    const found = await queue.getJob(99999);
    expect(found).toBeNull();
  });

  test('getJobs returns all jobs', async () => {
    await queue.add('sync', {});
    await queue.add('embed', {});
    const jobs = await queue.getJobs();
    expect(jobs.length).toBe(2);
  });

  test('getJobs filters by status', async () => {
    await queue.add('sync', {});
    const jobs = await queue.getJobs({ status: 'active' });
    expect(jobs.length).toBe(0);
    const waiting = await queue.getJobs({ status: 'waiting' });
    expect(waiting.length).toBe(1);
  });

  test('removeJob deletes terminal jobs', async () => {
    const job = await queue.add('sync', {});
    // Can't remove waiting job
    const removed = await queue.removeJob(job.id);
    expect(removed).toBe(false);
    // Cancel it first, then remove
    await queue.cancelJob(job.id);
    const removed2 = await queue.removeJob(job.id);
    expect(removed2).toBe(true);
  });

  test('removeJob rejects active jobs', async () => {
    const job = await queue.add('sync', {});
    const removed = await queue.removeJob(job.id);
    expect(removed).toBe(false); // waiting is not terminal
  });

  test('duplicate submit creates new row', async () => {
    const j1 = await queue.add('sync', { full: true });
    const j2 = await queue.add('sync', { full: true });
    expect(j1.id).not.toBe(j2.id);
  });
});

// --- State Machine (6 tests) ---

describe('MinionQueue: State Machine', () => {
  test('waiting → active via claim', async () => {
    const job = await queue.add('sync', {});
    const claimed = await queue.claim('tok1', 30000, 'default', ['sync']);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.status).toBe('active');
    expect(claimed!.lock_token).toBe('tok1');
    expect(claimed!.lock_until).not.toBeNull();
    expect(claimed!.attempts_started).toBe(1);
  });

  test('active → completed via completeJob', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    const completed = await queue.completeJob(job.id, 'tok1', { pages: 42 });
    expect(completed!.status).toBe('completed');
    expect(completed!.result).toEqual({ pages: 42 });
    expect(completed!.lock_token).toBeNull();
    expect(completed!.finished_at).not.toBeNull();
  });

  test('active → failed via failJob', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    const failed = await queue.failJob(job.id, 'tok1', 'timeout', 'dead');
    expect(failed!.status).toBe('dead');
    expect(failed!.error_text).toBe('timeout');
    expect(failed!.attempts_made).toBe(1);
  });

  test('failed → delayed (retry with backoff)', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    const delayed = await queue.failJob(job.id, 'tok1', 'timeout', 'delayed', 5000);
    expect(delayed!.status).toBe('delayed');
    expect(delayed!.delay_until).not.toBeNull();
  });

  test('delayed → waiting (promote)', async () => {
    const job = await queue.add('sync', {}, { delay: 1 }); // 1ms delay
    expect(job.status).toBe('delayed');
    const promoted = await promoteDelayedEventually();
    expect(promoted.length).toBe(1);
    expect(promoted[0].status).toBe('waiting');
    expect(promoted[0].delay_until).toBeNull();
  });

  test('failed → dead (exhausted attempts)', async () => {
    const job = await queue.add('sync', {}, { max_attempts: 1 });
    await queue.claim('tok1', 30000, 'default', ['sync']);
    const failed = await queue.failJob(job.id, 'tok1', 'error', 'dead');
    expect(failed!.status).toBe('dead');
  });
});

// --- Backoff (4 tests) ---

describe('calculateBackoff', () => {
  test('exponential backoff', () => {
    const delay = calculateBackoff({
      backoff_type: 'exponential', backoff_delay: 1000,
      backoff_jitter: 0, attempts_made: 3,
    });
    expect(delay).toBe(4000); // 2^(3-1) * 1000
  });

  test('fixed backoff', () => {
    const delay = calculateBackoff({
      backoff_type: 'fixed', backoff_delay: 2000,
      backoff_jitter: 0, attempts_made: 5,
    });
    expect(delay).toBe(2000);
  });

  test('jitter within range', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 100; i++) {
      delays.add(calculateBackoff({
        backoff_type: 'fixed', backoff_delay: 1000,
        backoff_jitter: 0.5, attempts_made: 1,
      }));
    }
    // Should have some variation
    expect(delays.size).toBeGreaterThan(1);
    // All values should be within [500, 1500]
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1500);
    }
  });

  test('attempts_made=0 edge case (exponential)', () => {
    const delay = calculateBackoff({
      backoff_type: 'exponential', backoff_delay: 1000,
      backoff_jitter: 0, attempts_made: 0,
    });
    // 2^(max(0-1, 0)) * 1000 = 2^0 * 1000 = 1000
    expect(delay).toBe(1000);
  });
});

// --- Stall Detection (3 tests) ---

describe('MinionQueue: Stall Detection', () => {
  test('detect stalled job (lock_until expired)', async () => {
    const job = await queue.add('sync', {});
    // Set max_stalled=2 so first stall requeues (0+1 < 2)
    await engine.executeRaw('UPDATE minion_jobs SET max_stalled = 2 WHERE id = $1', [job.id]);
    await queue.claim('tok1', 30000, 'default', ['sync']);
    // Force lock_until to the past
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id]
    );
    const { requeued, dead } = await queue.handleStalled();
    expect(requeued.length).toBe(1);
    expect(requeued[0].stalled_counter).toBe(1);
    expect(requeued[0].status).toBe('waiting');
  });

  test('stall counter increments and eventually dead-letters', async () => {
    const job = await queue.add('sync', {}, { max_attempts: 3 });
    // Set max_stalled=3 to see multiple requeues before dead
    await engine.executeRaw('UPDATE minion_jobs SET max_stalled = 3 WHERE id = $1', [job.id]);

    // First stall: counter 0+1=1 < 3, requeued
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id]
    );
    const r1 = await queue.handleStalled();
    expect(r1.requeued.length).toBe(1);
    expect(r1.requeued[0].stalled_counter).toBe(1);

    // Second stall: counter 1+1=2 < 3, requeued
    await queue.claim('tok2', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id]
    );
    const r2 = await queue.handleStalled();
    expect(r2.requeued.length).toBe(1);

    // Third stall: counter 2+1=3 >= 3, dead-lettered
    await queue.claim('tok3', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id]
    );
    const r3 = await queue.handleStalled();
    expect(r3.dead.length).toBe(1);
    expect(r3.dead[0].status).toBe('dead');
  });

  test('max_stalled → dead', async () => {
    // max_stalled=0 means first stall = dead immediately (0+1 >= 0 is always true)
    const job = await queue.add('sync', {});
    await engine.executeRaw('UPDATE minion_jobs SET max_stalled = 0 WHERE id = $1', [job.id]);
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id]
    );
    const { requeued, dead } = await queue.handleStalled();
    expect(dead.length).toBe(1);
    expect(dead[0].status).toBe('dead');
    expect(requeued.length).toBe(0);
  });
});

// --- #1737 — honest attempt accounting on terminal dead-letter paths ---

describe('MinionQueue: #1737 attempt accounting on dead-letter', () => {
  test('wall-clock dead-letter increments attempts_made (no more 0/N (started:M))', async () => {
    const job = await queue.add('sync', {}, { max_attempts: 2 });
    // Per-job timeout so the wall-clock threshold is timeout_ms * 2 = 2s.
    await engine.executeRaw('UPDATE minion_jobs SET timeout_ms = 1000 WHERE id = $1', [job.id]);
    await queue.claim('tok1', 30000, 'default', ['sync']);
    expect((await queue.getJob(job.id))!.attempts_made).toBe(0); // bug repro: started but not made

    // Force cumulative wall-clock past timeout_ms * 2.
    await engine.executeRaw(
      "UPDATE minion_jobs SET started_at = now() - interval '10 seconds' WHERE id = $1",
      [job.id]
    );
    const dead = await queue.handleWallClockTimeouts(30000);
    expect(dead.length).toBe(1);
    expect(dead[0].status).toBe('dead');
    expect(dead[0].error_text).toBe('wall-clock timeout exceeded');
    // The fix: a job killed by wall-clock consumed an attempt.
    expect(dead[0].attempts_made).toBe(1);
    // Constraint chk_attempts_order (attempts_made <= attempts_started) holds.
    expect(dead[0].attempts_made).toBeLessThanOrEqual(dead[0].attempts_started);
  });

  test('wall-clock dead-letter is terminal — does NOT retry even with attempts remaining', async () => {
    const job = await queue.add('sync', {}, { max_attempts: 5 });
    await engine.executeRaw('UPDATE minion_jobs SET timeout_ms = 1000 WHERE id = $1', [job.id]);
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET started_at = now() - interval '10 seconds' WHERE id = $1",
      [job.id]
    );
    const dead = await queue.handleWallClockTimeouts(30000);
    expect(dead.length).toBe(1);
    // Even with 4 attempts left, wall-clock is terminal (non-idempotent handler safety).
    expect(dead[0].status).toBe('dead');
    expect(dead[0].status).not.toBe('delayed');
  });

  test('stall dead-letter increments attempts_made; requeue does NOT', async () => {
    const job = await queue.add('sync', {}, { max_attempts: 3 });
    await engine.executeRaw('UPDATE minion_jobs SET max_stalled = 2 WHERE id = $1', [job.id]);

    // First stall: requeued, attempts_made stays 0 (lease-loss recovery, not an app attempt).
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id]
    );
    const r1 = await queue.handleStalled();
    expect(r1.requeued.length).toBe(1);
    expect(r1.requeued[0].attempts_made).toBe(0);

    // Second stall: dead-lettered, attempts_made now increments.
    await queue.claim('tok2', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id]
    );
    const r2 = await queue.handleStalled();
    expect(r2.dead.length).toBe(1);
    expect(r2.dead[0].error_text).toBe('max stalled count exceeded');
    expect(r2.dead[0].attempts_made).toBe(1);
    expect(r2.dead[0].attempts_made).toBeLessThanOrEqual(r2.dead[0].attempts_started);
  });
});

// --- #1737 — per-handler default wall-clock budget at submit ---

describe('MinionQueue: #1737 per-handler default timeout', () => {
  test('long handler with no explicit timeout_ms gets the 30-min default stamped', async () => {
    const job = await workerBackedQueue.add('embed-backfill', { sourceId: 'x' });
    expect(job.timeout_ms).toBe(30 * 60 * 1000);
  });

  test('autopilot-cycle + subagent also get the long default', async () => {
    const cycle = await queue.add('autopilot-cycle', {});
    // subagent is a protected name → needs the trusted-submit flag (4th arg).
    const sub = await queue.add('subagent', {}, undefined, { allowProtectedSubmit: true });
    expect(cycle.timeout_ms).toBe(30 * 60 * 1000);
    expect(sub.timeout_ms).toBe(30 * 60 * 1000);
  });

  // #3207 — facts-absorb is one LLM extraction call per page (same shape as
  // chronicle_extract) but was missing from HANDLER_DEFAULT_TIMEOUT_MS, so it
  // inherited the tight null-default wall-clock and was dead-lettered
  // mid-generation on slow chat providers (facts silently lost).
  test('facts-absorb gets the 10-min LLM-extraction default (#3207)', async () => {
    const job = await queue.add('facts-absorb', { slug: 'people/alice-example' });
    expect(job.timeout_ms).toBe(10 * 60 * 1000);
  });

  test('contextual per-chunk reindex gets the 60-min default', async () => {
    const job = await queue.add('contextual_reindex_per_chunk', { page_slug: 'large-transcript' }, undefined, {
      allowProtectedSubmit: true,
    });
    expect(job.timeout_ms).toBe(60 * 60 * 1000);
  });

  test('explicit timeout_ms always wins over the default', async () => {
    const job = await workerBackedQueue.add('embed-backfill', { sourceId: 'x' }, { timeout_ms: 5000 });
    expect(job.timeout_ms).toBe(5000);
  });

  test('short handler keeps null timeout_ms (tight wall-clock default applies)', async () => {
    const job = await queue.add('sync', {});
    expect(job.timeout_ms).toBeNull();
  });
});

// --- Claim-time budget fallback (jobs fix wave, upstream issue #3) ---
//
// Rows inserted before submit-time stamping existed (or by writers that
// bypass add()) carry timeout_ms = NULL and used to fall to the minutes-scale
// null-default wall-clock sweep. claim() now COALESCEs the budget from
// HANDLER_DEFAULT_TIMEOUT_MS and derives timeout_at from the coalesced value.
// Seeding NULL requires a direct UPDATE because add() stamps at submit.

describe('MinionQueue: claim-time timeout fallback', () => {
  test('legacy NULL-timeout long-handler row gets the map budget stamped at claim', async () => {
    const job = await queue.add('subagent', {}, undefined, { allowProtectedSubmit: true });
    await engine.executeRaw(
      `UPDATE minion_jobs SET timeout_ms = NULL, timeout_at = NULL WHERE id = $1`,
      [job.id],
    );
    const before = Date.now();
    const claimed = await queue.claim('tok-fallback', 30_000, 'default', ['subagent']);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.timeout_ms).toBe(30 * 60 * 1000);
    expect(claimed!.timeout_at).toBeInstanceOf(Date);
    const deadline = claimed!.timeout_at!.getTime();
    // timeout_at ≈ claim time + 30min (generous 60s slop for slow CI).
    expect(deadline).toBeGreaterThan(before + 30 * 60 * 1000 - 60_000);
    expect(deadline).toBeLessThan(before + 30 * 60 * 1000 + 60_000);
    // Persisted, not just returned — a restarted worker sees the same budget.
    const rows = await engine.executeRaw<{ timeout_ms: number | null }>(
      `SELECT timeout_ms FROM minion_jobs WHERE id = $1`, [job.id],
    );
    expect(Number(rows[0].timeout_ms)).toBe(30 * 60 * 1000);
  });

  test('name outside the map keeps NULL budget at claim (fail-open, todays behavior)', async () => {
    const job = await queue.add('noop', {});
    expect(job.timeout_ms).toBeNull();
    const claimed = await queue.claim('tok-nomap', 30_000, 'default', ['noop']);
    expect(claimed).not.toBeNull();
    expect(claimed!.timeout_ms).toBeNull();
    expect(claimed!.timeout_at).toBeNull();
  });

  test('explicit timeout_ms is never overridden at claim', async () => {
    await workerBackedQueue.add('embed-backfill', { sourceId: 'x' }, { timeout_ms: 5000 });
    const claimed = await queue.claim('tok-explicit', 30_000, 'default', ['embed-backfill']);
    expect(claimed).not.toBeNull();
    expect(claimed!.timeout_ms).toBe(5000);
  });
});

// --- v0.13.1 #219 — max_stalled default + input surface ---

describe('MinionQueue: v0.13.1 max_stalled schema default (#219)', () => {
  test('job submitted with no explicit max_stalled uses schema default of 5', async () => {
    const job = await queue.add('noop', {});
    expect(job.max_stalled).toBe(5);
  });

  test('default=5 rescues across 4 consecutive stalls, dead-letters on the 5th', async () => {
    const job = await queue.add('noop', {});
    // Job starts at max_stalled=5 (schema default).
    for (let i = 0; i < 4; i++) {
      await queue.claim(`tok-${i}`, 30000, 'default', ['noop']);
      await engine.executeRaw(
        "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
        [job.id]
      );
      const { requeued, dead } = await queue.handleStalled();
      expect(dead.length).toBe(0);
      expect(requeued.length).toBe(1);
      expect(requeued[0].stalled_counter).toBe(i + 1);
    }
    // 5th stall = dead (5+1 >= 5 = wait, actually handleStalled gate is stalled_counter + 1 >= max_stalled).
    // With stalled_counter now at 4, next stall: 4+1=5 >= 5 = dead.
    await queue.claim('tok-final', 30000, 'default', ['noop']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id]
    );
    const { dead } = await queue.handleStalled();
    expect(dead.length).toBe(1);
    expect(dead[0].status).toBe('dead');
  });
});

describe('MinionQueue: v0.13.1 MinionJobInput.max_stalled plumbing', () => {
  test('honored end-to-end when provided', async () => {
    const job = await queue.add('noop', {}, { max_stalled: 10 });
    expect(job.max_stalled).toBe(10);
  });

  test('clamps input > 100 to 100', async () => {
    const job = await queue.add('noop', {}, { max_stalled: 9999 });
    expect(job.max_stalled).toBe(100);
  });

  test('clamps input < 1 to 1', async () => {
    const job = await queue.add('noop', {}, { max_stalled: 0 });
    expect(job.max_stalled).toBe(1);
  });

  test('clamps negative input to 1', async () => {
    const job = await queue.add('noop', {}, { max_stalled: -5 });
    expect(job.max_stalled).toBe(1);
  });

  test('non-integer inputs are floored before clamp', async () => {
    const job = await queue.add('noop', {}, { max_stalled: 7.9 });
    expect(job.max_stalled).toBe(7);
  });

  test('undefined leaves schema default intact (5)', async () => {
    const job = await queue.add('noop', {}, { max_stalled: undefined });
    expect(job.max_stalled).toBe(5);
  });
});

describe('MinionQueue: v0.13.1 live-queue rescue regression (#219)', () => {
  test('a row at max_stalled=1 is rescued by v13 backfill', async () => {
    // Simulate a pre-v0.13.1 brain that inserted a row at the old default.
    const job = await queue.add('noop', {});
    await engine.executeRaw('UPDATE minion_jobs SET max_stalled = 1 WHERE id = $1', [job.id]);

    // Run the v13 backfill UPDATE directly (matches migrate.ts v13 body).
    await engine.executeRaw(
      `UPDATE minion_jobs SET max_stalled = 5
         WHERE status IN ('waiting','active','delayed','waiting-children','paused')
           AND max_stalled < 5`
    );

    const refetched = await queue.getJob(job.id);
    expect(refetched!.max_stalled).toBe(5);
  });

  test('backfill does not touch terminal-status rows', async () => {
    const job = await queue.add('noop', {});
    // Mark completed and set max_stalled=1 (simulating historical data).
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', max_stalled = 1, finished_at = now() WHERE id = $1`,
      [job.id]
    );

    await engine.executeRaw(
      `UPDATE minion_jobs SET max_stalled = 5
         WHERE status IN ('waiting','active','delayed','waiting-children','paused')
           AND max_stalled < 5`
    );

    const refetched = await queue.getJob(job.id);
    // Terminal rows intentionally untouched; historical data stays as-is.
    expect(refetched!.max_stalled).toBe(1);
  });
});

// --- Dependencies (5 tests) ---

describe('MinionQueue: Dependencies', () => {
  test('parent waits for child', async () => {
    const parent = await queue.add('enrich', {});
    const child = await queue.add('sync', {}, { parent_job_id: parent.id });
    // add() now flips parent to 'waiting-children' atomically; child is 'waiting'.
    const parentAfterAdd = await queue.getJob(parent.id);
    expect(parentAfterAdd!.status).toBe('waiting-children');
    // Parent should NOT resolve while child is waiting
    const resolved = await queue.resolveParent(parent.id);
    expect(resolved).toBeNull();
    // Complete the child directly (skip claim to avoid claim filtering issues)
    await engine.executeRaw(
      "UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1",
      [child.id]
    );
    // Now parent should resolve
    const resolved2 = await queue.resolveParent(parent.id);
    expect(resolved2).not.toBeNull();
    expect(resolved2!.status).toBe('waiting');
  });

  test('child fail → fail_parent', async () => {
    const parent = await queue.add('enrich', {});
    await queue.add('sync', {}, { parent_job_id: parent.id, on_child_fail: 'fail_parent' });
    // add() flipped parent to 'waiting-children' automatically.
    const failed = await queue.failParent(parent.id, 2, 'child died');
    expect(failed!.status).toBe('failed');
    expect(failed!.error_text).toContain('child job');
  });

  test('child fail → continue policy', async () => {
    const parent = await queue.add('enrich', {});
    const child = await queue.add('sync', {}, { parent_job_id: parent.id, on_child_fail: 'continue' });
    // Mark child as dead
    await engine.executeRaw(
      "UPDATE minion_jobs SET status = 'dead' WHERE id = $1",
      [child.id]
    );
    // Parent should resolve (continue ignores child failure)
    const resolved = await queue.resolveParent(parent.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('waiting');
  });

  test('child fail → remove_dep', async () => {
    const parent = await queue.add('enrich', {});
    const child = await queue.add('sync', {}, { parent_job_id: parent.id, on_child_fail: 'remove_dep' });
    await queue.removeChildDependency(child.id);
    const updatedChild = await queue.getJob(child.id);
    expect(updatedChild!.parent_job_id).toBeNull();
  });

  test('orphan handling (parent deleted)', async () => {
    const parent = await queue.add('enrich', {});
    const child = await queue.add('sync', {}, { parent_job_id: parent.id });
    await queue.cancelJob(parent.id);
    await queue.removeJob(parent.id);
    // Child should still exist with parent_job_id = null (ON DELETE SET NULL)
    const orphan = await queue.getJob(child.id);
    expect(orphan).not.toBeNull();
    expect(orphan!.parent_job_id).toBeNull();
  });
});

// --- Worker Lifecycle (5 tests) ---

describe('MinionWorker', () => {
  test('register handler', () => {
    const worker = new MinionWorker(engine);
    worker.register('test', async () => ({ ok: true }));
    expect(worker.registeredNames).toContain('test');
  });

  test('start without handlers throws', async () => {
    const worker = new MinionWorker(engine);
    await expect(worker.start()).rejects.toThrow('No handlers registered');
  });

  test('worker claims and executes job', async () => {
    const job = await queue.add('test-exec', { value: 42 });
    let handlerCalled = false;

    const worker = new MinionWorker(engine, { pollInterval: 50 });
    worker.register('test-exec', async (ctx) => {
      handlerCalled = true;
      expect(ctx.data).toEqual({ value: 42 });
      return { processed: true };
    });

    // Start worker in background, stop once the job lands terminal
    const workerPromise = worker.start();
    await waitForJobStatus(job.id);
    worker.stop();
    await workerPromise;

    expect(handlerCalled).toBe(true);
    const completed = await queue.getJob(job.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.result).toEqual({ processed: true });
  });

  test('handler throws non-Error value', async () => {
    const job = await queue.add('bad-throw', {}, { max_attempts: 1 });

    const worker = new MinionWorker(engine, { pollInterval: 50 });
    worker.register('bad-throw', async () => {
      throw 'string error'; // not an Error instance
    });

    const workerPromise = worker.start();
    await waitForJobStatus(job.id);
    worker.stop();
    await workerPromise;

    const failed = await queue.getJob(job.id);
    expect(failed!.status).toBe('dead');
    expect(failed!.error_text).toBe('string error');
  });

  test('UnrecoverableError bypasses retry', async () => {
    const job = await queue.add('unrecoverable', {}, { max_attempts: 5 });

    const worker = new MinionWorker(engine, { pollInterval: 50 });
    worker.register('unrecoverable', async () => {
      throw new UnrecoverableError('fatal');
    });

    const workerPromise = worker.start();
    await waitForJobStatus(job.id);
    worker.stop();
    await workerPromise;

    const dead = await queue.getJob(job.id);
    expect(dead!.status).toBe('dead');
    expect(dead!.attempts_made).toBe(1); // only 1 attempt, not 5
  });
});

// --- Lock Management (3 tests) ---

describe('MinionQueue: Lock Management', () => {
  test('lock renewed during execution', async () => {
    await queue.add('sync', {});
    const claimed = await queue.claim('tok1', 30000, 'default', ['sync']);
    const originalLockUntil = claimed!.lock_until!.getTime();

    const renewed = await queue.renewLock(claimed!.id, 'tok1', 60000);
    expect(renewed).toBe(true);

    const updated = await queue.getJob(claimed!.id);
    expect(updated!.lock_until!.getTime()).toBeGreaterThan(originalLockUntil);
  });

  test('lock renewal fails with wrong token', async () => {
    await queue.add('sync', {});
    const claimed = await queue.claim('tok1', 30000, 'default', ['sync']);

    const renewed = await queue.renewLock(claimed!.id, 'wrong-token', 60000);
    expect(renewed).toBe(false);
  });

  test('claim sets lock_token, lock_until, attempts_started', async () => {
    await queue.add('sync', {});
    const claimed = await queue.claim('worker-abc', 30000, 'default', ['sync']);
    expect(claimed!.lock_token).toBe('worker-abc');
    expect(claimed!.lock_until).not.toBeNull();
    expect(claimed!.attempts_started).toBe(1);
    expect(claimed!.started_at).not.toBeNull();
  });
});

// --- Claim Mechanics (4 tests) ---

describe('MinionQueue: Claim Mechanics', () => {
  test('claim from empty queue returns null', async () => {
    const claimed = await queue.claim('tok1', 30000, 'default', ['sync']);
    expect(claimed).toBeNull();
  });

  test('claim respects priority ordering', async () => {
    await queue.add('low', {}, { priority: 10 });
    await queue.add('high', {}, { priority: 0 });
    await queue.add('mid', {}, { priority: 5 });

    const first = await queue.claim('tok1', 30000, 'default', ['low', 'high', 'mid']);
    expect(first!.name).toBe('high'); // priority 0 = highest

    const second = await queue.claim('tok2', 30000, 'default', ['low', 'high', 'mid']);
    expect(second!.name).toBe('mid'); // priority 5

    const third = await queue.claim('tok3', 30000, 'default', ['low', 'high', 'mid']);
    expect(third!.name).toBe('low'); // priority 10
  });

  test('claim only claims registered names', async () => {
    await queue.add('sync', {});
    await queue.add('embed', {});

    // Worker only handles 'embed'
    const claimed = await queue.claim('tok1', 30000, 'default', ['embed']);
    expect(claimed!.name).toBe('embed');

    // sync job is still waiting
    const remaining = await queue.getJobs({ status: 'waiting' });
    expect(remaining.length).toBe(1);
    expect(remaining[0].name).toBe('sync');
  });

  test('promote delayed but not future jobs', async () => {
    await queue.add('past', {}, { delay: 1 }); // 1ms delay, will expire quickly
    await queue.add('future', {}, { delay: 999999 }); // way in the future

    const promoted = await promoteDelayedEventually();
    expect(promoted.length).toBe(1);
    expect(promoted[0].name).toBe('past');
  });
});

// --- Prune (1 test) ---

describe('MinionQueue: Prune', () => {
  test('only prunes terminal statuses, respects age filter', async () => {
    const job1 = await queue.add('sync', {});
    const job2 = await queue.add('embed', {});
    await queue.cancelJob(job1.id); // cancelled = terminal
    // job2 stays waiting = not terminal

    const count = await queue.prune({ olderThan: new Date(Date.now() + 86400000) }); // future date = prune everything old enough
    expect(count).toBe(1); // only the cancelled one
  });

  // #2712: --dry-run used to be silently ignored — the destructive default
  // ran and deleted rows while the operator believed they were previewing.
  test('dryRun counts prunable jobs without deleting', async () => {
    const job1 = await queue.add('sync', {});
    await queue.cancelJob(job1.id); // terminal → prunable

    const wouldPrune = await queue.prune({ olderThan: new Date(Date.now() + 86400000), dryRun: true });
    expect(wouldPrune).toBe(1);

    // The row must still exist after a dry run.
    const stillThere = await queue.getJob(job1.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.status).toBe('cancelled');

    // A real prune afterwards actually deletes it.
    const pruned = await queue.prune({ olderThan: new Date(Date.now() + 86400000) });
    expect(pruned).toBe(1);
    expect(await queue.getJob(job1.id)).toBeNull();
  });
});

// --- Stats (1 test) ---

describe('MinionQueue: Stats', () => {
  test('getStats returns status breakdown', async () => {
    await queue.add('sync', {});
    await queue.add('embed', {});
    const stats = await queue.getStats();
    expect(stats.by_status['waiting']).toBe(2);
    expect(stats.queue_health.waiting).toBe(2);
    expect(stats.queue_health.active).toBe(0);
  });
});

// --- Cancel and Retry (2 tests) ---

describe('MinionQueue: Cancel & Retry', () => {
  test('cancel active job sets cancelled', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    const cancelled = await queue.cancelJob(job.id);
    expect(cancelled!.status).toBe('cancelled');
  });

  test('retry dead job re-queues', async () => {
    const job = await queue.add('sync', {}, { max_attempts: 1 });
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await queue.failJob(job.id, 'tok1', 'error', 'dead');
    const retried = await queue.retryJob(job.id);
    expect(retried!.status).toBe('waiting');
    expect(retried!.error_text).toBeNull();
  });

  // #2783: retry must reset started_at/attempts_made/attempts_started/
  // stalled_counter — an explicit `jobs retry` is an operator asserting
  // "run this fresh".
  test('retry resets started_at/attempts_made/attempts_started/stalled_counter', async () => {
    const job = await queue.add('sync', {}, { max_attempts: 3, max_stalled: 3 });
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await queue.failJob(job.id, 'tok1', 'error', 'dead');
    // Simulate the original claim having stamped started_at long ago,
    // attempts already elevated, and a near-exhausted stall budget —
    // matching what a real dead job (killed by wall-clock OR by stall
    // exhaustion) looks like.
    await engine.executeRaw(
      "UPDATE minion_jobs SET started_at = now() - interval '1 hour', stalled_counter = 2 WHERE id = $1",
      [job.id],
    );
    const retried = await queue.retryJob(job.id);
    expect(retried!.status).toBe('waiting');
    expect(retried!.started_at).toBeNull();
    expect(retried!.attempts_made).toBe(0);
    expect(retried!.attempts_started).toBe(0);
    expect(retried!.stalled_counter).toBe(0);
  });

  // #2783 repro: retry issued long after the original claim must NOT be
  // immediately dead-lettered by the wall-clock sweep on re-claim.
  test('retry survives handleWallClockTimeouts after re-claim, even long after the original attempt', async () => {
    const job = await queue.add('sync', {}, { max_attempts: 3 });
    await engine.executeRaw('UPDATE minion_jobs SET timeout_ms = 1000 WHERE id = $1', [job.id]);
    await queue.claim('tok1', 30000, 'default', ['sync']);
    // Original attempt dies from a wall-clock timeout — matches the issue's
    // repro (an outage that outlasts timeout_ms).
    await engine.executeRaw(
      "UPDATE minion_jobs SET started_at = now() - interval '10 seconds' WHERE id = $1",
      [job.id],
    );
    const firstDead = await queue.handleWallClockTimeouts(30000);
    expect(firstDead.length).toBe(1);
    expect(firstDead[0].status).toBe('dead');

    // Outage clears; operator retries — LONG after the original claim time
    // (this is the exact scenario that used to dead-letter in <1s: without
    // the fix, started_at would still be the original claim's timestamp).
    await queue.retryJob(job.id);
    const reclaimed = await queue.claim('tok2', 30000, 'default', ['sync']);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.attempts_made).toBe(0);

    // The sweep must NOT kill it immediately this time — started_at was
    // re-stamped fresh on re-claim (claim()'s COALESCE(started_at, now())).
    const stillAlive = await queue.handleWallClockTimeouts(30000);
    expect(stillAlive.length).toBe(0);
    expect((await queue.getJob(job.id))!.status).toBe('active');
  });

  // #2783 repro (stall side): a job dead-lettered by stall exhaustion must
  // get a fresh stall budget on retry, not immediately re-die on its first
  // stall after being re-claimed.
  test('retry survives one stall after re-claim, even after the original stall budget was exhausted', async () => {
    const job = await queue.add('sync', {}, { max_attempts: 3, max_stalled: 2 });

    // Exhaust the stall budget the same way the existing stall test does:
    // one requeue stall, then one dead-lettering stall.
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id],
    );
    await queue.handleStalled();
    await queue.claim('tok2', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id],
    );
    const r2 = await queue.handleStalled();
    expect(r2.dead.length).toBe(1);
    expect(r2.dead[0].status).toBe('dead');
    expect(r2.dead[0].stalled_counter).toBe(2); // == max_stalled — exhausted

    // Operator retries. Without the stalled_counter reset, the very next
    // stall would immediately satisfy `stalled_counter + 1 >= max_stalled`
    // and dead-letter again despite "run this fresh".
    const retried = await queue.retryJob(job.id);
    expect(retried!.stalled_counter).toBe(0);
    await queue.claim('tok3', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1",
      [job.id],
    );
    const r3 = await queue.handleStalled();
    expect(r3.requeued.length).toBe(1); // fresh budget — requeued, not dead
    expect(r3.dead.length).toBe(0);
  });
});

// --- Pause / Resume (5 tests) ---

describe('MinionQueue: Pause/Resume', () => {
  test('pause waiting job → paused', async () => {
    const job = await queue.add('sync', {});
    const paused = await queue.pauseJob(job.id);
    expect(paused!.status).toBe('paused');
  });

  test('pause active job clears lock', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    const paused = await queue.pauseJob(job.id);
    expect(paused!.status).toBe('paused');
    expect(paused!.lock_token).toBeNull();
    expect(paused!.lock_until).toBeNull();
  });

  test('pause completed job returns null', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await queue.completeJob(job.id, 'tok1');
    const paused = await queue.pauseJob(job.id);
    expect(paused).toBeNull();
  });

  test('resume paused job → waiting', async () => {
    const job = await queue.add('sync', {});
    await queue.pauseJob(job.id);
    const resumed = await queue.resumeJob(job.id);
    expect(resumed!.status).toBe('waiting');
  });

  test('resume non-paused job returns null', async () => {
    const job = await queue.add('sync', {});
    const resumed = await queue.resumeJob(job.id);
    expect(resumed).toBeNull();
  });
});

// --- Inbox (6 tests) ---

describe('MinionQueue: Inbox', () => {
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM minion_inbox');
  });

  test('send message to active job from admin', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    const msg = await queue.sendMessage(job.id, { directive: 'focus on X' }, 'admin');
    expect(msg).not.toBeNull();
    expect(msg!.sender).toBe('admin');
    expect(msg!.payload).toEqual({ directive: 'focus on X' });
    expect(msg!.read_at).toBeNull();
  });

  test('send message from parent job succeeds', async () => {
    const parent = await queue.add('orchestrate', {});
    // Create child directly with waiting status so it's claimable
    const childRows = await engine.executeRaw<Record<string, unknown>>(
      `INSERT INTO minion_jobs (name, queue, status, data, parent_job_id)
       VALUES ('research', 'default', 'waiting', '{}', $1) RETURNING *`,
      [parent.id]
    );
    const childId = childRows[0].id as number;
    await queue.claim('tok1', 30000, 'default', ['research']);
    const msg = await queue.sendMessage(childId, { hint: 'dig deeper' }, String(parent.id));
    expect(msg).not.toBeNull();
  });

  test('send message from unauthorized sender returns null', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    const msg = await queue.sendMessage(job.id, { hack: true }, 'rogue-agent');
    expect(msg).toBeNull();
  });

  test('send message to completed job returns null', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await queue.completeJob(job.id, 'tok1');
    const msg = await queue.sendMessage(job.id, { too: 'late' }, 'admin');
    expect(msg).toBeNull();
  });

  test('readInbox returns unread messages and marks read', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await queue.sendMessage(job.id, { msg: 1 }, 'admin');
    await queue.sendMessage(job.id, { msg: 2 }, 'admin');

    const messages = await queue.readInbox(job.id, 'tok1');
    expect(messages).toHaveLength(2);
    expect(messages[0].payload).toEqual({ msg: 1 });
    expect(messages[0].read_at).not.toBeNull();

    // Second read returns empty (all marked read)
    const empty = await queue.readInbox(job.id, 'tok1');
    expect(empty).toHaveLength(0);
  });

  test('readInbox with wrong token returns empty', async () => {
    const job = await queue.add('sync', {});
    await queue.claim('tok1', 30000, 'default', ['sync']);
    await queue.sendMessage(job.id, { msg: 1 }, 'admin');

    const messages = await queue.readInbox(job.id, 'wrong-token');
    expect(messages).toHaveLength(0);
  });
});

// --- Token Accounting (4 tests) ---

describe('MinionQueue: Token Accounting', () => {
  test('updateTokens accumulates counts', async () => {
    const job = await queue.add('agent', {});
    await queue.claim('tok1', 30000, 'default', ['agent']);

    await queue.updateTokens(job.id, 'tok1', { input: 100, output: 50 });
    await queue.updateTokens(job.id, 'tok1', { input: 200, output: 100, cache_read: 50 });

    const updated = await queue.getJob(job.id);
    expect(updated!.tokens_input).toBe(300);
    expect(updated!.tokens_output).toBe(150);
    expect(updated!.tokens_cache_read).toBe(50);
  });

  test('updateTokens with wrong token returns false', async () => {
    const job = await queue.add('agent', {});
    await queue.claim('tok1', 30000, 'default', ['agent']);
    const result = await queue.updateTokens(job.id, 'wrong', { input: 100 });
    expect(result).toBe(false);
  });

  test('completeJob rolls up tokens to parent', async () => {
    const parent = await queue.add('orchestrate', {});
    // add() now correctly inserts child as 'waiting' and flips parent to 'waiting-children'.
    const child = await queue.add('research', {}, { parent_job_id: parent.id });
    await queue.claim('tok1', 30000, 'default', ['research']);
    await queue.updateTokens(child.id, 'tok1', { input: 500, output: 200 });
    await queue.completeJob(child.id, 'tok1', { done: true });

    const parentJob = await queue.getJob(parent.id);
    expect(parentJob!.tokens_input).toBe(500);
    expect(parentJob!.tokens_output).toBe(200);
  });

  test('new jobs start with zero tokens', async () => {
    const job = await queue.add('sync', {});
    expect(job.tokens_input).toBe(0);
    expect(job.tokens_output).toBe(0);
    expect(job.tokens_cache_read).toBe(0);
  });
});

// --- Job Replay (4 tests) ---

describe('MinionQueue: Replay', () => {
  test('replay completed job creates new job', async () => {
    const job = await queue.add('research', { topic: 'AI' }, { priority: 5 });
    await queue.claim('tok1', 30000, 'default', ['research']);
    await queue.completeJob(job.id, 'tok1', { result: 'done' });

    const replay = await queue.replayJob(job.id);
    expect(replay).not.toBeNull();
    expect(replay!.id).not.toBe(job.id);
    expect(replay!.name).toBe('research');
    expect(replay!.data).toEqual({ topic: 'AI' });
    expect(replay!.status).toBe('waiting');
    expect(replay!.priority).toBe(5);
    expect(replay!.attempts_made).toBe(0);
  });

  test('replay with data override merges data', async () => {
    const job = await queue.add('research', { topic: 'AI', depth: 'shallow' });
    await queue.claim('tok1', 30000, 'default', ['research']);
    await queue.completeJob(job.id, 'tok1');

    const replay = await queue.replayJob(job.id, { depth: 'deep', focus: 'revenue' });
    expect(replay!.data).toEqual({ topic: 'AI', depth: 'deep', focus: 'revenue' });
  });

  test('replay non-terminal job returns null', async () => {
    const job = await queue.add('sync', {});
    const replay = await queue.replayJob(job.id);
    expect(replay).toBeNull();
  });

  test('replay nonexistent job returns null', async () => {
    const replay = await queue.replayJob(99999);
    expect(replay).toBeNull();
  });
});

// --- Concurrent Worker (3 tests) ---

describe('MinionWorker: Concurrent', () => {
  test('worker provides AbortSignal in context', async () => {
    let receivedSignal: AbortSignal | null = null;
    const job = await queue.add('test-signal', {});

    const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 100 });
    worker.register('test-signal', async (ctx) => {
      receivedSignal = ctx.signal;
      return { ok: true };
    });

    const p = worker.start();
    await waitForJobStatus(job.id);
    worker.stop();
    await p;

    expect(receivedSignal).not.toBeNull();
    expect(receivedSignal!.aborted).toBe(false);
  });

  test('worker provides readInbox in context', async () => {
    let hasReadInbox = false;
    const job = await queue.add('test-inbox', {});

    const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 100 });
    worker.register('test-inbox', async (ctx) => {
      hasReadInbox = typeof ctx.readInbox === 'function';
      return { ok: true };
    });

    const p = worker.start();
    await waitForJobStatus(job.id);
    worker.stop();
    await p;

    expect(hasReadInbox).toBe(true);
  });

  test('worker provides updateTokens in context', async () => {
    let hasUpdateTokens = false;
    const job = await queue.add('test-tokens', {});

    const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 100 });
    worker.register('test-tokens', async (ctx) => {
      hasUpdateTokens = typeof ctx.updateTokens === 'function';
      return { ok: true };
    });

    const p = worker.start();
    await waitForJobStatus(job.id);
    worker.stop();
    await p;

    expect(hasUpdateTokens).toBe(true);
  });
});

// --- v7 Behavior tests (closes existing GAP coverage) ---

describe('MinionWorker: v7 Behavior', () => {
  test('pause flips ctx.signal.aborted mid-handler', async () => {
    const job = await queue.add('pause-test', {});
    let signalSeenAborted = false;
    let handlerEntered = false;
    let handlerExited = false;

    const worker = new MinionWorker(engine, {
      concurrency: 1,
      pollInterval: 50,
      lockDuration: 200, // short so renewLock fires quickly
    });
    worker.register('pause-test', async (ctx) => {
      handlerEntered = true;
      // Wait until aborted, polling the signal
      const start = Date.now();
      while (!ctx.signal.aborted && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 25));
      }
      signalSeenAborted = ctx.signal.aborted;
      handlerExited = true;
      throw new Error('aborted');
    });

    const p = worker.start();
    // Wait for handler to enter
    await waitFor(() => handlerEntered, { timeoutMs: 5_000, label: 'pause-test handler entry' });
    expect(handlerEntered).toBe(true);
    // Pause clears the lock token; next renewLock fails → abort fires
    await queue.pauseJob(job.id);
    // renewLock cadence is lockDuration / 2 = 100ms; wait for the handler to
    // observe the abort (or give up at its internal 2s budget) and exit.
    await waitFor(() => handlerExited, { timeoutMs: 5_000, label: 'pause-test handler exit' });
    worker.stop();
    await p;

    expect(signalSeenAborted).toBe(true);
  });

  test('catch block skips failJob when ctx.signal.aborted', async () => {
    const job = await queue.add('skip-fail', {}, { max_attempts: 5 });
    let handlerEntered = false;
    let handlerExited = false;

    const worker = new MinionWorker(engine, {
      concurrency: 1,
      pollInterval: 50,
      lockDuration: 200,
    });
    worker.register('skip-fail', async (ctx) => {
      handlerEntered = true;
      // Wait for abort, then throw — failJob should NOT be called
      const start = Date.now();
      while (!ctx.signal.aborted && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 25));
      }
      handlerExited = true;
      throw new Error('after-abort');
    });

    const p = worker.start();
    // Pause only after the handler holds the job — pausing a still-waiting
    // row would skip the catch path entirely.
    await waitFor(() => handlerEntered, { timeoutMs: 5_000, label: 'skip-fail handler entry' });
    await queue.pauseJob(job.id);
    await waitFor(() => handlerExited, { timeoutMs: 5_000, label: 'skip-fail handler exit' });
    worker.stop();
    await p;

    const final = await queue.getJob(job.id);
    // If failJob ran, status would be 'delayed' (retry) or 'dead'.
    // We expect 'paused' to stick — the catch block bailed out.
    expect(final!.status).toBe('paused');
    expect(final!.attempts_made).toBe(0);
    expect(final!.error_text).toBeNull();
  });

  test('worker tracks 3 in-flight jobs (bookkeeping, not PG concurrency)', async () => {
    // Submit 3 jobs and have each handler block on a barrier we control.
    for (let i = 0; i < 3; i++) {
      await queue.add('barrier', { i });
    }

    let release: () => void = () => {};
    const releasePromise = new Promise<void>(r => { release = r; });
    let entered = 0;

    const worker = new MinionWorker(engine, {
      concurrency: 3,
      pollInterval: 25,
      lockDuration: 60000, // long so locks don't expire during the test
    });
    worker.register('barrier', async () => {
      entered++;
      await releasePromise;
      return { ok: true };
    });

    const p = worker.start();
    // Wait for all 3 handlers to enter
    await waitFor(() => entered >= 3, { timeoutMs: 15_000, label: 'barrier handlers entered' });
    expect(entered).toBe(3);

    // While blocked, all 3 jobs should be active in DB
    const active = await queue.getJobs({ status: 'active' });
    expect(active.length).toBe(3);

    // Release all handlers, let worker complete them
    release();
    await waitFor(async () => (await queue.getJobs({ status: 'completed' })).length >= 3, {
      timeoutMs: 5_000, label: 'barrier jobs completed',
    });
    worker.stop();
    await p;

    const completed = await queue.getJobs({ status: 'completed' });
    expect(completed.length).toBe(3);
  });

  test('setTimeout safety net cleared on normal completion (no leaked timer)', async () => {
    // Job has a long timeout_ms; if cleared properly, abort never fires.
    const job = await queue.add('quick', {}, { timeout_ms: 5000 });

    let abortFired = false;
    const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 50 });
    worker.register('quick', async (ctx) => {
      ctx.signal.addEventListener('abort', () => { abortFired = true; });
      // Complete fast — timer should be cleared in .finally
      return { quick: true };
    });

    const p = worker.start();
    await waitForJobStatus(job.id);
    worker.stop();
    await p;

    const completed = await queue.getJob(job.id);
    expect(completed!.status).toBe('completed');
    // Wait beyond the timeout window to confirm the timer was cleared.
    // Genuinely time-based negative check (a leaked timer fires on wall
    // clock; there is nothing to poll) — the fixed window stays.
    await new Promise(r => setTimeout(r, 200));
    expect(abortFired).toBe(false);
  });

  test('setTimeout safety net fires abort when handler stalls', async () => {
    const job = await queue.add('slow', {}, {
      timeout_ms: 100,
      max_attempts: 1,
    });

    let abortFired = false;
    const worker = new MinionWorker(engine, {
      concurrency: 1,
      pollInterval: 50,
      lockDuration: 60000, // don't let stall path interfere
    });
    worker.register('slow', async (ctx) => {
      ctx.signal.addEventListener('abort', () => { abortFired = true; });
      // Stall past timeout_ms: hold until the safety-net timer aborts us
      // (deadline-bounded poll instead of a fixed oversleep).
      await waitFor(() => ctx.signal.aborted, { timeoutMs: 5_000, label: 'safety-net abort' });
      // After abort fires, throwing here goes through the catch — but
      // catch sees signal.aborted and skips failJob.
      throw new Error('should-be-aborted');
    });

    const p = worker.start();
    await waitFor(() => abortFired, { timeoutMs: 6_000, label: 'safety-net abort observed' });
    worker.stop();
    await p;

    expect(abortFired).toBe(true);
  });
});

// --- v7 Token rollup guard ---

describe('MinionQueue: Token rollup guard', () => {
  test('token rollup is no-op when parent already terminal', async () => {
    const parent = await queue.add('orchestrate', {});
    const child = await queue.add('research', {}, { parent_job_id: parent.id });

    // Force parent to a terminal state out-of-band
    await engine.executeRaw(
      "UPDATE minion_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1",
      [parent.id]
    );

    await queue.claim('tok1', 30000, 'default', ['research']);
    await queue.updateTokens(child.id, 'tok1', { input: 1000, output: 500 });
    await queue.completeJob(child.id, 'tok1');

    // Parent stays terminal with zero tokens (rollup guard skipped it)
    const parentAfter = await queue.getJob(parent.id);
    expect(parentAfter!.status).toBe('cancelled');
    expect(parentAfter!.tokens_input).toBe(0);
    expect(parentAfter!.tokens_output).toBe(0);
  });
});

// --- v7 Inbox cascade on parent delete ---

describe('MinionQueue: Inbox cascade', () => {
  test('inbox messages cascade-deleted when parent job deleted', async () => {
    const job = await queue.add('agent', {});
    await queue.claim('tok1', 30000, 'default', ['agent']);
    await queue.sendMessage(job.id, { hint: 1 }, 'admin');
    await queue.sendMessage(job.id, { hint: 2 }, 'admin');

    const before = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text as count FROM minion_inbox WHERE job_id = $1`,
      [job.id]
    );
    expect(parseInt(before[0].count, 10)).toBe(2);

    // Cancel + remove the job
    await queue.cancelJob(job.id);
    await queue.removeJob(job.id);

    const after = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text as count FROM minion_inbox WHERE job_id = $1`,
      [job.id]
    );
    expect(parseInt(after[0].count, 10)).toBe(0);
  });
});

// --- v7 Depth tracking ---

describe('MinionQueue: Depth tracking', () => {
  test('depth increments 0 → 1 → 2', async () => {
    const root = await queue.add('a', {});
    expect(root.depth).toBe(0);

    const child = await queue.add('b', {}, { parent_job_id: root.id });
    expect(child.depth).toBe(1);

    const grandchild = await queue.add('c', {}, { parent_job_id: child.id });
    expect(grandchild.depth).toBe(2);
  });

  test('depth exceeding maxSpawnDepth rejected', async () => {
    const tightQueue = new MinionQueue(engine, { maxSpawnDepth: 2 });
    const root = await tightQueue.add('a', {});
    const c1 = await tightQueue.add('b', {}, { parent_job_id: root.id });
    const c2 = await tightQueue.add('c', {}, { parent_job_id: c1.id });
    expect(c2.depth).toBe(2);
    // Next level (depth=3) exceeds maxSpawnDepth=2
    await expect(tightQueue.add('d', {}, { parent_job_id: c2.id }))
      .rejects.toThrow(/spawn depth 3 exceeds maxSpawnDepth 2/);
  });

  test('per-submit max_spawn_depth override works', async () => {
    const root = await queue.add('a', {});
    // maxSpawnDepth defaults to 5, but we override per-submit to 0
    await expect(queue.add('b', {}, { parent_job_id: root.id, max_spawn_depth: 0 }))
      .rejects.toThrow(/spawn depth 1 exceeds maxSpawnDepth 0/);
  });
});

// --- v7 max_children cap ---

describe('MinionQueue: max_children', () => {
  test('max_children=NULL means unlimited', async () => {
    const parent = await queue.add('orchestrate', {}); // max_children null by default
    for (let i = 0; i < 10; i++) {
      const child = await queue.add('research', { i }, { parent_job_id: parent.id });
      expect(child.id).toBeGreaterThan(0);
    }
    const kids = await queue.getJobs({ name: 'research' });
    expect(kids.length).toBe(10);
  });

  test('max_children=N rejects N+1th submit', async () => {
    const parent = await queue.add('orchestrate', {}, { max_children: 2 });
    await queue.add('a', {}, { parent_job_id: parent.id });
    await queue.add('b', {}, { parent_job_id: parent.id });
    await expect(queue.add('c', {}, { parent_job_id: parent.id }))
      .rejects.toThrow(/already has 2 live children \(max_children=2\)/);
  });

  test('terminal children do not count toward max_children', async () => {
    const parent = await queue.add('orchestrate', {}, { max_children: 1 });
    const child = await queue.add('a', {}, { parent_job_id: parent.id });
    // Mark child completed → frees the slot
    await engine.executeRaw(
      "UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1",
      [child.id]
    );
    // Now we can add another child
    const c2 = await queue.add('b', {}, { parent_job_id: parent.id });
    expect(c2.id).toBeGreaterThan(0);
  });
});

// --- v7 timeout_ms ---

describe('MinionQueue: handleTimeouts', () => {
  test('claim populates timeout_at when timeout_ms set', async () => {
    await queue.add('slow', {}, { timeout_ms: 5000 });
    const claimed = await queue.claim('tok1', 30000, 'default', ['slow']);
    expect(claimed!.timeout_at).not.toBeNull();
    expect(claimed!.timeout_at!.getTime()).toBeGreaterThan(Date.now());
  });

  test('handleTimeouts dead-letters expired active jobs', async () => {
    const job = await queue.add('slow', {}, { timeout_ms: 50 });
    await queue.claim('tok1', 30000, 'default', ['slow']);
    // Sweep until the 50ms timeout_at lapses and the eviction lands
    const timedOut = await waitForValue(async () => {
      const killed = await queue.handleTimeouts();
      return killed.length > 0 ? killed : null;
    }, { timeoutMs: 5_000, label: 'handleTimeouts eviction' });
    expect(timedOut.length).toBe(1);
    expect(timedOut[0].id).toBe(job.id);

    const dead = await queue.getJob(job.id);
    expect(dead!.status).toBe('dead');
    expect(dead!.error_text).toBe('timeout exceeded');
    // #1737 regression: the timed-out run counts as a spent attempt, mirroring
    // the wall-clock + stall dead-letter paths. Without this the job reads
    // `attempts: 0/N (started: N)`. Asserted on both the RETURNING row and the
    // persisted row so a future refactor can't silently drop the increment.
    expect(timedOut[0].attempts_made).toBe(1);
    expect(dead!.attempts_made).toBe(1);
  });

  test('handleTimeouts ignores stalled jobs (lock_until > now guard)', async () => {
    // Force a stalled job: timeout_at expired AND lock_until expired
    await queue.add('slow', {}, { timeout_ms: 50 });
    const claimed = await queue.claim('tok1', 1, 'default', ['slow']); // 1ms lock duration → expires immediately
    // Both deadlines must lapse before the negative sweep check is meaningful
    await waitFor(async () => {
      const j = await queue.getJob(claimed!.id);
      return j!.timeout_at!.getTime() <= Date.now() && j!.lock_until!.getTime() <= Date.now();
    }, { timeoutMs: 5_000, label: 'timeout_at + lock_until lapsed' });

    // handleTimeouts should NOT touch it (lock_until < now → stalled, not timed out)
    const timedOut = await queue.handleTimeouts();
    expect(timedOut.length).toBe(0);
  });

  test('jobs without timeout_ms never timeout', async () => {
    await queue.add('forever', {});
    await queue.claim('tok1', 30000, 'default', ['forever']);
    // Negative assertion with no expiring deadline to poll — a small fixed
    // grace window is the whole check.
    await new Promise(r => setTimeout(r, 50));
    const timedOut = await queue.handleTimeouts();
    expect(timedOut.length).toBe(0);
  });
});

// --- v7 Cascade kill ---

describe('MinionQueue: Cascade cancel', () => {
  test('cancel cascades to all descendants', async () => {
    const root = await queue.add('a', {});
    const c1 = await queue.add('b', {}, { parent_job_id: root.id });
    const c2 = await queue.add('c', {}, { parent_job_id: root.id });
    const gc = await queue.add('d', {}, { parent_job_id: c1.id });

    const cancelled = await queue.cancelJob(root.id);
    expect(cancelled!.id).toBe(root.id); // returns ROOT, not arbitrary descendant
    expect(cancelled!.status).toBe('cancelled');

    // All descendants are cancelled
    expect((await queue.getJob(c1.id))!.status).toBe('cancelled');
    expect((await queue.getJob(c2.id))!.status).toBe('cancelled');
    expect((await queue.getJob(gc.id))!.status).toBe('cancelled');
  });

  test('re-parented child (parent_job_id null) escapes cascade', async () => {
    const root = await queue.add('a', {});
    const c1 = await queue.add('b', {}, { parent_job_id: root.id });
    const orphan = await queue.add('c', {}, { parent_job_id: c1.id });

    // Re-parent orphan BEFORE cancel
    await queue.removeChildDependency(orphan.id);

    await queue.cancelJob(root.id);

    expect((await queue.getJob(c1.id))!.status).toBe('cancelled');
    // Orphan is not in the cascade tree any more
    expect((await queue.getJob(orphan.id))!.status).toBe('waiting');
  });

  test('already-terminal descendant not clobbered', async () => {
    const root = await queue.add('a', {});
    const child = await queue.add('b', {}, { parent_job_id: root.id });

    // Mark child completed first
    await engine.executeRaw(
      "UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1",
      [child.id]
    );

    await queue.cancelJob(root.id);
    const c = await queue.getJob(child.id);
    // Cascade only updates non-terminal statuses; completed stays completed
    expect(c!.status).toBe('completed');
  });
});

// --- v7 removeOnComplete / removeOnFail ---

describe('MinionQueue: removeOnComplete/Fail', () => {
  test('removeOnComplete=true deletes row on completion', async () => {
    const job = await queue.add('quick', {}, { remove_on_complete: true });
    await queue.claim('tok1', 30000, 'default', ['quick']);
    const completed = await queue.completeJob(job.id, 'tok1', { ok: true });
    // completeJob returns the in-memory snapshot pre-delete
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe('completed');
    // But the row is gone from the DB
    const after = await queue.getJob(job.id);
    expect(after).toBeNull();
  });

  test('removeOnComplete=false keeps row (default)', async () => {
    const job = await queue.add('keep', {});
    await queue.claim('tok1', 30000, 'default', ['keep']);
    await queue.completeJob(job.id, 'tok1');
    const after = await queue.getJob(job.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('completed');
  });

  test('removeOnFail=true deletes row on dead', async () => {
    const job = await queue.add('flaky', {}, { remove_on_fail: true, max_attempts: 1 });
    await queue.claim('tok1', 30000, 'default', ['flaky']);
    const failed = await queue.failJob(job.id, 'tok1', 'boom', 'dead');
    expect(failed!.status).toBe('dead');
    // Row deleted
    const after = await queue.getJob(job.id);
    expect(after).toBeNull();
  });

  test('removeOnFail does NOT delete on retryable (delayed)', async () => {
    const job = await queue.add('flaky', {}, { remove_on_fail: true, max_attempts: 3 });
    await queue.claim('tok1', 30000, 'default', ['flaky']);
    await queue.failJob(job.id, 'tok1', 'transient', 'delayed', 100);
    const after = await queue.getJob(job.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('delayed');
  });

  test('removeOnFail with fail_parent still fires parent hook before delete', async () => {
    const parent = await queue.add('orchestrate', {});
    const child = await queue.add('research', {}, {
      parent_job_id: parent.id,
      on_child_fail: 'fail_parent',
      remove_on_fail: true,
      max_attempts: 1,
    });
    await queue.claim('tok1', 30000, 'default', ['research']);
    await queue.failJob(child.id, 'tok1', 'died', 'dead');

    // Parent got the fail_parent hook before child was deleted
    const p = await queue.getJob(parent.id);
    expect(p!.status).toBe('failed');
    expect(p!.error_text).toContain(`child job ${child.id} failed`);

    // Child is deleted
    const c = await queue.getJob(child.id);
    expect(c).toBeNull();
  });
});

// --- v7 Idempotency ---

describe('MinionQueue: Idempotency', () => {
  test('same idempotency_key returns same job id', async () => {
    const j1 = await queue.add('sync', { full: true }, { idempotency_key: 'sync:2026-04-17' });
    const j2 = await queue.add('sync', { full: true }, { idempotency_key: 'sync:2026-04-17' });
    expect(j2.id).toBe(j1.id);
    // Only one row exists
    const all = await queue.getJobs({ name: 'sync' });
    expect(all.length).toBe(1);
  });

  test('different idempotency_keys produce different jobs', async () => {
    const j1 = await queue.add('sync', {}, { idempotency_key: 'a' });
    const j2 = await queue.add('sync', {}, { idempotency_key: 'b' });
    expect(j1.id).not.toBe(j2.id);
  });

  test('null idempotency_key allows duplicate inserts (default behavior)', async () => {
    const j1 = await queue.add('sync', {});
    const j2 = await queue.add('sync', {});
    expect(j1.id).not.toBe(j2.id);
  });

  test('concurrent inserts with same key collapse to one row', async () => {
    // Fire 5 simultaneous adds — only one row should win
    const promises = Array.from({ length: 5 }, () =>
      queue.add('sync', {}, { idempotency_key: 'race-key' })
    );
    const results = await Promise.all(promises);
    const ids = new Set(results.map(j => j.id));
    expect(ids.size).toBe(1);
    // Confirm DB has only one
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text as count FROM minion_jobs WHERE idempotency_key = 'race-key'`
    );
    expect(parseInt(rows[0].count, 10)).toBe(1);
  });

  test('different data with same idempotency_key returns first job (documented semantics)', async () => {
    const j1 = await queue.add('sync', { v: 1 }, { idempotency_key: 'same' });
    const j2 = await queue.add('sync', { v: 2 }, { idempotency_key: 'same' });
    expect(j2.id).toBe(j1.id);
    expect(j2.data).toEqual({ v: 1 }); // first wins
  });

  test('dead job with idempotency_key allows re-submission', async () => {
    const j1 = await queue.add('test-synth', { prompt: 'synthesize' }, {
      idempotency_key: 'dream:synth:test:abc123',
      max_attempts: 1,
    });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'dead', finished_at = now() WHERE id = $1`,
      [j1.id]
    );
    const j2 = await queue.add('test-synth', { prompt: 'synthesize' }, {
      idempotency_key: 'dream:synth:test:abc123',
      max_attempts: 8,
    });
    expect(j2.id).not.toBe(j1.id);
    expect(j2.status).toBe('waiting');
    const oldRow = await engine.executeRaw<{ idempotency_key: string | null }>(
      `SELECT idempotency_key FROM minion_jobs WHERE id = $1`,
      [j1.id]
    );
    expect(oldRow[0].idempotency_key).toBeNull();
  });

  test('cancelled job with idempotency_key allows re-submission', async () => {
    const j1 = await queue.add('test-synth', {}, {
      idempotency_key: 'dream:synth:test:cancel',
    });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1`,
      [j1.id]
    );
    const j2 = await queue.add('test-synth', {}, {
      idempotency_key: 'dream:synth:test:cancel',
    });
    expect(j2.id).not.toBe(j1.id);
    expect(j2.status).toBe('waiting');
  });

  test('completed job with idempotency_key still blocks re-submission', async () => {
    const j1 = await queue.add('sync', {}, {
      idempotency_key: 'dream:synth:test:completed',
    });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', finished_at = now() WHERE id = $1`,
      [j1.id]
    );
    const j2 = await queue.add('sync', {}, {
      idempotency_key: 'dream:synth:test:completed',
    });
    expect(j2.id).toBe(j1.id);
    expect(j2.status).toBe('completed');
  });

  test('active job with idempotency_key still blocks re-submission', async () => {
    const j1 = await queue.add('sync', {}, {
      idempotency_key: 'dream:synth:test:active',
    });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'active' WHERE id = $1`,
      [j1.id]
    );
    const j2 = await queue.add('sync', {}, {
      idempotency_key: 'dream:synth:test:active',
    });
    expect(j2.id).toBe(j1.id);
    expect(j2.status).toBe('active');
  });
});

// --- v7 child_done auto-post ---

describe('MinionQueue: child_done', () => {
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM minion_inbox');
  });

  test('child completion posts child_done into parent inbox', async () => {
    const parent = await queue.add('orchestrate', {});
    const child = await queue.add('research', {}, { parent_job_id: parent.id });
    await queue.claim('tok1', 30000, 'default', ['research']);
    await queue.completeJob(child.id, 'tok1', { findings: 42 });

    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT payload FROM minion_inbox WHERE job_id = $1`,
      [parent.id]
    );
    expect(rows.length).toBe(1);
    const payload = typeof rows[0].payload === 'string'
      ? JSON.parse(rows[0].payload as string)
      : rows[0].payload;
    expect(payload.type).toBe('child_done');
    expect(payload.child_id).toBe(child.id);
    expect(payload.job_name).toBe('research');
    expect(payload.result).toEqual({ findings: 42 });
  });

  test('child_done survives child removeOnComplete delete', async () => {
    const parent = await queue.add('orchestrate', {});
    const child = await queue.add('research', {}, {
      parent_job_id: parent.id,
      remove_on_complete: true,
    });
    await queue.claim('tok1', 30000, 'default', ['research']);
    await queue.completeJob(child.id, 'tok1', { ok: true });

    // Child row is deleted
    expect(await queue.getJob(child.id)).toBeNull();
    // But the parent inbox still has the child_done message
    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT payload FROM minion_inbox WHERE job_id = $1`,
      [parent.id]
    );
    expect(rows.length).toBe(1);
  });

  test('child_done NOT posted if parent already terminal', async () => {
    const parent = await queue.add('orchestrate', {});
    const child = await queue.add('research', {}, { parent_job_id: parent.id });
    // Force parent terminal out-of-band
    await engine.executeRaw(
      "UPDATE minion_jobs SET status = 'cancelled' WHERE id = $1",
      [parent.id]
    );
    await queue.claim('tok1', 30000, 'default', ['research']);
    await queue.completeJob(child.id, 'tok1', { ok: true });

    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT payload FROM minion_inbox WHERE job_id = $1`,
      [parent.id]
    );
    expect(rows.length).toBe(0);
  });

  test('readChildCompletions returns only child_done messages', async () => {
    const parent = await queue.add('orchestrate', {});
    const c1 = await queue.add('a', {}, { parent_job_id: parent.id });
    const c2 = await queue.add('b', {}, { parent_job_id: parent.id });

    await queue.claim('tok-a', 30000, 'default', ['a']);
    await queue.completeJob(c1.id, 'tok-a', { result: 'a-done' });
    await queue.claim('tok-b', 30000, 'default', ['b']);
    await queue.completeJob(c2.id, 'tok-b', { result: 'b-done' });

    // Parent now resolves to waiting (all kids done) — claim it to get the lock
    const claimedParent = await queue.claim('tok-p', 30000, 'default', ['orchestrate']);
    expect(claimedParent!.id).toBe(parent.id);

    // Add a non-child_done message to confirm filter
    await queue.sendMessage(parent.id, { unrelated: true }, 'admin');

    const completions = await queue.readChildCompletions(parent.id, 'tok-p');
    expect(completions.length).toBe(2);
    expect(completions.map(c => c.child_id).sort((a, b) => a - b)).toEqual([c1.id, c2.id].sort((a, b) => a - b));
    expect(completions.every(c => c.type === 'child_done')).toBe(true);
  });

  test('readChildCompletions since cursor filters older entries', async () => {
    const parent = await queue.add('orchestrate', {});
    const c1 = await queue.add('a', {}, { parent_job_id: parent.id });
    await queue.claim('tok-a', 30000, 'default', ['a']);
    await queue.completeJob(c1.id, 'tok-a');

    // Capture a cursor between the two completions. Genuinely time-based:
    // the cursor must sit strictly between the two child_done DB timestamps,
    // so a small separation sleep on each side IS the condition.
    await new Promise(r => setTimeout(r, 50));
    const cursor = new Date();
    await new Promise(r => setTimeout(r, 50));

    const c2 = await queue.add('b', {}, { parent_job_id: parent.id });
    await queue.claim('tok-b', 30000, 'default', ['b']);
    await queue.completeJob(c2.id, 'tok-b');

    const claimedParent = await queue.claim('tok-p', 30000, 'default', ['orchestrate']);
    expect(claimedParent).not.toBeNull();

    const recent = await queue.readChildCompletions(parent.id, 'tok-p', { since: cursor });
    expect(recent.length).toBe(1);
    expect(recent[0].child_id).toBe(c2.id);
  });

  test('readChildCompletions with wrong token returns empty', async () => {
    const parent = await queue.add('orchestrate', {});
    const child = await queue.add('a', {}, { parent_job_id: parent.id });
    await queue.claim('tok-c', 30000, 'default', ['a']);
    await queue.completeJob(child.id, 'tok-c');

    await queue.claim('tok-p', 30000, 'default', ['orchestrate']);
    const empty = await queue.readChildCompletions(parent.id, 'wrong-token');
    expect(empty.length).toBe(0);
  });
});

// --- v7 Attachments ---

describe('MinionQueue: Attachments', () => {
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM minion_attachments');
  });

  const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

  test('addAttachment + listAttachments round-trip', async () => {
    const job = await queue.add('agent', {});
    const att = await queue.addAttachment(job.id, {
      filename: 'notes.txt',
      content_type: 'text/plain',
      content_base64: b64('hello world'),
    });
    expect(att.filename).toBe('notes.txt');
    expect(att.size_bytes).toBe(11);
    expect(att.sha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await queue.listAttachments(job.id);
    expect(list.length).toBe(1);
    expect(list[0].filename).toBe('notes.txt');
  });

  test('getAttachment round-trips bytes exactly', async () => {
    const job = await queue.add('agent', {});
    const original = 'binary\x00\x01\x02data';
    await queue.addAttachment(job.id, {
      filename: 'data.bin',
      content_type: 'application/octet-stream',
      content_base64: b64(original),
    });

    const fetched = await queue.getAttachment(job.id, 'data.bin');
    expect(fetched).not.toBeNull();
    expect(fetched!.bytes.toString('utf-8')).toBe(original);
    expect(fetched!.meta.filename).toBe('data.bin');
  });

  test('rejects oversize attachment', async () => {
    // Use a tight per-queue cap
    const tightQueue = new MinionQueue(engine, { maxAttachmentBytes: 10 });
    const job = await tightQueue.add('agent', {});
    await expect(
      tightQueue.addAttachment(job.id, {
        filename: 'big.txt',
        content_type: 'text/plain',
        content_base64: b64('this is way more than ten bytes'),
      })
    ).rejects.toThrow(/exceeds maxBytes 10/);
  });

  test('rejects invalid base64', async () => {
    const job = await queue.add('agent', {});
    await expect(
      queue.addAttachment(job.id, {
        filename: 'bad.txt',
        content_type: 'text/plain',
        content_base64: 'not!valid@base64!!',
      })
    ).rejects.toThrow(/contains invalid characters/);
  });

  test('rejects duplicate filename per job_id', async () => {
    const job = await queue.add('agent', {});
    await queue.addAttachment(job.id, {
      filename: 'same.txt',
      content_type: 'text/plain',
      content_base64: b64('first'),
    });
    await expect(
      queue.addAttachment(job.id, {
        filename: 'same.txt',
        content_type: 'text/plain',
        content_base64: b64('second'),
      })
    ).rejects.toThrow(/already exists/);
  });

  test('rejects path traversal in filename', async () => {
    const job = await queue.add('agent', {});
    await expect(
      queue.addAttachment(job.id, {
        filename: '../etc/passwd',
        content_type: 'text/plain',
        content_base64: b64('x'),
      })
    ).rejects.toThrow(/invalid characters/);
  });

  test('rejects null byte in filename', async () => {
    const job = await queue.add('agent', {});
    await expect(
      queue.addAttachment(job.id, {
        filename: 'evil\0.txt',
        content_type: 'text/plain',
        content_base64: b64('x'),
      })
    ).rejects.toThrow(/invalid characters/);
  });

  test('attachments cascade-delete when job deleted', async () => {
    const job = await queue.add('agent', {});
    await queue.addAttachment(job.id, {
      filename: 'a.txt',
      content_type: 'text/plain',
      content_base64: b64('x'),
    });

    await queue.cancelJob(job.id);
    await queue.removeJob(job.id);

    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text as count FROM minion_attachments WHERE job_id = $1`,
      [job.id]
    );
    expect(parseInt(rows[0].count, 10)).toBe(0);
  });

  test('deleteAttachment removes a single attachment', async () => {
    const job = await queue.add('agent', {});
    await queue.addAttachment(job.id, {
      filename: 'a.txt',
      content_type: 'text/plain',
      content_base64: b64('x'),
    });
    await queue.addAttachment(job.id, {
      filename: 'b.txt',
      content_type: 'text/plain',
      content_base64: b64('y'),
    });

    const removed = await queue.deleteAttachment(job.id, 'a.txt');
    expect(removed).toBe(true);

    const list = await queue.listAttachments(job.id);
    expect(list.length).toBe(1);
    expect(list[0].filename).toBe('b.txt');
  });
});

// --- v0.19.1 — queue-resilience (wall-clock sweep, maxWaiting race, concurrency clamp) ---

describe('MinionQueue: v0.19.1 handleWallClockTimeouts (Layer 3 kill shot)', () => {
  test('evicts active job past 2× timeout_ms — sets dead + wall-clock error_text', async () => {
    const job = await queue.add('noop', {}, { timeout_ms: 100 });
    await engine.executeRaw(
      `UPDATE minion_jobs
         SET status='active',
             lock_token='wc-test',
             lock_until=now() - interval '1 second',
             started_at=now() - interval '1 second',
             timeout_at=now() - interval '0.9 second',
             attempts_started = attempts_started + 1
       WHERE id=$1`,
      [job.id],
    );
    const killed = await queue.handleWallClockTimeouts(30_000);
    expect(killed.length).toBe(1);
    expect(killed[0].id).toBe(job.id);
    const after = await queue.getJob(job.id);
    expect(after?.status).toBe('dead');
    expect(after?.error_text).toBe('wall-clock timeout exceeded');
  });

  test('timeout_ms NULL fallback uses 2 × lockDuration × max_stalled threshold', async () => {
    const job = await queue.add('noop', {}, { max_stalled: 3 });
    // Force timeout_ms / timeout_at NULL on-disk (columns might or might not be set by add).
    await engine.executeRaw(
      `UPDATE minion_jobs
         SET status='active',
             timeout_ms=NULL,
             timeout_at=NULL,
             lock_token='wc-null',
             lock_until=now() - interval '1 second',
             started_at=now() - interval '61 seconds',
             attempts_started = attempts_started + 1
       WHERE id=$1`,
      [job.id],
    );
    // 2 × lockDurationMs × max_stalled = 2 × 10_000 × 3 = 60_000 ms. started_at is 61s ago.
    const killed = await queue.handleWallClockTimeouts(10_000);
    expect(killed.length).toBe(1);
    expect(killed[0].id).toBe(job.id);
    const after = await queue.getJob(job.id);
    expect(after?.status).toBe('dead');
  });

  test('respects threshold — active job within window is NOT killed', async () => {
    const job = await queue.add('noop', {}, { timeout_ms: 100_000 });
    await engine.executeRaw(
      `UPDATE minion_jobs
         SET status='active',
             lock_token='wc-inside',
             lock_until=now() + interval '30 seconds',
             started_at=now() - interval '10 seconds',
             timeout_at=now() + interval '90 seconds',
             attempts_started = attempts_started + 1
       WHERE id=$1`,
      [job.id],
    );
    const killed = await queue.handleWallClockTimeouts(30_000);
    expect(killed.length).toBe(0);
    const after = await queue.getJob(job.id);
    expect(after?.status).toBe('active');
  });
});

describe('MinionQueue: v0.19.1 maxWaiting — cap correctness + race (D2/H2)', () => {
  test('coalesces 3rd submission when cap is 2 — returns existing most-recent waiting row', async () => {
    const a = await queue.add('poll', {}, { maxWaiting: 2 });
    const b = await queue.add('poll', {}, { maxWaiting: 2 });
    const c = await queue.add('poll', {}, { maxWaiting: 2 });
    expect(a.id).not.toBe(b.id);
    expect(c.id).toBe(b.id); // coalesced to the most-recent waiting row
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE name='poll' AND status='waiting'`,
    );
    expect(parseInt(rows[0].count, 10)).toBe(2);
  });

  test('clamps maxWaiting: 0 → 1 (strictest cap)', async () => {
    const a = await queue.add('squeeze', {}, { maxWaiting: 0 });
    const b = await queue.add('squeeze', {}, { maxWaiting: 0 });
    expect(b.id).toBe(a.id); // 0 clamped to 1, 2nd coalesces into 1st
  });

  test('floors maxWaiting: 1.7 → 1', async () => {
    const a = await queue.add('floor', {}, { maxWaiting: 1.7 });
    const b = await queue.add('floor', {}, { maxWaiting: 1.7 });
    expect(b.id).toBe(a.id);
  });

  test('concurrent submitters respect the cap under Promise.all race (H2)', async () => {
    // Serialized by pg_advisory_xact_lock keyed on (name, queue). Without it,
    // two concurrent submits both see count<max and both insert — the TOCTOU
    // bug codex caught in D2/H2.
    const results = await Promise.all([
      queue.add('race', {}, { maxWaiting: 2 }),
      queue.add('race', {}, { maxWaiting: 2 }),
      queue.add('race', {}, { maxWaiting: 2 }),
    ]);
    expect(results.length).toBe(3);
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE name='race' AND status='waiting'`,
    );
    expect(parseInt(rows[0].count, 10)).toBe(2); // cap held under concurrency
  });

  test('cross-queue isolation — same name in queue A does NOT suppress queue B (H2 secondary)', async () => {
    const a = await queue.add('isolate', {}, { maxWaiting: 1, queue: 'default' });
    // cap hit on queue=default with maxWaiting=1; 2nd would coalesce into `a`
    const a2 = await queue.add('isolate', {}, { maxWaiting: 1, queue: 'default' });
    expect(a2.id).toBe(a.id);
    // Different queue — MUST insert a fresh row, NOT coalesce into queue=default
    const b = await queue.add('isolate', {}, { maxWaiting: 1, queue: 'shell' });
    expect(b.id).not.toBe(a.id);
    expect(b.queue).toBe('shell');
  });

  test('cross-source isolation — waiting sync for source A does NOT swallow source B (multi-source regression)', async () => {
    // Regression: the cap counted all waiting (name, queue) rows regardless
    // of data.sourceId, so a waiting default-source sync coalesced away every
    // other source's freshness sync — a secondary source sat 29h stale while
    // dispatch logs showed its syncs "dispatched".
    const a = await queue.add('srcsync', { sourceId: 'default' }, { maxWaiting: 1 });
    const a2 = await queue.add('srcsync', { sourceId: 'default' }, { maxWaiting: 1 });
    expect(a2.id).toBe(a.id); // same source still coalesces
    const b = await queue.add('srcsync', { sourceId: 'projects' }, { maxWaiting: 1 });
    expect(b.id).not.toBe(a.id); // different source MUST get its own row
    const b2 = await queue.add('srcsync', { sourceId: 'projects' }, { maxWaiting: 1 });
    expect(b2.id).toBe(b.id); // and its own cap
  });

  test('unset maxWaiting — normal submit path, no coalesce, no cap', async () => {
    const a = await queue.add('uncapped', {});
    const b = await queue.add('uncapped', {});
    const c = await queue.add('uncapped', {});
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  // REGRESSION (jobs fix wave): the backpressure scope now reads BOTH payload
  // spellings. A snake_case source_id submission previously fell into the
  // NULL-wildcard arm (counted ALL rows for name+queue); it now scopes
  // exactly like camelCase sourceId. Pin the new arm for maxWaiting too —
  // the maxPending tests below cover it for the new option only.
  test('maxWaiting + snake_case source_id: scoped per source, not wildcard', async () => {
    const a1 = await queue.add('srcsync2', { source_id: 'src-a' }, { maxWaiting: 1 });
    // Different source: must NOT be swallowed by src-a's waiting row.
    const b1 = await queue.add('srcsync2', { source_id: 'src-b' }, { maxWaiting: 1 });
    expect(b1.id).not.toBe(a1.id);
    // Same source coalesces.
    const a2 = await queue.add('srcsync2', { source_id: 'src-a' }, { maxWaiting: 1 });
    expect(a2.id).toBe(a1.id);
    expect(a2.coalesced).toBe(true);
  });
});

// --- maxPending — single-flight counting waiting + LIVE-LOCK active rows ---
//
// Jobs fix wave (upstream issue #2): the autopilot dispatch guards failed once
// a job sat in 'active' — maxWaiting counts only waiting rows and the slot
// idempotency key rotates every baseInterval, so a stalled cycle accumulated
// unbounded byte-identical duplicates. maxPending counts waiting rows PLUS
// live-lock actives (lock_until > now()); an expired-lock active belongs to a
// dead/blocked worker and must NOT suppress dispatch — the fresh waiting row
// keeps feeding the waitingClaimable>0 wedge detectors. Scope is EXACT on
// COALESCE(data.sourceId, data.source_id): NULL matches only NULL.
//
// NOTE: the Promise.all race here runs on single-writer PGLite — a smoke
// check. The advisory-lock guarantee under real concurrency is pinned by the
// DATABASE_URL-gated e2e (concurrent same-scope submissions on Postgres).

describe('MinionQueue: maxPending — single-flight (waiting + live-lock active)', () => {
  async function forceActive(id: number, lockUntilSql: string): Promise<void> {
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_token = 'tok-mp',
              lock_until = ${lockUntilSql}, started_at = now() - interval '5 minutes'
        WHERE id = $1`,
      [id],
    );
  }

  test('cap 1: second submission coalesces onto the waiting row (coalesced metadata set)', async () => {
    const a = await queue.add('single-flight', {}, { maxPending: 1 });
    expect(a.coalesced).toBeUndefined(); // fresh insert carries no metadata
    const b = await queue.add('single-flight', {}, { maxPending: 1 });
    expect(b.id).toBe(a.id);
    expect(b.coalesced).toBe(true);
  });

  test('LIVE-LOCK active row suppresses dispatch (the issue-#2 fix)', async () => {
    const a = await queue.add('single-flight', {}, { maxPending: 1 });
    await forceActive(a.id, `now() + interval '5 minutes'`);
    const b = await queue.add('single-flight', {}, { maxPending: 1 });
    expect(b.id).toBe(a.id); // coalesced onto the in-flight ACTIVE row
    expect(b.coalesced).toBe(true);
    expect(b.status).toBe('active');
  });

  test('EXPIRED-lock active row does NOT suppress — fresh insert (wedge detectors stay fed)', async () => {
    const a = await queue.add('single-flight', {}, { maxPending: 1 });
    await forceActive(a.id, `now() - interval '1 second'`);
    const b = await queue.add('single-flight', {}, { maxPending: 1 });
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe('waiting');
    expect(b.coalesced).toBeUndefined();
  });

  test('waiting row preferred over live active on cap-hit', async () => {
    const active = await queue.add('single-flight', {}, { maxPending: 2 });
    await forceActive(active.id, `now() + interval '5 minutes'`);
    const waiting = await queue.add('single-flight', {}, { maxPending: 2 });
    expect(waiting.status).toBe('waiting');
    const c = await queue.add('single-flight', {}, { maxPending: 2 });
    expect(c.id).toBe(waiting.id); // most-recent WAITING wins the coalesce
    expect(c.coalesced).toBe(true);
  });

  test('dead row frees the cap', async () => {
    const a = await queue.add('single-flight', {}, { maxPending: 1 });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'dead', finished_at = now() WHERE id = $1`, [a.id],
    );
    const b = await queue.add('single-flight', {}, { maxPending: 1 });
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe('waiting');
  });

  test('EXACT source scope: NULL-source submission never coalesces onto a per-source row (and vice versa)', async () => {
    const perSource = await queue.add('single-flight', { source_id: 'src-a' }, { maxPending: 1 });
    // NULL-source submission: per-source row must not count for it.
    const legacy = await queue.add('single-flight', {}, { maxPending: 1 });
    expect(legacy.id).not.toBe(perSource.id);
    // And a second NULL-source submission coalesces onto the legacy row only.
    const legacy2 = await queue.add('single-flight', {}, { maxPending: 1 });
    expect(legacy2.id).toBe(legacy.id);
    // A second per-source submission coalesces onto the per-source row only.
    const perSource2 = await queue.add('single-flight', { source_id: 'src-a' }, { maxPending: 1 });
    expect(perSource2.id).toBe(perSource.id);
  });

  test('snake_case source_id scoping: two sources keep independent caps; same source coalesces', async () => {
    const a1 = await queue.add('single-flight', { source_id: 'src-a' }, { maxPending: 1 });
    const b1 = await queue.add('single-flight', { source_id: 'src-b' }, { maxPending: 1 });
    expect(b1.id).not.toBe(a1.id);
    const a2 = await queue.add('single-flight', { source_id: 'src-a' }, { maxPending: 1 });
    expect(a2.id).toBe(a1.id);
  });

  test('camelCase sourceId scoping parity', async () => {
    const a1 = await queue.add('single-flight', { sourceId: 'src-a' }, { maxPending: 1 });
    const b1 = await queue.add('single-flight', { sourceId: 'src-b' }, { maxPending: 1 });
    expect(b1.id).not.toBe(a1.id);
    const a2 = await queue.add('single-flight', { sourceId: 'src-a' }, { maxPending: 1 });
    expect(a2.id).toBe(a1.id);
  });

  test('clamp: maxPending 0 → 1; floor: 1.7 → 1', async () => {
    const a = await queue.add('single-flight', {}, { maxPending: 0 });
    const b = await queue.add('single-flight', {}, { maxPending: 0 });
    expect(b.id).toBe(a.id); // 0 clamps to 1 → coalesce
    await engine.executeRaw('DELETE FROM minion_jobs');
    const c = await queue.add('single-flight', {}, { maxPending: 1.7 });
    const d = await queue.add('single-flight', {}, { maxPending: 1.7 });
    expect(d.id).toBe(c.id); // floor(1.7)=1 → coalesce
  });

  test('race: concurrent submissions hold the cap (PGLite smoke; PG e2e pins the real guarantee)', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => queue.add('single-flight', {}, { maxPending: 1 })),
    );
    const ids = new Set(results.map(r => r.id));
    expect(ids.size).toBe(1);
  });

  test('both guards supplied: maxPending checked first, both enforced', async () => {
    // One waiting row. maxPending: 2 passes (1 pending < 2) but
    // maxWaiting: 1 must still coalesce — both guards apply.
    const a = await queue.add('single-flight', {}, { maxPending: 2, maxWaiting: 1 });
    const b = await queue.add('single-flight', {}, { maxPending: 2, maxWaiting: 1 });
    expect(b.id).toBe(a.id);
    expect(b.coalesced).toBe(true);
    // Now force it ACTIVE (live lock): maxWaiting alone would let a new row
    // in (waiting=0), but maxPending: 1 fires FIRST and coalesces onto the
    // in-flight row.
    await forceActive(a.id, `now() + interval '5 minutes'`);
    const c = await queue.add('single-flight', {}, { maxPending: 1, maxWaiting: 1 });
    expect(c.id).toBe(a.id);
    expect(c.coalesced).toBe(true);
  });

  test('ON CONFLICT idempotency race fallback also carries coalesced metadata', async () => {
    // Same idempotency_key twice: the fast-path SELECT returns the existing
    // row with coalesced: true (first coalesce path).
    const a = await queue.add('single-flight', {}, { idempotency_key: 'sf-key-1' });
    expect(a.coalesced).toBeUndefined();
    const b = await queue.add('single-flight', {}, { idempotency_key: 'sf-key-1' });
    expect(b.id).toBe(a.id);
    expect(b.coalesced).toBe(true);
  });
});

describe('resolveWorkerConcurrency (v0.19.1 H3): clamp + validation', () => {
  // jobs.ts handler — tested via direct import. Warning goes to stderr;
  // tests verify return value only, not the warning line.
  let resolveWorkerConcurrency: (args: string[], env?: NodeJS.ProcessEnv) => number;
  let parseMaxWaitingFlag: (args: string[]) => number | undefined;
  beforeAll(async () => {
    const mod = await import('../src/commands/jobs.ts');
    resolveWorkerConcurrency = mod.resolveWorkerConcurrency;
    parseMaxWaitingFlag = mod.parseMaxWaitingFlag;
  });

  test('flag=4 env-unset → 4', () => {
    expect(resolveWorkerConcurrency(['--concurrency', '4'], {} as NodeJS.ProcessEnv)).toBe(4);
  });
  test('flag-unset env=8 → 8', () => {
    expect(resolveWorkerConcurrency([], { GBRAIN_WORKER_CONCURRENCY: '8' } as NodeJS.ProcessEnv)).toBe(8);
  });
  test('flag=2 env=8 → 2 (flag wins)', () => {
    expect(resolveWorkerConcurrency(['--concurrency', '2'], { GBRAIN_WORKER_CONCURRENCY: '8' } as NodeJS.ProcessEnv)).toBe(2);
  });
  test('both unset → 1', () => {
    expect(resolveWorkerConcurrency([], {} as NodeJS.ProcessEnv)).toBe(1);
  });
  test('garbage env "foo" → clamped to 1 (H3)', () => {
    expect(resolveWorkerConcurrency([], { GBRAIN_WORKER_CONCURRENCY: 'foo' } as NodeJS.ProcessEnv)).toBe(1);
  });
  test('env=0 → clamped to 1 (H3 — prevents silent wedge)', () => {
    expect(resolveWorkerConcurrency([], { GBRAIN_WORKER_CONCURRENCY: '0' } as NodeJS.ProcessEnv)).toBe(1);
  });
  test('env=-5 → clamped to 1 (H3)', () => {
    expect(resolveWorkerConcurrency([], { GBRAIN_WORKER_CONCURRENCY: '-5' } as NodeJS.ProcessEnv)).toBe(1);
  });
});

describe('parseMaxWaitingFlag (v0.19.1 H5): CLI flag wiring', () => {
  let parseMaxWaitingFlag: (args: string[]) => number | undefined;
  beforeAll(async () => {
    parseMaxWaitingFlag = (await import('../src/commands/jobs.ts')).parseMaxWaitingFlag;
  });

  test('absent → undefined (no cap, default submit path)', () => {
    expect(parseMaxWaitingFlag(['foo', '--params', '{}'])).toBeUndefined();
  });
  test('--max-waiting 2 → 2 (happy path)', () => {
    expect(parseMaxWaitingFlag(['foo', '--max-waiting', '2'])).toBe(2);
  });
  test('--max-waiting 200 → clamped to 100', () => {
    expect(parseMaxWaitingFlag(['foo', '--max-waiting', '200'])).toBe(100);
  });
  test('--max-waiting 0 → throws', () => {
    expect(() => parseMaxWaitingFlag(['foo', '--max-waiting', '0'])).toThrow('positive integer');
  });
  test('--max-waiting abc → throws', () => {
    expect(() => parseMaxWaitingFlag(['foo', '--max-waiting', 'abc'])).toThrow('positive integer');
  });
});

describe('backpressure-audit (v0.19.1 Q1): JSONL on coalesce', () => {
  test('logBackpressureCoalesce writes one JSONL line per coalesce', async () => {
    const { logBackpressureCoalesce, resolveAuditDir, computeAuditFilename } =
      await import('../src/core/minions/backpressure-audit.ts');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-audit-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmp }, async () => {
        expect(resolveAuditDir()).toBe(tmp);
        logBackpressureCoalesce({
          queue: 'default',
          name: 'poll',
          waiting_count: 2,
          max_waiting: 2,
          returned_job_id: 42,
        });
        const file = path.join(tmp, computeAuditFilename());
        const text = fs.readFileSync(file, 'utf8');
        const line = JSON.parse(text.trim());
        expect(line.decision).toBe('coalesced');
        expect(line.name).toBe('poll');
        expect(line.returned_job_id).toBe(42);
        expect(typeof line.ts).toBe('string');
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('MinionQueue: v0.19.1 wall-clock + handleTimeouts non-interference (T1)', () => {
  test('wall-clock sweep does NOT evict a job that handleTimeouts would handle', async () => {
    // Retry-able timeout: timeout_at < now() AND lock_until > now() — handleTimeouts
    // is the correct killer here. wall-clock's 2× threshold has not fired yet.
    const job = await queue.add('noop', {}, { timeout_ms: 100_000 });
    await engine.executeRaw(
      `UPDATE minion_jobs
         SET status='active',
             lock_token='t1',
             lock_until=now() + interval '30 seconds',
             started_at=now() - interval '2 seconds',
             timeout_at=now() - interval '0.5 seconds',
             attempts_started = attempts_started + 1
       WHERE id=$1`,
      [job.id],
    );
    // At this point: started_at is 2s ago, 2×timeout_ms = 200s. Wall-clock should NOT fire.
    const killed = await queue.handleWallClockTimeouts(30_000);
    expect(killed.length).toBe(0);
    const after = await queue.getJob(job.id);
    expect(after?.status).toBe('active');
  });
});

// --- v0.22.2: RSS watchdog (--max-rss + periodic timer + gracefulShutdown) ---

describe('MinionWorker: --max-rss watchdog', () => {
  // Helper: build a worker with deterministic RSS injection. Tests pass a
  // sequence of bytes; getRss() returns elements in order, repeating the last.
  function makeRssSequence(values: number[]): () => number {
    let i = 0;
    return () => {
      const v = values[Math.min(i, values.length - 1)];
      i++;
      return v;
    };
  }

  test('per-job check: handler bumps RSS, post-job check trips, sibling aborts', async () => {
    // 100MB threshold. RSS reads always return 250MB → first post-job check
    // (after the 'quick' handler completes) trips and the 'slow' sibling
    // sees its abort signal flip.
    const worker = new MinionWorker(engine, {
      queue: 'default',
      concurrency: 2,
      maxRssMb: 100,
      getRss: () => 250 * 1024 * 1024,
      pollInterval: 50,
      stalledInterval: 10_000,
      rssCheckInterval: 60_000, // disable periodic — exercise per-job only
    });

    let sibling2Aborted = false;
    let sibling2Resolved = false;
    let sibling1Done = false;

    worker.register('quick', async () => {
      // Resolves immediately. Triggers post-job check.
      sibling1Done = true;
    });
    worker.register('slow', async (job) => {
      // Long-running sibling. Watch for abort signal.
      job.signal.addEventListener('abort', () => { sibling2Aborted = true; });
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (job.signal.aborted) { clearInterval(t); sibling2Resolved = true; resolve(); }
        }, 20);
      });
    });

    await queue.add('slow', {});
    await queue.add('quick', {});

    await worker.start(); // returns when stop() flips and drain completes

    expect(sibling1Done).toBe(true);
    expect(sibling2Aborted).toBe(true);
    expect(sibling2Resolved).toBe(true);
  }, 60_000);

  test('periodic timer: zero job completions, watchdog still fires', async () => {
    // Threshold 100MB. RSS = 250MB on every call. No job ever completes.
    const worker = new MinionWorker(engine, {
      queue: 'default',
      concurrency: 1,
      maxRssMb: 100,
      getRss: () => 250 * 1024 * 1024,
      pollInterval: 50,
      stalledInterval: 10_000,
      rssCheckInterval: 100, // fire fast in tests
    });

    let abortedDuringHandler = false;

    worker.register('forever', async (job) => {
      // Never returns naturally. Wait on abort.
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (job.signal.aborted) {
            abortedDuringHandler = true;
            clearInterval(t);
            resolve();
          }
        }, 20);
      });
    });

    await queue.add('forever', {});

    await worker.start();

    expect(abortedDuringHandler).toBe(true);
  }, 60_000);

  test('shutdownAbort fires (closes shell-handler zombie gap)', async () => {
    const worker = new MinionWorker(engine, {
      queue: 'default',
      concurrency: 1,
      maxRssMb: 100,
      getRss: () => 250 * 1024 * 1024,
      pollInterval: 50,
      stalledInterval: 10_000,
      rssCheckInterval: 100,
    });

    let shutdownSignalFired = false;

    worker.register('observer', async (job) => {
      // Subscribes to shutdownSignal — same pattern as shell.ts
      job.shutdownSignal.addEventListener('abort', () => { shutdownSignalFired = true; });
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (job.signal.aborted) { clearInterval(t); resolve(); }
        }, 20);
      });
    });

    await queue.add('observer', {});
    await worker.start();

    expect(shutdownSignalFired).toBe(true);
  }, 60_000);

  test('below threshold: no-op (no shutdown)', async () => {
    let postJobCount = 0;
    const worker = new MinionWorker(engine, {
      queue: 'default',
      concurrency: 1,
      maxRssMb: 1024,
      getRss: () => { postJobCount++; return 50 * 1024 * 1024; }, // always 50MB, way under
      pollInterval: 50,
      stalledInterval: 10_000,
      rssCheckInterval: 60_000,
    });

    worker.register('noop', async () => {});

    await queue.add('noop', {});
    await queue.add('noop', {});
    await queue.add('noop', {});

    // Run until all 3 jobs drain (and each post-job RSS check ran), then stop
    const startPromise = worker.start();
    await waitFor(async () =>
      postJobCount >= 3 && (await queue.getJobs({ status: 'completed' })).length >= 3,
    { timeoutMs: 5_000, label: '3 noop jobs completed + RSS checks' });
    worker.stop();
    await startPromise;

    // Watchdog never tripped → all 3 jobs completed
    const completed = await queue.getJobs({ status: 'completed' });
    expect(completed.length).toBe(3);
    expect(postJobCount).toBeGreaterThanOrEqual(3); // checkMemoryLimit ran each time
  }, 60_000);

  test('maxRssMb=0 disables watchdog entirely', async () => {
    const worker = new MinionWorker(engine, {
      queue: 'default',
      concurrency: 1,
      maxRssMb: 0,
      getRss: () => 999_999 * 1024 * 1024, // huge, but disabled
      pollInterval: 50,
      stalledInterval: 10_000,
      rssCheckInterval: 100,
    });

    worker.register('noop', async () => {});
    const job = await queue.add('noop', {});

    const startPromise = worker.start();
    await waitForJobStatus(job.id);
    worker.stop();
    await startPromise;

    const completed = await queue.getJobs({ status: 'completed' });
    expect(completed.length).toBe(1);
  }, 60_000);
});

// --- v0.21: connectWithRetry + isRetryableDbConnectError ---

describe('connectWithRetry / isRetryableDbConnectError', () => {
  test('isRetryableDbConnectError matches transient patterns', async () => {
    const { isRetryableDbConnectError } = await import('../src/core/db.ts');
    expect(isRetryableDbConnectError(new Error('password authentication failed for user postgres'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('connection refused'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('the database system is starting up'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('something happened: ECONNRESET'))).toBe(true);
  });

  test('isRetryableDbConnectError rejects permanent errors', async () => {
    const { isRetryableDbConnectError } = await import('../src/core/db.ts');
    expect(isRetryableDbConnectError(new Error('extension "vector" does not exist'))).toBe(false);
    expect(isRetryableDbConnectError(new Error('relation "pages" does not exist'))).toBe(false);
    expect(isRetryableDbConnectError(new Error('syntax error at end of input'))).toBe(false);
  });

  test('connectWithRetry: 1st rejects transient, 2nd succeeds', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        if (attempts === 1) throw new Error('password authentication failed for user postgres');
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    await connectWithRetry(fakeEngine, { database_url: 'postgres://x' }, { baseDelayMs: 1, log: () => {} });
    expect(attempts).toBe(2);
  });

  test('connectWithRetry: 3 transient rejects → throws', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        throw new Error('connection refused');
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    await expect(
      connectWithRetry(fakeEngine, { database_url: 'postgres://x' }, { baseDelayMs: 1, log: () => {} })
    ).rejects.toThrow('connection refused');
    expect(attempts).toBe(3);
  });

  test('connectWithRetry: permanent error does NOT retry', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        throw new Error('extension "vector" does not exist');
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    await expect(
      connectWithRetry(fakeEngine, { database_url: 'postgres://x' }, { baseDelayMs: 1, log: () => {} })
    ).rejects.toThrow('extension "vector"');
    expect(attempts).toBe(1);
  });

  test('connectWithRetry: noRetry honored', async () => {
    const { connectWithRetry } = await import('../src/core/db.ts');
    let attempts = 0;
    const fakeEngine = {
      connect: async () => {
        attempts++;
        throw new Error('connection refused');
      },
    } as unknown as Parameters<typeof connectWithRetry>[0];

    await expect(
      connectWithRetry(fakeEngine, { database_url: 'postgres://x' }, { noRetry: true, log: () => {} })
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Abort signal propagation + force-eviction (v0.20.5 cycle-abort fix)
// ---------------------------------------------------------------------------

describe('MinionWorker: abort signal propagation (v0.20.5)', () => {
  test('handler receiving abort signal can exit cleanly', async () => {
    // Handler that respects AbortSignal
    const job = await queue.add('abort-aware', {}, { timeout_ms: 150, max_attempts: 1 });
    let signalAborted = false;

    const worker = new MinionWorker(engine, { pollInterval: 50 });
    worker.register('abort-aware', async (ctx) => {
      // Simulate long work that checks signal
      while (!ctx.signal.aborted) {
        await new Promise(r => setTimeout(r, 10));
      }
      signalAborted = true;
      throw ctx.signal.reason || new Error('aborted');
    });

    const workerPromise = worker.start();
    // Wait for timeout (150ms) + handler to notice + dead-letter to land
    await waitForJobStatus(job.id);
    worker.stop();
    await workerPromise;

    expect(signalAborted).toBe(true);
    const result = await queue.getJob(job.id);
    // Should be dead (max_attempts: 1, aborted)
    expect(result!.status).toBe('dead');
    expect(result!.error_text).toContain('abort');
  });

  test('handler ignoring abort signal still gets abort fired', async () => {
    // Handler that IGNORES AbortSignal — the exact bug pattern.
    // We verify the abort fires (the signal flips) even though the handler
    // doesn't check it. The 30s force-eviction grace is too long for unit
    // tests; the E2E test in test/e2e/worker-abort-recovery.test.ts covers
    // the full force-eviction path. Here we just verify the abort signal
    // is delivered to the handler context.
    const job = await queue.add('abort-ignorer', {}, { timeout_ms: 100, max_attempts: 1 });
    let handlerStarted = false;
    let signalWasAborted = false;

    const worker = new MinionWorker(engine, { pollInterval: 50 });
    worker.register('abort-ignorer', async (ctx) => {
      handlerStarted = true;
      // Deliberately ignore the signal past timeout_ms (100), then check —
      // the fixed sleep IS the "handler that doesn't poll its signal".
      await new Promise(r => setTimeout(r, 200));
      signalWasAborted = ctx.signal.aborted;
      // Now exit (a well-behaved handler would do this)
      if (ctx.signal.aborted) {
        throw ctx.signal.reason || new Error('aborted');
      }
      return { ok: true };
    });

    const workerPromise = worker.start();
    await waitForJobStatus(job.id);

    expect(handlerStarted).toBe(true);
    expect(signalWasAborted).toBe(true);

    worker.stop();
    await workerPromise;

    const result = await queue.getJob(job.id);
    expect(result!.status).toBe('dead');
  });

  test('worker claims new jobs after timeout eviction (no wedge)', async () => {
    // The critical regression test: submit a slow job that times out,
    // then submit a fast job. The fast job MUST execute.
    const slowJob = await queue.add('slow-timeout', {}, { timeout_ms: 100, max_attempts: 1 });
    let slowAborted = false;
    let fastExecuted = false;

    const worker = new MinionWorker(engine, { pollInterval: 50, concurrency: 1 });
    worker.register('slow-timeout', async (ctx) => {
      // Respects abort but takes a moment
      await new Promise(r => setTimeout(r, 50));
      while (!ctx.signal.aborted) {
        await new Promise(r => setTimeout(r, 10));
      }
      slowAborted = true;
      throw new Error('aborted: timeout');
    });
    worker.register('fast-after', async () => {
      fastExecuted = true;
      return { fast: true };
    });

    const workerPromise = worker.start();

    // Wait for slow job to start and timeout
    await waitFor(() => slowAborted, { timeoutMs: 5_000, label: 'slow-timeout abort observed' });

    // Now submit the fast job — it should get claimed
    const fastJob = await queue.add('fast-after', {});
    await waitFor(async () => {
      const fast = await queue.getJob(fastJob.id);
      const slow = await queue.getJob(slowJob.id);
      return fast?.status === 'completed' && slow?.status === 'dead';
    }, { timeoutMs: 5_000, label: 'fast completed + slow dead' });

    worker.stop();
    await workerPromise;

    expect(slowAborted).toBe(true);
    expect(fastExecuted).toBe(true);

    const slowResult = await queue.getJob(slowJob.id);
    expect(slowResult!.status).toBe('dead');

    const fastResult = await queue.getJob(fastJob.id);
    expect(fastResult!.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// checkAborted (v0.20.5 cycle.ts)
// ---------------------------------------------------------------------------

describe('checkAborted (v0.20.5 cycle signal)', () => {
  // Import the function indirectly by testing the behavior pattern
  test('undefined signal does not throw', () => {
    // checkAborted is not exported, so we test through CycleOpts behavior.
    // This test validates the pattern directly. The `as` cast keeps the
    // union type intact — a bare `const signal = undefined` (or even
    // `const signal: AbortSignal | undefined = undefined`) would narrow
    // back to literal `undefined` via TS control-flow analysis and then
    // reject the optional-chain access on it.
    const signal = undefined as AbortSignal | undefined;
    expect(() => {
      if (signal?.aborted) throw new Error('aborted');
    }).not.toThrow();
  });

  test('non-aborted signal does not throw', () => {
    const abort = new AbortController();
    expect(() => {
      if (abort.signal.aborted) throw new Error('aborted');
    }).not.toThrow();
  });

  test('aborted signal throws with reason', () => {
    const abort = new AbortController();
    abort.abort(new Error('timeout'));
    expect(() => {
      if (abort.signal.aborted) {
        const reason = abort.signal.reason instanceof Error
          ? abort.signal.reason.message
          : String(abort.signal.reason || 'aborted');
        throw new Error(`[cycle] aborted between phases: ${reason}`);
      }
    }).toThrow('aborted between phases: timeout');
  });
});

// --- v0.22.14: Self-health-check for bare workers ---

describe('MinionWorker: self-health-check', () => {
  test('health check is active when GBRAIN_SUPERVISED is not set', async () => {
    await withEnv({ GBRAIN_SUPERVISED: undefined }, async () => {
      const worker = new MinionWorker(engine, {
        queue: 'default',
        concurrency: 1,
        healthCheckInterval: 100, // fast for testing
        pollInterval: 50,
        stalledInterval: 10_000,
        maxRssMb: 0,
      });

      worker.register('noop', async () => {});
      const job = await queue.add('noop', {});

      const startPromise = worker.start();
      // Let the health check fire at least once (100ms interval) — the
      // premise under test is that a live tick coexists with processing,
      // so this floor is genuinely time-based; then poll for the drain.
      await new Promise(r => setTimeout(r, 150));
      await waitForJobStatus(job.id);
      worker.stop();
      await startPromise;

      // Worker should have processed the job despite health check running
      const completed = await queue.getJobs({ status: 'completed' });
      expect(completed.length).toBeGreaterThanOrEqual(1);
    });
  }, 10_000);

  test('health check is skipped when GBRAIN_SUPERVISED=1', async () => {
    await withEnv({ GBRAIN_SUPERVISED: '1' }, async () => {
      const worker = new MinionWorker(engine, {
        queue: 'default',
        concurrency: 1,
        healthCheckInterval: 100,
        pollInterval: 50,
        stalledInterval: 10_000,
        maxRssMb: 0,
      });

      worker.register('noop', async () => {});
      const job = await queue.add('noop', {});

      const startPromise = worker.start();
      await waitForJobStatus(job.id);
      worker.stop();
      await startPromise;

      // Worker should still process jobs fine
      const completed = await queue.getJobs({ status: 'completed' });
      expect(completed.length).toBeGreaterThanOrEqual(1);
    });
  }, 10_000);

  test('healthCheckInterval=0 disables health check', async () => {
    await withEnv({ GBRAIN_SUPERVISED: undefined }, async () => {
      const worker = new MinionWorker(engine, {
        queue: 'default',
        concurrency: 1,
        healthCheckInterval: 0,
        pollInterval: 50,
        stalledInterval: 10_000,
        maxRssMb: 0,
      });

      worker.register('noop', async () => {});
      const job = await queue.add('noop', {});

      const startPromise = worker.start();
      await waitForJobStatus(job.id);
      worker.stop();
      await startPromise;

      const completed = await queue.getJobs({ status: 'completed' });
      expect(completed.length).toBeGreaterThanOrEqual(1);
    });
  }, 10_000);
});

// --- v0.22.14: Self-health-check behavior tests (D7) ---
// These tests use a Proxy around the real engine so executeRaw can be
// intercepted by SQL pattern. SELECT 1 = liveness probe; the count(*) query
// = stall detection. Anything else passes through to the underlying engine.

interface ProbeOverrides {
  /** When set, executeRaw('SELECT 1') uses this function instead of pass-through.
   *  Returning a thrown error simulates DB death; returning [{}] simulates success. */
  selectOne?: () => Promise<unknown>;
  /** When set, executeRaw of the stall-detection count(*) query returns this. */
  countWaiting?: (handlers: string[]) => number;
  /** Captures the last SQL string that matched the stall-count regex. Tests
   *  use this to assert the production SQL still contains `name = ANY(...)`
   *  so a future refactor that drops the predicate is caught. */
  capturedStallSql?: { sql: string | null };
}

function makeProbeEngine(overrides: ProbeOverrides) {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]): Promise<unknown[]> => {
          if (overrides.selectOne && /^\s*SELECT\s+1\s*$/i.test(sql)) {
            const r = await overrides.selectOne();
            return Array.isArray(r) ? r : [r];
          }
          if (overrides.countWaiting && /count\(\*\).*minion_jobs.*WHERE\s+status\s*=\s*'waiting'/is.test(sql)) {
            if (overrides.capturedStallSql) overrides.capturedStallSql.sql = sql;
            const handlers = (params?.[1] as string[]) ?? [];
            return [{ cnt: String(overrides.countWaiting(handlers)) }];
          }
          // Pass through to real engine for anything else (claim queries etc.)
          return (target as unknown as { executeRaw: (s: string, p?: unknown[]) => Promise<unknown[]> })
            .executeRaw(sql, params);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as PGLiteEngine;
}

describe('MinionWorker: self-health-check behavior (v0.22.14)', () => {
  test('emits unhealthy{db_dead} after dbFailExitAfter consecutive DB probe failures', async () => {
    await withEnv({ GBRAIN_SUPERVISED: undefined }, async () => {
      let probeCount = 0;
      const probeEngine = makeProbeEngine({
        selectOne: async () => {
          probeCount++;
          throw new Error('connection terminated unexpectedly');
        },
      });

      const worker = new MinionWorker(probeEngine, {
        queue: 'default',
        concurrency: 1,
        healthCheckInterval: 30,
        dbFailExitAfter: 3,
        pollInterval: 50,
        stalledInterval: 10_000,
        maxRssMb: 0,
      });

      worker.register('noop', async () => {});

      const events: Array<{ reason: string }> = [];
      worker.on('unhealthy', (info) => { events.push(info); });

      const startPromise = worker.start();
      // 3 ticks at 30ms trip the counter; poll for the event itself.
      await waitFor(() => probeCount >= 3 && events.length >= 1, {
        timeoutMs: 5_000, label: 'db_dead unhealthy event',
      });
      worker.stop();
      await startPromise;

      expect(probeCount).toBeGreaterThanOrEqual(3);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].reason).toBe('db_dead');
    });
  }, 10_000);

  test('DB recovery resets the failure counter (no exit after intermittent failures)', async () => {
    await withEnv({ GBRAIN_SUPERVISED: undefined }, async () => {
      let probeCount = 0;
      // Pattern: fail, fail, succeed (resets), fail, fail, then permanently succeed.
      // No 3 consecutive failures, so dbFailExitAfter=3 must NOT trip.
      const probeEngine = makeProbeEngine({
        selectOne: async () => {
          const idx = probeCount++;
          if (idx === 0 || idx === 1 || idx === 3 || idx === 4) {
            throw new Error('transient blip');
          }
          return [{ ok: 1 }];
        },
      });

      const worker = new MinionWorker(probeEngine, {
        queue: 'default',
        concurrency: 1,
        healthCheckInterval: 30,
        dbFailExitAfter: 3,
        pollInterval: 50,
        stalledInterval: 10_000,
        maxRssMb: 0,
      });

      worker.register('noop', async () => {});

      const events: Array<{ reason: string }> = [];
      worker.on('unhealthy', (info) => { events.push(info); });

      const startPromise = worker.start();
      // Run until the fail/ok/fail pattern is fully exercised (6 probes).
      await waitFor(() => probeCount >= 6, { timeoutMs: 5_000, label: 'probe pattern exercised' });
      worker.stop();
      await startPromise;

      // Counter should never have hit 3 consecutive — success at index 2 resets it.
      const dbDeadEvents = events.filter(e => e.reason === 'db_dead');
      expect(dbDeadEvents.length).toBe(0);
    });
  }, 10_000);

  test('emits unhealthy{stalled} after stallExitAfterMs of continuous idle with waiting jobs', async () => {
    await withEnv({ GBRAIN_SUPERVISED: undefined }, async () => {
      const probeEngine = makeProbeEngine({
        selectOne: async () => [{ ok: 1 }],
        countWaiting: () => 5, // pretend 5 jobs are waiting for our handler names
      });

      const worker = new MinionWorker(probeEngine, {
        queue: 'default',
        concurrency: 1,
        healthCheckInterval: 30,
        stallWarnAfterMs: 50,
        stallExitAfterMs: 100,
        pollInterval: 50,
        stalledInterval: 10_000,
        maxRssMb: 0,
      });

      worker.register('noop', async () => {});
      // Don't queue any real jobs — claim returns null, inFlight stays 0,
      // jobsCompleted stays 0, idle clock advances.

      const events: Array<{ reason: string; waitingCount?: number }> = [];
      worker.on('unhealthy', (info) => { events.push(info); });

      const startPromise = worker.start();
      // Both thresholds measured from lastCompletionTime (corrected per codex r2):
      //   - tick @ +30ms: idle=30ms, < stallWarnAfterMs(50), no warn
      //   - tick @ +60ms: idle=60ms, > 50, warn fires (stallWarningSince set)
      //   - tick @ +90ms: idle=90ms, < stallExitAfterMs(100), no exit yet
      //   - tick @ +120ms: idle=120ms, > 100 → exit fires (unhealthy event)
      // Poll for the event instead of guessing setTimeout drift.
      await waitFor(() => events.some(e => e.reason === 'stalled'), {
        timeoutMs: 5_000, label: 'stalled unhealthy event',
      });
      worker.stop();
      await startPromise;

      const stalledEvents = events.filter(e => e.reason === 'stalled');
      expect(stalledEvents.length).toBeGreaterThanOrEqual(1);
      expect(stalledEvents[0].waitingCount).toBe(5);
      // The idleMinutes payload should reflect total idle, not warn-since.
      // With idle ~120ms at exit time, idleMinutes rounds to 0 — that's
      // expected; the value is informative, not load-bearing.
    });
  }, 10_000);

  test('inFlight > 0 blocks stall detection (long-running legitimate job)', async () => {
    await withEnv({ GBRAIN_SUPERVISED: undefined }, async () => {
      const probeEngine = makeProbeEngine({
        selectOne: async () => [{ ok: 1 }],
        countWaiting: () => 5,
      });

      const worker = new MinionWorker(probeEngine, {
        queue: 'default',
        concurrency: 1,
        healthCheckInterval: 30,
        stallWarnAfterMs: 50,
        stallExitAfterMs: 100,
        pollInterval: 50,
        stalledInterval: 10_000,
        maxRssMb: 0,
      });

      worker.register('noop', async () => {});

      const events: Array<{ reason: string }> = [];
      worker.on('unhealthy', (info) => { events.push(info); });

      // Inject a fake in-flight entry directly. This bypasses the claim path
      // (which goes through the proxy and complicates the cleanup race) and
      // tests exactly what we want: the stall check's `inFlight.size === 0`
      // gate when there's legitimate ongoing work.
      const fakeInFlight = (worker as unknown as {
        inFlight: Map<number, { lockTimer: NodeJS.Timeout; abort: AbortController; promise: Promise<void> }>
      }).inFlight;
      const fakeAbort = new AbortController();
      const fakePromise = new Promise<void>(() => { /* never resolves */ });
      const fakeTimer = setInterval(() => {}, 60_000); // dummy lock timer
      fakeInFlight.set(99999, { lockTimer: fakeTimer, abort: fakeAbort, promise: fakePromise });

      const startPromise = worker.start();
      // Negative-assertion window: must comfortably exceed stallExitAfterMs
      // (100ms) plus several 30ms health ticks; there is no positive event to
      // poll (the point is that none fires), so the fixed window stays.
      await new Promise(r => setTimeout(r, 350));
      // Remove our fake entry before stop so the worker doesn't wait 30s for it.
      clearInterval(fakeTimer);
      fakeInFlight.delete(99999);
      worker.stop();
      await startPromise;

      // No stall event should fire — inFlight.size > 0 gates the stall check.
      const stalledEvents = events.filter(e => e.reason === 'stalled');
      expect(stalledEvents.length).toBe(0);
    });
  }, 10_000);

  test('regression (D1): waiting jobs of unregistered handler names do NOT trigger stall exit', async () => {
    await withEnv({ GBRAIN_SUPERVISED: undefined }, async () => {
      // The count(*) query is filtered by registered handler names. If handlers=['noop']
      // and the queue has 5 'widget-fn' jobs, the SQL `name = ANY($2)` filter returns 0.
      // The probe engine simulates this by checking handlers before returning a count;
      // we ALSO capture the SQL to assert the predicate text is actually present (so a
      // future refactor that silently drops `AND name = ANY(...)` is caught).
      const capturedStallSql = { sql: null as string | null };
      const probeEngine = makeProbeEngine({
        selectOne: async () => [{ ok: 1 }],
        countWaiting: (handlers) => handlers.includes('widget-fn') ? 5 : 0,
        capturedStallSql,
      });

      const worker = new MinionWorker(probeEngine, {
        queue: 'default',
        concurrency: 1,
        healthCheckInterval: 50,
        stallWarnAfterMs: 100,
        stallExitAfterMs: 200,
        pollInterval: 50,
        stalledInterval: 10_000,
        maxRssMb: 0,
      });

      // Register 'noop' but pretend the queue is full of 'widget-fn' (unhandled).
      worker.register('noop', async () => {});

      const events: Array<{ reason: string }> = [];
      worker.on('unhealthy', (info) => { events.push(info); });

      const startPromise = worker.start();
      // Anchor on the first stall-count probe, then hold a negative window
      // past stallExitAfterMs (200ms); if the D1 fix regressed, stall fires
      // inside it. No positive event exists to poll — the window stays.
      await waitFor(() => capturedStallSql.sql !== null, {
        timeoutMs: 5_000, label: 'stall-count probe ran',
      });
      await new Promise(r => setTimeout(r, 300));
      worker.stop();
      await startPromise;

      // No stall event — the count for 'noop' handlers is 0, so worker is correctly idle.
      const stalledEvents = events.filter(e => e.reason === 'stalled');
      expect(stalledEvents.length).toBe(0);
      // SQL shape assertion: the production query MUST filter by handler names.
      // Without this assertion, a future change that drops the predicate would
      // pass the no-event check above (the handler array would be irrelevant
      // to the underlying DB but our probe just needs to return 0).
      expect(capturedStallSql.sql).not.toBeNull();
      expect(capturedStallSql.sql).toMatch(/name\s*=\s*ANY/i);
    });
  }, 10_000);

  test('regression (R3): constructor throws when stallExitAfterMs <= stallWarnAfterMs', () => {
    // The contract on MinionWorkerOpts.stallExitAfterMs says "Must be >
    // stallWarnAfterMs". Without validation, an exit threshold equal to or
    // less than the warn threshold made the configured exit time a lie
    // (warn fires first, exit can't preempt). The constructor now throws
    // loudly so misconfigurations fail at startup, not at idle-time.
    expect(() => new MinionWorker(engine, {
      stallWarnAfterMs: 200,
      stallExitAfterMs: 100, // less than warn — invalid
    })).toThrow(/stallExitAfterMs.*must be > stallWarnAfterMs/i);

    expect(() => new MinionWorker(engine, {
      stallWarnAfterMs: 100,
      stallExitAfterMs: 100, // equal to warn — also invalid (must be strictly >)
    })).toThrow(/stallExitAfterMs.*must be > stallWarnAfterMs/i);

    // Sanity: defaults (5min warn / 10min exit) construct without throwing.
    expect(() => new MinionWorker(engine, {})).not.toThrow();
  });
});

// --- v0.46 (#4145 R2-1): inFlight generation-safety ---

describe('MinionWorker: inFlight generation-safety (#4145 R2-1)', () => {
  test('a stale execution\'s finally does not delete the reclaimed execution\'s entry', async () => {
    const worker = new MinionWorker(engine, { concurrency: 2, pollInterval: 50, lockDuration: 60000 });
    // Two gated executions of the SAME job id: A (stale, will be superseded)
    // and B (the same-worker re-claim). Each handler invocation blocks on
    // its own gate so the test controls the interleave deterministically.
    const gates: Array<() => void> = [];
    const gatePromises = [
      new Promise<void>(r => gates.push(r)),
      new Promise<void>(r => gates.push(r)),
    ];
    let invocation = 0;
    worker.register('gensafe', async () => {
      const idx = invocation++;
      await gatePromises[idx];
      return { ok: true };
    });

    const row = await queue.add('gensafe', {});

    // Execution A claims + launches.
    const claimedA = await queue.claim('tok-A', 60000, 'default', ['gensafe']);
    expect(claimedA?.id).toBe(row.id);
    (worker as unknown as { launchJob(j: MinionJob, t: string): void }).launchJob(claimedA!, 'tok-A');

    // Simulate the post-force-evict requeue (what handleStalled does) and a
    // SAME-WORKER re-claim as execution B while A's handler is still alive.
    await engine.executeRaw(
      `UPDATE minion_jobs SET status='waiting', lock_token=NULL, lock_until=NULL, started_at=NULL WHERE id = $1`,
      [row.id]
    );
    const claimedB = await queue.claim('tok-B', 60000, 'default', ['gensafe']);
    expect(claimedB?.id).toBe(row.id);
    (worker as unknown as { launchJob(j: MinionJob, t: string): void }).launchJob(claimedB!, 'tok-B');

    const inFlight = (worker as unknown as { inFlight: Map<number, { lockToken: string }> }).inFlight;
    expect(inFlight.get(row.id)?.lockToken).toBe('tok-B');

    // Release stale execution A: its completeJob is fenced-false ("completion
    // dropped") and its finally fires. Pre-fix, that finally deleted B's
    // entry by bare job.id — the R2-1 generation race. A's pipeline has no
    // external observable when the fix holds (a negative assertion), so a
    // fixed grace window is the check.
    gates[0]();
    await new Promise(r => setTimeout(r, 150));
    expect(inFlight.get(row.id)?.lockToken).toBe('tok-B'); // B survived A's finally

    // Release B: its OWN finally removes its own entry and completes the row.
    gates[1]();
    await waitFor(() => !inFlight.has(row.id), { timeoutMs: 5_000, label: 'execution B drained' });
    expect(inFlight.has(row.id)).toBe(false);
    const final = await queue.getJob(row.id);
    expect(final!.status).toBe('completed');
  });
});

// --- v0.46 (#4145 CDX-7): stall-sweep reclaim grace ---

describe('MinionQueue: stall-sweep reclaim grace (#4145)', () => {
  async function activeJobWithLockLapsedMs(msAgo: number): Promise<MinionJob> {
    await queue.add('grace-test', {});
    const claimed = await queue.claim('tok-grace', 60000, 'default', ['grace-test']);
    await engine.executeRaw(
      `UPDATE minion_jobs SET lock_until = now() - ($1::double precision * interval '1 millisecond') WHERE id = $2`,
      [msAgo, claimed!.id]
    );
    return claimed!;
  }

  test('a lock that lapsed WITHIN the grace window is NOT reclaimed (starved-owner head start)', async () => {
    const job = await activeJobWithLockLapsedMs(5_000); // grace default = 15_000
    const { requeued, dead } = await queue.handleStalled();
    expect(requeued).toHaveLength(0);
    expect(dead).toHaveLength(0);
    const still = await queue.getJob(job.id);
    expect(still!.status).toBe('active');
    expect(still!.lock_token).toBe('tok-grace');
  });

  test('a lock that lapsed BEYOND the grace window IS reclaimed', async () => {
    const job = await activeJobWithLockLapsedMs(20_000);
    const { requeued, dead } = await queue.handleStalled();
    expect(requeued).toHaveLength(1);
    expect(dead).toHaveLength(0);
    const requeuedJob = await queue.getJob(job.id);
    expect(requeuedJob!.status).toBe('waiting');
    expect(requeuedJob!.lock_token).toBeNull();
  });

  test('grace=0 restores the exact legacy predicate (lock_until < now())', async () => {
    const job = await activeJobWithLockLapsedMs(100);
    const { requeued } = await queue.handleStalled(0);
    expect(requeued).toHaveLength(1);
    const requeuedJob = await queue.getJob(job.id);
    expect(requeuedJob!.status).toBe('waiting');
  });

  test('env knob GBRAIN_MINION_STALL_RECLAIM_GRACE_MS resolves; bad value warns + falls back', async () => {
    const { resolveStallReclaimGraceMs, DEFAULT_STALL_RECLAIM_GRACE_MS, _resetStallGraceWarningsForTests } =
      await import('../src/core/minions/queue.ts');
    _resetStallGraceWarningsForTests();
    expect(resolveStallReclaimGraceMs({})).toBe(DEFAULT_STALL_RECLAIM_GRACE_MS);
    expect(resolveStallReclaimGraceMs({ GBRAIN_MINION_STALL_RECLAIM_GRACE_MS: '0' })).toBe(0);
    expect(resolveStallReclaimGraceMs({ GBRAIN_MINION_STALL_RECLAIM_GRACE_MS: '25000' })).toBe(25_000);
    expect(resolveStallReclaimGraceMs({ GBRAIN_MINION_STALL_RECLAIM_GRACE_MS: '-5' })).toBe(DEFAULT_STALL_RECLAIM_GRACE_MS);
    expect(resolveStallReclaimGraceMs({ GBRAIN_MINION_STALL_RECLAIM_GRACE_MS: 'abc' })).toBe(DEFAULT_STALL_RECLAIM_GRACE_MS);
    // Cap: an absurd digit string must not become Infinity and push the
    // sweep cutoff to -infinity (which would disable stalled-job recovery).
    expect(resolveStallReclaimGraceMs({ GBRAIN_MINION_STALL_RECLAIM_GRACE_MS: '9'.repeat(40) })).toBe(600_000);
  });

  test('grace env warn fires once per bad value, not per call (warn-once dedupe)', async () => {
    const { resolveStallReclaimGraceMs, _resetStallGraceWarningsForTests } =
      await import('../src/core/minions/queue.ts');
    _resetStallGraceWarningsForTests();
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      resolveStallReclaimGraceMs({ GBRAIN_MINION_STALL_RECLAIM_GRACE_MS: 'bogus' });
      resolveStallReclaimGraceMs({ GBRAIN_MINION_STALL_RECLAIM_GRACE_MS: 'bogus' });
    } finally {
      process.stderr.write = origWrite;
    }
    expect(captured.filter(c => c.includes('GBRAIN_MINION_STALL_RECLAIM_GRACE_MS')).length).toBe(1);
  });
});

// --- v0.46 (#4145): per-job lock_duration_ms — three-layer lease resolution ---

describe('MinionQueue: per-job lock lease (#4145)', () => {
  test('claim stamps the handler-map default (300s) for subagent and derives lock_until from it', async () => {
    await queue.add('subagent', {}, undefined, { allowProtectedSubmit: true });
    const before = Date.now();
    const claimed = await queue.claim('tok-lease', 30_000, 'default', ['subagent']);
    expect(claimed).not.toBeNull();
    expect(claimed!.lock_duration_ms).toBe(300_000); // stamped from the map
    const horizon = claimed!.lock_until!.getTime() - before;
    // lock_until derives from the 300s lease, NOT the worker's 30s default.
    expect(horizon).toBeGreaterThan(250_000);
    expect(horizon).toBeLessThan(360_000);
  });

  test('an unmapped handler keeps NULL lease → worker default horizon (legacy behavior)', async () => {
    await queue.add('shortling', {});
    const before = Date.now();
    const claimed = await queue.claim('tok-short', 30_000, 'default', ['shortling']);
    expect(claimed!.lock_duration_ms).toBeNull();
    const horizon = claimed!.lock_until!.getTime() - before;
    expect(horizon).toBeGreaterThan(20_000);
    expect(horizon).toBeLessThan(40_000);
  });

  test('explicit submit value wins over the map and is clamped to [5s, 1h]', async () => {
    const explicit = await queue.add('subagent', {}, { lock_duration_ms: 120_000 }, { allowProtectedSubmit: true });
    expect(explicit.lock_duration_ms).toBe(120_000);

    const floored = await queue.add('floorling', {}, { lock_duration_ms: 1 });
    expect(floored.lock_duration_ms).toBe(5_000);

    const ceiled = await queue.add('ceiling', {}, { lock_duration_ms: 99_999_999 });
    expect(ceiled.lock_duration_ms).toBe(3_600_000);
  });

  test('claim precedence: an explicit row lease beats the handler map at the claim UPDATE', async () => {
    // The claim COALESCE is (row, map, worker default) in that order — if it
    // were ever flipped (map before row) the explicit lease would be silently
    // overwritten at claim while the add()-time tests stayed green.
    await queue.add('subagent', {}, { lock_duration_ms: 120_000 }, { allowProtectedSubmit: true });
    const before = Date.now();
    const claimed = await queue.claim('tok-precedence', 30_000, 'default', ['subagent']);
    expect(claimed!.lock_duration_ms).toBe(120_000); // row wins, not the 300s map
    const horizon = claimed!.lock_until!.getTime() - before;
    expect(horizon).toBeGreaterThan(90_000);
    expect(horizon).toBeLessThan(150_000);
  });

  test('worker renews with the per-job lease, not the worker default (launchJob wiring)', async () => {
    // GAP-1 pin: effectiveLockMs = row lease drives BOTH the renewal call's
    // duration arg and the cadence. A 5s lease (clamp floor) under a worker
    // configured at 60s yields a 2.5s cadence — observable within test time.
    const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 50, lockDuration: 60_000 });
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    worker.register('leased-renewal', async () => { await gate; return { ok: true }; });

    await queue.add('leased-renewal', {}, { lock_duration_ms: 5_000 });
    const claimed = await queue.claim('tok-lease-renew', 5_000, 'default', ['leased-renewal']);
    expect(claimed!.lock_duration_ms).toBe(5_000);

    const durs: number[] = [];
    const q = (worker as unknown as { queue: MinionQueue }).queue;
    const orig = q.renewLock.bind(q);
    q.renewLock = ((id: number, tok: string, dur: number, opts?: { signal?: AbortSignal }) => {
      durs.push(dur);
      return orig(id, tok, dur, opts);
    }) as typeof q.renewLock;

    (worker as unknown as { launchJob(j: MinionJob, t: string): void }).launchJob(claimed!, 'tok-lease-renew');
    // Cadence = min(5000/2, 60000) = 2500ms; wait for at least one tick.
    // release() runs in finally so a timeout can't leak the gated handler.
    try {
      await waitFor(() => durs.length > 0, { timeoutMs: 8_000, label: 'per-job lease renewal tick' });
    } finally {
      release();
    }
    await waitForJobStatus(claimed!.id, 'completed');
    expect(durs.length).toBeGreaterThanOrEqual(1);
    // Every renewal used the per-job 5s lease — NOT the worker's 60s default.
    expect(new Set(durs)).toEqual(new Set([5_000]));
  });

  test('MCP submit_job threads lock_duration_ms through the shared clamp (round-trip)', async () => {
    const { operationsByName } = await import('../src/core/operations.ts');
    const op = operationsByName['submit_job'];
    const ctx = { engine, remote: false, dryRun: false } as never;

    const clamped = await op.handler(ctx, { name: 'lease-op-test', lock_duration_ms: 99_999_999 }) as { id: number };
    expect((await queue.getJob(clamped.id))!.lock_duration_ms).toBe(3_600_000); // ceiling

    const exact = await op.handler(ctx, { name: 'lease-op-test', lock_duration_ms: 60_000 }) as { id: number };
    expect((await queue.getJob(exact.id))!.lock_duration_ms).toBe(60_000);

    // Boundary pin: 0 is falsy through the op's `|| undefined` coercion and
    // falls to the handler-map/worker default (NULL for an unmapped name) —
    // the documented remote semantics, distinct from the CLI's exit-1 reject.
    const zero = await op.handler(ctx, { name: 'lease-op-test', lock_duration_ms: 0 }) as { id: number };
    expect((await queue.getJob(zero.id))!.lock_duration_ms).toBeNull();
  });

  test('idempotent re-submit never mutates the first submitter\'s lease (INSERT-only)', async () => {
    const first = await queue.add('lease-idem', {}, { lock_duration_ms: 60_000, idempotency_key: 'lease-key-1' });
    expect(first.lock_duration_ms).toBe(60_000);
    const second = await queue.add('lease-idem', {}, { lock_duration_ms: 600_000, idempotency_key: 'lease-key-1' });
    expect(second.id).toBe(first.id);
    expect(second.lock_duration_ms).toBe(60_000); // unchanged
  });

  test('REGRESSION pin: NULL-lease rows keep the exact legacy wall-clock null-fallback', async () => {
    // handleWallClockTimeouts' null-timeout branch is COALESCE(lock_duration_ms, $1)
    // — rows WITHOUT a lease must behave exactly as before (worker default drives
    // the 2x * max_stalled bound), and rows WITH a lease use their own.
    const legacy = await queue.add('wallclock-legacy', {}, { max_stalled: 1 });
    await queue.claim('tok-wc-legacy', 1_000, 'default', ['wallclock-legacy']);
    // started 10s ago; NULL lease → threshold = 2 * 1000ms (worker default $1) * 1 = 2s → dead.
    await engine.executeRaw(
      `UPDATE minion_jobs SET started_at = now() - interval '10 seconds', timeout_ms = NULL, timeout_at = NULL WHERE id = $1`,
      [legacy.id]
    );
    const killedLegacy = await queue.handleWallClockTimeouts(1_000);
    expect(killedLegacy.map(j => j.id)).toContain(legacy.id);

    // Same shape WITH a 60s lease: threshold = 2 * 60000 * 1 = 120s → survives 10s.
    const leased = await queue.add('wallclock-leased', {}, { max_stalled: 1, lock_duration_ms: 60_000 });
    await queue.claim('tok-wc-leased', 1_000, 'default', ['wallclock-leased']);
    await engine.executeRaw(
      `UPDATE minion_jobs SET started_at = now() - interval '10 seconds', timeout_ms = NULL, timeout_at = NULL WHERE id = $1`,
      [leased.id]
    );
    const killedLeased = await queue.handleWallClockTimeouts(1_000);
    expect(killedLeased.map(j => j.id)).not.toContain(leased.id);
    const survivor = await queue.getJob(leased.id);
    expect(survivor!.status).toBe('active');
  });

  test('repeated infrastructure evictions eventually dead-letter via max_stalled (lifetime accumulation pin)', async () => {
    // The "no attempt burned" contract survives only max_stalled - 1
    // requeues: stalled_counter accumulates across the job's lifetime and
    // the final stall burns one attempt and dead-letters. Known coverage
    // gap flagged in the #4145 review — pinned here.
    const job = await queue.add('evict-accumulate', {}, { max_stalled: 3 });
    for (let round = 1; round <= 2; round++) {
      const claimed = await queue.claim(`tok-ev-${round}`, 30_000, 'default', ['evict-accumulate']);
      expect(claimed!.id).toBe(job.id);
      await engine.executeRaw(
        `UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1`,
        [job.id]
      );
      const { requeued, dead } = await queue.handleStalled();
      expect(requeued.map(j => j.id)).toContain(job.id);
      expect(dead).toHaveLength(0);
      const after = await queue.getJob(job.id);
      expect(after!.stalled_counter).toBe(round);
      expect(after!.attempts_made).toBe(0); // no attempt burned on requeue
    }
    // Third stall: stalled_counter + 1 >= max_stalled → dead + attempt burned.
    await queue.claim('tok-ev-3', 30_000, 'default', ['evict-accumulate']);
    await engine.executeRaw(
      `UPDATE minion_jobs SET lock_until = now() - interval '30 seconds' WHERE id = $1`,
      [job.id]
    );
    const finalSweep = await queue.handleStalled();
    expect(finalSweep.dead.map(j => j.id)).toContain(job.id);
    const final = await queue.getJob(job.id);
    expect(final!.status).toBe('dead');
    expect(final!.attempts_made).toBe(1);
    expect(final!.error_text).toBe('max stalled count exceeded');
  });
});
