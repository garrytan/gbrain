/**
 * waitForCompletion tests. Uses PGLite in-memory so the poll path exercises
 * a real getJob over a real engine.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { waitForCompletion, waitForCompletionRenewing, TimeoutError, __testing } from '../src/core/minions/wait-for-completion.ts';

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

describe('waitForCompletionRenewing', () => {
  // Claim + complete the named job after `afterMs`. Returned promise is
  // awaited alongside the wait so a fixture failure surfaces instead of
  // vanishing in a detached timer callback.
  function completeLater(name: string, afterMs: number): Promise<void> {
    const token = `renew-tok-${afterMs}-${Math.random().toString(36).slice(2)}`;
    return (async () => {
      await new Promise(r => setTimeout(r, afterMs));
      const claimed = await queue.claim(token, 30_000, 'default', [name]);
      if (!claimed) throw new Error(`nothing to claim for ${name}`);
      await queue.completeJob(claimed.id, token, { done: true });
    })();
  }

  test('multi-chunk wait resolves with the terminal job after crossing >=2 chunk boundaries', async () => {
    const j = await queue.add('t', {});
    let renews = 0;
    const t0 = Date.now();
    const [res] = await Promise.all([
      waitForCompletionRenewing(queue, j.id, {
        pollMs: 25,
        timeoutMs: 30_000,
        chunkMs: 50, // clamped to the 1s floor — 2.3s completion spans >=2 chunks
        renew: async () => { renews++; },
      }),
      completeLater('t', 2300),
    ]);
    expect(res.id).toBe(j.id);
    expect(res.status).toBe('completed');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
    expect(renews).toBeGreaterThanOrEqual(2);
  });

  test('renew is invoked between chunks when the wait spans a chunk boundary', async () => {
    const j = await queue.add('t', {});
    let renews = 0;
    const [res] = await Promise.all([
      waitForCompletionRenewing(queue, j.id, {
        pollMs: 25,
        timeoutMs: 30_000,
        chunkMs: 50,
        renew: async () => { renews++; },
      }),
      completeLater('t', 1300),
    ]);
    expect(res.status).toBe('completed');
    expect(renews).toBeGreaterThanOrEqual(1);
  });

  test('a throwing renew is swallowed: the wait continues and still resolves', async () => {
    const j = await queue.add('t', {});
    let renews = 0;
    const [res] = await Promise.all([
      waitForCompletionRenewing(queue, j.id, {
        pollMs: 25,
        timeoutMs: 30_000,
        chunkMs: 50,
        renew: async () => { renews++; throw new Error('lease renewal exploded'); },
      }),
      completeLater('t', 1300),
    ]);
    expect(res.status).toBe('completed');
    expect(renews).toBeGreaterThanOrEqual(1); // it DID throw at least once and was swallowed
  });

  test('a non-TimeoutError from the inner wait rethrows immediately without renewing', async () => {
    let renews = 0;
    const renew = async () => { renews++; };

    // Fast-path arm: the inner first read throws 'not found'.
    await expect(
      waitForCompletionRenewing(queue, 99_999, { pollMs: 10, timeoutMs: 30_000, renew })
    ).rejects.toThrow(/not found/);

    // Poll-loop arm: the row vanishes mid-wait and the inner poll throws.
    const j = await queue.add('t', {});
    const p = waitForCompletionRenewing(queue, j.id, { pollMs: 25, timeoutMs: 30_000, renew });
    setTimeout(() => { void engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [j.id]); }, 60);
    await expect(p).rejects.toThrow(/disappeared mid-wait/);

    expect(renews).toBe(0);
  });

  test('total-deadline exhaustion propagates TimeoutError with jobId/elapsedMs and never renews or cancels', async () => {
    const j = await queue.add('t', {});
    let renews = 0;
    const t0 = Date.now();
    try {
      await waitForCompletionRenewing(queue, j.id, {
        pollMs: 25,
        timeoutMs: 150,
        chunkMs: 50,
        renew: async () => { renews++; },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      const te = e as TimeoutError;
      expect(te.jobId).toBe(j.id);
      expect(te.elapsedMs).toBeGreaterThan(0);
    }
    // The whole timeoutMs budget was honored before the throw.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    // Deadline check precedes renew in the catch, so the final timeout never renews.
    expect(renews).toBe(0);
    // Like the plain wait, timing out never cancels the job.
    expect((await queue.getJob(j.id))?.status).toBe('waiting');
  });

  test('chunkMs below the 1s floor is clamped: a sub-second completion sees zero chunk timeouts', async () => {
    const j = await queue.add('t', {});
    let renews = 0;
    const [res] = await Promise.all([
      waitForCompletionRenewing(queue, j.id, {
        pollMs: 25,
        timeoutMs: 30_000,
        chunkMs: 1,
        renew: async () => { renews++; },
      }),
      completeLater('t', 200),
    ]);
    expect(res.status).toBe('completed');
    // If chunkMs 1 were honored literally, every 1ms chunk would time out and
    // renew would have fired dozens of times before the 200ms completion.
    expect(renews).toBe(0);
  });

  test('resolves across a chunk boundary when no renew option is provided', async () => {
    const j = await queue.add('t', {});
    const t0 = Date.now();
    const [res] = await Promise.all([
      waitForCompletionRenewing(queue, j.id, { pollMs: 25, timeoutMs: 30_000, chunkMs: 50 }),
      completeLater('t', 1300),
    ]);
    expect(res.status).toBe('completed');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000); // crossed >=1 chunk boundary renew-less
  });
});
