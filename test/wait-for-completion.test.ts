/**
 * waitForCompletion tests. Uses PGLite in-memory so the poll path exercises
 * a real getJob over a real engine.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { waitForCompletion, TimeoutError, __testing } from '../src/core/minions/wait-for-completion.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('waitForCompletion terminal states', () => {
  test('TERMINAL_STATES covers every terminal MinionJobStatus value', () => {
    expect(__testing.TERMINAL_STATES).toEqual(['completed', 'failed', 'dead', 'cancelled']);
  });

  test('returns immediately when job already completed (fast path)', async () => {
    const j = await queue.add('t', {});
    const claimed = await queue.claim('tok', 30000, 'default', ['t']);
    await queue.completeJob(claimed!.id, 'tok', { ok: true });

    const t0 = Date.now();
    const res = await waitForCompletion(queue, j.id, { pollMs: 500 });
    expect(res.status).toBe('completed');
    expect(Date.now() - t0).toBeLessThan(300); // no full poll cycle
  });

  test('returns when job transitions to failed mid-wait', async () => {
    const j = await queue.add('t', {});
    const p = waitForCompletion(queue, j.id, { pollMs: 25, timeoutMs: 5000 });
    // Transition the job to failed after a brief delay.
    setTimeout(async () => {
      const claimed = await queue.claim('tok', 30000, 'default', ['t']);
      await queue.failJob(claimed!.id, 'tok', 'boom', 'failed');
    }, 60);
    const res = await p;
    expect(res.status).toBe('failed');
  });

  test('returns when job transitions to cancelled', async () => {
    const j = await queue.add('t', {});
    const p = waitForCompletion(queue, j.id, { pollMs: 25, timeoutMs: 5000 });
    setTimeout(() => { queue.cancelJob(j.id); }, 60);
    const res = await p;
    expect(res.status).toBe('cancelled');
  });

  test('throws TimeoutError when job stays non-terminal past timeoutMs', async () => {
    const j = await queue.add('t', {});
    await expect(
      waitForCompletion(queue, j.id, { pollMs: 25, timeoutMs: 100 })
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  test('TimeoutError carries the jobId and elapsedMs', async () => {
    const j = await queue.add('t', {});
    try {
      await waitForCompletion(queue, j.id, { pollMs: 25, timeoutMs: 80 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      const te = e as TimeoutError;
      expect(te.jobId).toBe(j.id);
      expect(te.elapsedMs).toBeGreaterThanOrEqual(80);
    }
  });

  test('TimeoutError does NOT cancel the job', async () => {
    const j = await queue.add('t', {});
    try {
      await waitForCompletion(queue, j.id, { pollMs: 25, timeoutMs: 80 });
    } catch {}
    const still = await queue.getJob(j.id);
    expect(still?.status).toBe('waiting');
  });

  test('AbortSignal exits loop early without throwing', async () => {
    const j = await queue.add('t', {});
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const res = await waitForCompletion(queue, j.id, {
      pollMs: 25,
      timeoutMs: 5000,
      signal: ac.signal,
    });
    expect(res.id).toBe(j.id);
    // Still waiting — we just stopped polling.
    expect(res.status).toBe('waiting');
  });

  test('throws when job id does not exist', async () => {
    await expect(waitForCompletion(queue, 99_999, { pollMs: 10, timeoutMs: 100 }))
      .rejects.toThrow(/not found/);
  });
});
