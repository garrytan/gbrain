/**
 * v0.41.25.0 (#1570) — FactsQueue.drainPending contract.
 *
 * Per codex finding 9 from /codex review of the v0.41.25 plan: drain is
 * DIFFERENT from shutdown. Shutdown aborts in-flight via internal signal;
 * drain lets in-flight finish naturally. This file pins the distinction
 * so any future refactor that conflates them re-fails.
 *
 * Hermetic: no engine, no DATABASE_URL.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { FactsQueue, __resetFactsQueueForTests } from '../src/core/facts/queue.ts';

beforeEach(() => {
  __resetFactsQueueForTests();
});

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('FactsQueue.drainPending — codex F9 distinct-from-shutdown contract', () => {
  test('returns {drained:0,unfinished:0} fast when queue is empty', async () => {
    const q = new FactsQueue();
    const start = Date.now();
    const result = await q.drainPending({ timeout: 1000 });
    const elapsed = Date.now() - start;
    expect(result).toEqual({ drained: 0, unfinished: 0 });
    // Fast path: empty drain should NOT spend the full timeout.
    expect(elapsed).toBeLessThan(50);
  });

  test('awaits in-flight to settle WITHOUT aborting (the codex F9 contract)', async () => {
    // Distinct from shutdown(): shutdown calls internalAbort.abort() which
    // makes runEntry's catch see an AbortError and counters bump
    // dropped_shutdown. drainPending must let the job run to completion
    // so the facts:absorb post-completion log actually fires.
    const q = new FactsQueue({ shutdownGraceMs: 5000 });
    let completed = false;
    let signalSeenAborted = false;
    q.enqueue(async (signal) => {
      // Sleep so drain has a real wait to do.
      await sleep(60);
      // Witness the signal state at completion — should NOT be aborted.
      if (signal.aborted) signalSeenAborted = true;
      completed = true;
    }, 'sess');
    // Give pump a microtask to claim the job.
    await sleep(5);
    const result = await q.drainPending({ timeout: 1000 });
    expect(completed).toBe(true);
    expect(signalSeenAborted).toBe(false);
    expect(result.unfinished).toBe(0);
    expect(result.drained).toBeGreaterThan(0);
    // shutdown's dropped_shutdown counter MUST NOT increment from drain.
    expect(q.getCounters().dropped_shutdown).toBe(0);
    expect(q.getCounters().completed).toBe(1);
  });

  test('returns with unfinished > 0 when timeout fires; does NOT hang or abort', async () => {
    const q = new FactsQueue();
    let completed = false;
    // Job runs longer than the drain timeout.
    q.enqueue(async () => {
      await sleep(300);
      completed = true;
    }, 'sess');
    await sleep(5); // give pump a tick to claim
    const start = Date.now();
    const result = await q.drainPending({ timeout: 80 });
    const elapsed = Date.now() - start;
    // Drain returned WITHIN timeout window (small slack for scheduler).
    expect(elapsed).toBeLessThan(180);
    expect(result.unfinished).toBeGreaterThan(0);
    // Job was NOT aborted — it should still be running.
    expect(completed).toBe(false);
    // Let it finish so the test process doesn't leak the timer.
    await sleep(400);
    expect(completed).toBe(true);
  });

  test('default timeout is 1000ms when opts.timeout omitted', async () => {
    const q = new FactsQueue();
    // Job that runs forever (well, 2s, longer than default).
    q.enqueue(async () => { await sleep(2000); }, 'sess');
    await sleep(5);
    const start = Date.now();
    const result = await q.drainPending();
    const elapsed = Date.now() - start;
    // Should return at the default 1000ms timeout, NOT 2000ms.
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(1200);
    expect(result.unfinished).toBeGreaterThan(0);
  });
});
