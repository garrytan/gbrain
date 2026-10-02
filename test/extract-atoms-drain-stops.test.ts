/**
 * #5809 / #5832 — how the extract_atoms drain stops.
 *
 * Protects: a drain job's timeout/cancel, the cycle lock's lease loss and the
 * job deadline stop the drain (hard stop) and are reported as
 * `stopped: aborted | lock_lost | deadline` with the partial counters, while
 * the window (soft stop) never interrupts the batch in flight. Backlog counts
 * are bounded so a blocked count cannot keep the cycle lock refreshing.
 * Regression caught: the drain ignored every signal and only checked the
 * window between batches, so one long batch held `gbrain-cycle:<source>` for
 * hours and nightly dream skipped. Existing drain tests inject a lock that
 * never aborts and a clock-only window, so they cannot see any of this.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withRefreshingLock } from '../src/core/db-lock.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  runExtractAtomsDrain,
  runExtractAtomsDrainForSource,
  type ExtractAtomsDrainDeps,
} from '../src/core/cycle/extract-atoms-drain.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const untilAborted = (signal: AbortSignal, capMs = 5_000) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { resolve(); return; }
  const t = setTimeout(() => reject(new Error('signal never aborted')), capMs);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

describe('hard stops: job signal and lock lease', () => {
  it.each([
    { aborts: 'job', stopped: 'aborted', abortDuringBatch: 0, expectedBatches: 0 },
    { aborts: 'job', stopped: 'aborted', abortDuringBatch: 1, expectedBatches: 1 },
    { aborts: 'lock', stopped: 'lock_lost', abortDuringBatch: 0, expectedBatches: 0 },
    { aborts: 'lock', stopped: 'lock_lost', abortDuringBatch: 1, expectedBatches: 1 },
  ])('a $aborts abort (batch $abortDuringBatch) stops with $stopped, reports the last count, skips progress', async ({ aborts, stopped, abortDuringBatch, expectedBatches }) => {
    const job = new AbortController();
    const lock = new AbortController();
    const aborting = aborts === 'job' ? job : lock;
    const reason = new Error(`${aborts} aborted`);
    if (abortDuringBatch === 0) aborting.abort(reason);
    let batches = 0;
    let lockSettled = false;
    const progress: number[] = [];
    const seen: AbortSignal[] = [];
    const result = await runExtractAtomsDrain(
      {
        withLock: async (work) => { try { return await work(lock.signal); } finally { lockSettled = true; } },
        countRemaining: async () => 7,
        runBatch: async ({ signal }) => {
          batches++;
          seen.push(signal);
          if (batches === abortDuringBatch) aborting.abort(reason);
          return { extracted: 2, skipped: 0 };
        },
        now: () => 0,
        onBatch: ({ batch }) => progress.push(batch),
      },
      { windowMs: 1_000_000, signal: job.signal },
    );
    expect(result).toMatchObject({ stopped, batches: expectedBatches, extracted: expectedBatches * 2, status: 'ok' });
    expect(result.remaining).toBe(expectedBatches ? 7 : null);
    expect(seen.map((s) => s.reason)).toEqual(Array(expectedBatches).fill(reason));
    expect(progress).toEqual([]);
    expect(lockSettled).toBe(true);
  });

  it('the job deadline reaches the batch in flight and stops with deadline', async () => {
    const counts: number[] = [];
    const result = await runExtractAtomsDrain(
      {
        withLock: (work) => work(new AbortController().signal),
        countRemaining: async () => { counts.push(1); return 12; },
        runBatch: async ({ signal }) => {
          await untilAborted(signal);
          expect((signal.reason as Error).message).toContain('job deadline reached');
          return { extracted: 3, skipped: 0 };
        },
        now: Date.now,
      },
      { windowMs: 1_000_000, deadlineAtMs: Date.now() + 50 },
    );
    expect(result).toMatchObject({ stopped: 'deadline', batches: 1, extracted: 3, remaining: 12 });
    expect(counts).toHaveLength(1);
  });
});

describe('soft stop: the window', () => {
  it('a window ending mid-batch stops the batch at its next item without aborting the call in flight', async () => {
    let hardAbortedAtWindow: boolean | null = null;
    let batches = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: (work) => work(new AbortController().signal),
        countRemaining: async () => 5,
        runBatch: async ({ signal, stopSignal }) => {
          batches++;
          await untilAborted(stopSignal);
          hardAbortedAtWindow = signal.aborted;
          return { extracted: 1, skipped: 0 };
        },
        now: Date.now,
      },
      { windowMs: 50 },
    );
    expect(hardAbortedAtWindow as boolean | null).toBe(false);
    expect(batches).toBe(1);
    expect(result).toMatchObject({ stopped: 'window', extracted: 1, remaining: 5 });
  });
});

describe('bounded backlog counts', () => {
  it('a count that never answers is abandoned at its bound and reported as unknown', async () => {
    let calls = 0;
    const started = Date.now();
    const result = await runExtractAtomsDrain(
      {
        withLock: (work) => work(new AbortController().signal),
        countRemaining: (signal) => {
          calls++;
          return calls === 1 ? Promise.resolve(4) : new Promise(() => { void signal; });
        },
        runBatch: async () => ({ extracted: 1, skipped: 0 }),
        now: Date.now,
      },
      { windowMs: 1_000_000, maxBatches: 1, countTimeoutMs: 100 },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ stopped: 'max_batches', remaining: null, batches: 1 });
  });

  it('cancelling while the final recount is blocked releases the real cycle lock within the bound', async () => {
    const job = new AbortController();
    let calls = 0;
    let countSignal: AbortSignal | null = null;
    const started = Date.now();
    const result = await runExtractAtomsDrain(
      {
        withLock: (work) => withRefreshingLock(engine, 'gbrain-cycle:drain-bound', (signal) => work(signal), { ttlMinutes: 5 }),
        countRemaining: (signal) => {
          calls++;
          if (calls === 1) return Promise.resolve(9);
          countSignal = signal;
          setTimeout(() => job.abort(new Error('timeout')), 50);
          return new Promise(() => {});
        },
        runBatch: async () => ({ extracted: 1, skipped: 0 }),
        now: Date.now,
      },
      { windowMs: 1_000_000, maxBatches: 1, signal: job.signal },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ stopped: 'aborted', remaining: 9, batches: 1, extracted: 1 });
    expect((countSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(await engine.executeRaw(`SELECT id FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle:drain-bound'`)).toEqual([]);
  });
});

describe('lease loss through the real lock helper', () => {
  it('a lease taken over mid-batch returns lock_lost with the partial counters instead of throwing', async () => {
    const lockId = 'gbrain-cycle:drain-lease';
    let batchSignalReason: unknown = null;
    const deps: ExtractAtomsDrainDeps = {
      withLock: (work) => withRefreshingLock(engine, lockId, (signal) => work(signal), { ttlMinutes: 0.01, refreshIntervalMs: 50 }),
      countRemaining: async () => 6,
      runBatch: async ({ signal }) => {
        await engine.executeRaw(`UPDATE gbrain_cycle_locks SET acquisition_token = gen_random_uuid() WHERE id = $1`, [lockId]);
        await untilAborted(signal);
        batchSignalReason = signal.reason;
        return { extracted: 2, skipped: 0 };
      },
      now: Date.now,
    };
    const result = await runExtractAtomsDrain(deps, { windowMs: 1_000_000 });
    expect(result).toMatchObject({ stopped: 'lock_lost', batches: 1, extracted: 2, remaining: 6, status: 'ok' });
    expect((batchSignalReason as Error).name).toBe('LockStolenError');
  });
});

describe('the drain window on the real phase', () => {
  it('a 1 s window stops within one page: the straddling page finishes and counts, the next never starts', async () => {
    for (const slug of ['notes/window-a', 'notes/window-b']) {
      await engine.putPage(slug, {
        type: 'note', title: slug, compiled_truth: 'A durable decision recorded in prose. '.repeat(20),
      } as never, { sourceId: 'default' });
    }
    const calls: Array<{ abortedAtEnd: boolean | undefined }> = [];
    __setChatTransportForTests(async (o) => {
      await new Promise((r) => setTimeout(r, 1_300));
      calls.push({ abortedAtEnd: o.abortSignal?.aborted });
      const text = JSON.stringify([{ title: 'A durable decision', atom_type: 'insight', body: 'The decision body prose.' }]);
      return {
        text, blocks: [{ type: 'text', text }], stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      } as ChatResult;
    });
    let result;
    try {
      result = await runExtractAtomsDrainForSource(engine, { sourceId: 'default', windowSeconds: 1 });
    } finally {
      __setChatTransportForTests(null);
    }
    expect(calls).toEqual([{ abortedAtEnd: false }]);
    expect(result).toMatchObject({ stopped: 'window', batches: 1, extracted: 1, remaining: 1 });
    expect(await engine.executeRaw(`SELECT id FROM gbrain_cycle_locks`)).toEqual([]);
  }, 30_000);
});
