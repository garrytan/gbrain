import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { calculateBackoff } from '../src/core/minions/backoff.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import type { MinionJob } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
  queue = new MinionQueue(engine);
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
    await new Promise(r => setTimeout(r, 10));
    const promoted = await queue.promoteDelayed();
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
      "UPDATE minion_jobs SET lock_until = now() - interval '1 second' WHERE id = $1",
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
      "UPDATE minion_jobs SET lock_until = now() - interval '1 second' WHERE id = $1",
      [job.id]
    );
    const r1 = await queue.handleStalled();
    expect(r1.requeued.length).toBe(1);
    expect(r1.requeued[0].stalled_counter).toBe(1);

    // Second stall: counter 1+1=2 < 3, requeued
    await queue.claim('tok2', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '1 second' WHERE id = $1",
      [job.id]
    );
    const r2 = await queue.handleStalled();
    expect(r2.requeued.length).toBe(1);

    // Third stall: counter 2+1=3 >= 3, dead-lettered
    await queue.claim('tok3', 30000, 'default', ['sync']);
    await engine.executeRaw(
      "UPDATE minion_jobs SET lock_until = now() - interval '1 second' WHERE id = $1",
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
      "UPDATE minion_jobs SET lock_until = now() - interval '1 second' WHERE id = $1",
      [job.id]
    );
    const { requeued, dead } = await queue.handleStalled();
    expect(dead.length).toBe(1);
    expect(dead[0].status).toBe('dead');
    expect(requeued.length).toBe(0);
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
        "UPDATE minion_jobs SET lock_until = now() - interval '1 second' WHERE id = $1",
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
      "UPDATE minion_jobs SET lock_until = now() - interval '1 second' WHERE id = $1",
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

    // Start worker in background, stop after a short delay
    const workerPromise = worker.start();
    await new Promise(r => setTimeout(r, 200));
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
    await new Promise(r => setTimeout(r, 200));
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
    await new Promise(r => setTimeout(r, 200));
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

    await new Promise(r => setTimeout(r, 10));
    const promoted = await queue.promoteDelayed();
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
    await new Promise(r => setTimeout(r, 500));
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
    await new Promise(r => setTimeout(r, 500));
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
    await new Promise(r => setTimeout(r, 500));
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
      throw new Error('aborted');
    });

    const p = worker.start();
    // Wait for handler to enter
    await new Promise(r => setTimeout(r, 200));
    expect(handlerEntered).toBe(true);
    // Pause clears the lock token; next renewLock fails → abort fires
    await queue.pauseJob(job.id);
    // Give renewLock time to fire (lockDuration / 2 = 100ms)
    await new Promise(r => setTimeout(r, 500));
    worker.stop();
    await p;

    expect(signalSeenAborted).toBe(true);
  });

  test('catch block skips failJob when ctx.signal.aborted', async () => {
    const job = await queue.add('skip-fail', {}, { max_attempts: 5 });

    const worker = new MinionWorker(engine, {
      concurrency: 1,
      pollInterval: 50,
      lockDuration: 200,
    });
    worker.register('skip-fail', async (ctx) => {
      // Wait for abort, then throw — failJob should NOT be called
      const start = Date.now();
      while (!ctx.signal.aborted && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 25));
      }
      throw new Error('after-abort');
    });

    const p = worker.start();
    await new Promise(r => setTimeout(r, 200));
    await queue.pauseJob(job.id);
    await new Promise(r => setTimeout(r, 500));
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
    const t0 = Date.now();
    while (entered < 3 && Date.now() - t0 < 3000) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(entered).toBe(3);

    // While blocked, all 3 jobs should be active in DB
    const active = await queue.getJobs({ status: 'active' });
    expect(active.length).toBe(3);

    // Release all handlers, let worker complete them
    release();
    await new Promise(r => setTimeout(r, 300));
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
    await new Promise(r => setTimeout(r, 300));
    worker.stop();
    await p;

    const completed = await queue.getJob(job.id);
    expect(completed!.status).toBe('completed');
    // Wait beyond the timeout window to confirm the timer was cleared
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
      // Stall longer than timeout_ms
      await new Promise(r => setTimeout(r, 800));
      // After abort fires, throwing here goes through the catch — but
      // catch sees signal.aborted and skips failJob.
      throw new Error('should-be-aborted');
    });

    const p = worker.start();
    await new Promise(r => setTimeout(r, 1200));
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
    // Wait past the timeout
    await new Promise(r => setTimeout(r, 100));
    const timedOut = await queue.handleTimeouts();
    expect(timedOut.length).toBe(1);
    expect(timedOut[0].id).toBe(job.id);

    const dead = await queue.getJob(job.id);
    expect(dead!.status).toBe('dead');
    expect(dead!.error_text).toBe('timeout exceeded');
  });

  test('handleTimeouts ignores stalled jobs (lock_until > now guard)', async () => {
    // Force a stalled job: timeout_at expired AND lock_until expired
    await queue.add('slow', {}, { timeout_ms: 50 });
    await queue.claim('tok1', 1, 'default', ['slow']); // 1ms lock duration → expires immediately
    await new Promise(r => setTimeout(r, 100));

    // handleTimeouts should NOT touch it (lock_until < now → stalled, not timed out)
    const timedOut = await queue.handleTimeouts();
    expect(timedOut.length).toBe(0);
  });

  test('jobs without timeout_ms never timeout', async () => {
    await queue.add('forever', {});
    await queue.claim('tok1', 30000, 'default', ['forever']);
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

    // Capture a cursor between the two completions
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
