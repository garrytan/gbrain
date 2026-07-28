/**
 * issue #1678 — bounded single-hold extract_atoms drain loop.
 *
 * Pure-over-injected-deps, so no DB / LLM / lock primitive. Pins:
 *  - drains to empty (rediscovers each batch via countRemaining), stops 'drained'
 *  - the wallclock window bounds the loop, stops 'window' with remaining > 0
 *  - a zero-progress batch stops the loop (no hot loop burning budget)
 *  - a busy lock (withLock throws) propagates so the caller reports skipped
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  runExtractAtomsDrain,
  type ExtractAtomsDrainDeps,
} from '../src/core/cycle/extract-atoms-drain.ts';
import { isProtectedJobName, PROTECTED_JOB_NAMES } from '../src/core/minions/protected-names.ts';

function seq(values: Array<number | null>): () => Promise<number | null> {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

const passThroughLock: ExtractAtomsDrainDeps['withLock'] = (work) => work();

describe('runExtractAtomsDrain (issue #1678)', () => {
  it('drains to empty and reports stopped=drained', async () => {
    let batches = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: seq([3, 2, 1, 0, 0]),
        runBatch: async () => { batches++; return { extracted: 1, skipped: 0 }; },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('drained');
    expect(result.remaining).toBe(0);
    expect(result.batches).toBe(3);
    expect(result.extracted).toBe(3);
    expect(batches).toBe(3);
  });

  it('stops at the wallclock window with remaining > 0', async () => {
    // SYNC stepping clock: now() #1 sets deadline (0+100=100); the while-check
    // then sees 50, 50 (two batches), then 999999 → past deadline → stop.
    const times = [0, 50, 50, 999_999];
    let ti = 0;
    const now = () => times[Math.min(ti++, times.length - 1)];
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5, // never drains
        runBatch: async () => ({ extracted: 1, skipped: 0 }),
        now,
      },
      { windowMs: 100 },
    );
    expect(result.stopped).toBe('window');
    expect(result.remaining).toBe(5);
    expect(result.batches).toBe(2);
  });

  it('stops on a zero-progress batch (no hot loop)', async () => {
    let batches = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5,
        runBatch: async () => { batches++; return { extracted: 0, skipped: 0 }; },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('no_progress');
    expect(batches).toBe(1);
    expect(result.remaining).toBe(5);
    expect(result.status).toBe('ok');
  });

  // issue #3218 — a batch where every attempted item errored (providerFailure)
  // must surface distinctly from an ordinary no_progress/drained/window stop,
  // so the Minion handler can retry instead of completing the durable job.
  it('stops with status=provider_failure when a batch reports providerFailure', async () => {
    let batches = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5,
        runBatch: async () => {
          batches++;
          return { extracted: 0, skipped: 0, providerFailure: true };
        },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.status).toBe('provider_failure');
    expect(result.stopped).toBe('provider_failure');
    expect(batches).toBe(1);
    expect(result.remaining).toBe(5);
  });

  // issue #3218 (codex P2) — a final recount of 0 must NOT overwrite
  // stopped='provider_failure' back to 'drained'. Otherwise the caller sees
  // the contradictory {status: 'provider_failure', stopped: 'drained'}.
  it('preserves stopped=provider_failure even when the final recount is 0', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: seq([3, 0]), // before-check: 3; final post-loop recount: 0
        runBatch: async () => ({ extracted: 0, skipped: 0, providerFailure: true }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.status).toBe('provider_failure');
    expect(result.stopped).toBe('provider_failure');
    expect(result.remaining).toBe(0);
  });

  it('does not flag provider_failure for an ordinary partial-success batch', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: seq([3, 0, 0]),
        runBatch: async () => ({ extracted: 1, skipped: 0, providerFailure: false }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.status).toBe('ok');
    expect(result.stopped).toBe('drained');
  });

  it('propagates a busy-lock error (caller reports cycle_already_running)', async () => {
    class FakeBusy extends Error {}
    await expect(
      runExtractAtomsDrain(
        {
          withLock: () => { throw new FakeBusy('held'); },
          countRemaining: async () => 5,
          runBatch: async () => ({ extracted: 1, skipped: 0 }),
          now: () => 0,
        },
        { windowMs: 1000 },
      ),
    ).rejects.toThrow('held');
  });

  it('respects maxBatches as a belt-and-suspenders cap', async () => {
    let batches = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 999, // never drains
        runBatch: async () => { batches++; return { extracted: 1, skipped: 0 }; },
        now: () => 0, // window never elapses
      },
      { windowMs: 1_000_000, maxBatches: 4 },
    );
    expect(result.stopped).toBe('max_batches');
    expect(batches).toBe(4);
  });
});

// #1685 GAP D (CODEX #1) — the auto-drain Minion job burns Haiku, so it must be
// PROTECTED: no MCP/OAuth-scoped caller can submit it; only trusted local
// callers (autopilot, explicit CLI with --allow-protected) can.
describe('extract-atoms-drain protected-name membership', () => {
  it('extract-atoms-drain is PROTECTED', () => {
    expect(isProtectedJobName('extract-atoms-drain')).toBe(true);
    expect(PROTECTED_JOB_NAMES.has('extract-atoms-drain')).toBe(true);
  });
});

// #1685 GAP D / 5A — the shared wiring helper is the single drain path. The
// "drain holds the same cycle lock id as the routine cycle" contract (moved out
// of dream.ts in the 5A refactor) lives here now.
describe('shared wiring helper holds the cycle lock (5A)', () => {
  const src = readFileSync(
    join(import.meta.dir, '../src/core/cycle/extract-atoms-drain.ts'),
    'utf8',
  );
  it('runExtractAtomsDrainForSource uses cycleLockIdFor(opts.sourceId) + withRefreshingLock', () => {
    expect(src).toContain('runExtractAtomsDrainForSource');
    expect(src).toContain('cycleLockIdFor(opts.sourceId)');
    expect(src).toContain('withRefreshingLock(engine, lockId');
  });

  // issue #3218 — the wiring's `runBatch` must derive `providerFailure` from
  // the SAME per-item counts pinned by
  // `extract-atoms-synthesize-concepts.test.ts`'s "all items fail" case
  // (failures.length > 0 && transcripts_processed + pages_processed === 0),
  // not from `r.status` (which collapses partial and total failure into the
  // same 'warn' value — the exact discard the issue reports).
  it('runBatch derives providerFailure from failures.length + zero processed items, not r.status', () => {
    const runBatchBlock = src.slice(src.indexOf('runBatch: async () => {'));
    expect(runBatchBlock).toContain('d.failures');
    expect(runBatchBlock).toContain('transcripts_processed');
    expect(runBatchBlock).toContain('pages_processed');
    expect(runBatchBlock).toContain('providerFailure: failures.length > 0 && itemsSucceeded === 0');
  });
});

// issue #3218 — the Minion handler must throw (not complete) when the drain
// reports status='provider_failure', so the worker's ordinary failJob path
// (attempt+backoff / dead-letter) retries the durable job instead of the
// backlog silently completing untouched.
describe('extract-atoms-drain Minion handler retries on provider_failure (issue #3218)', () => {
  const jobsSrc = readFileSync(join(import.meta.dir, '../src/commands/jobs.ts'), 'utf8');
  const handlerBlock = jobsSrc.slice(
    jobsSrc.indexOf("registerBuiltinJob(worker, engine, 'extract-atoms-drain'"),
    jobsSrc.indexOf("registerBuiltinJob(worker, engine, 'extract-atoms-drain'") + 2200,
  );

  it("throws when result.status === 'provider_failure' instead of returning it", () => {
    expect(handlerBlock).toMatch(/result\.status === 'provider_failure'/);
    expect(handlerBlock).toMatch(/if \(result\.status === 'provider_failure'\) \{\s*throw new Error/);
  });

  it('still returns the deferred/skipped shape on LockUnavailableError (unchanged)', () => {
    expect(handlerBlock).toContain('e instanceof LockUnavailableError');
    expect(handlerBlock).toContain(
      "{ phase: 'extract_atoms', status: 'skipped', deferred: true, reason: 'cycle_already_running' }",
    );
  });
});

describe('#2144: zero-yield tombstone progress semantics', () => {
  it('continues when a zero-atom batch still shrinks the backlog (tombstoned pages)', async () => {
    let batches = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        // consumed: before#1=4, after#1=2 (<4 → progress), before#2=2,
        // after#2=0 (<2 → progress), before#3=0 → drained; final repeats 0.
        countRemaining: seq([4, 2, 2, 0, 0]),
        runBatch: async () => { batches++; return { extracted: 0, skipped: 0 }; },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('drained');
    expect(result.batches).toBe(2);
    expect(result.extracted).toBe(0);
    expect(result.remaining).toBe(0);
    expect(batches).toBe(2);
  });

  it('stops no_progress when a zero-atom batch leaves the backlog flat', async () => {
    let batches = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: seq([5, 5]),
        runBatch: async () => { batches++; return { extracted: 0, skipped: 0 }; },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('no_progress');
    expect(result.batches).toBe(1);
    expect(result.remaining).toBe(5);
    expect(batches).toBe(1);
  });
});
