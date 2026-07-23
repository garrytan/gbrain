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

  it('stops at the wallclock window; remaining is unknown (no post-window count)', async () => {
    // Each batch consumes 60ms of the 100ms window: two batches fit, the
    // third boundary check sees 120 ≥ 100 and stops. #2750: after the window
    // elapses the final countRemaining is SKIPPED (it would overrun the
    // window), so remaining reports null.
    let now = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5, // never drains
        runBatch: async () => {
          now += 60;
          return { extracted: 1, skipped: 0 };
        },
        now: () => now,
      },
      { windowMs: 100 },
    );
    expect(result.stopped).toBe('window');
    expect(result.remaining).toBeNull();
    expect(result.batches).toBe(2);
  });

  it('passes one drain-level deadline signal into count and batch', async () => {
    const seen: AbortSignal[] = [];
    const controller = new AbortController();
    let now = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async (signal) => {
          seen.push(signal);
          return 5;
        },
        runBatch: async (signal) => {
          seen.push(signal);
          now = 100;
          return { extracted: 1, skipped: 0 };
        },
        now: () => now,
      },
      { windowMs: 100, abortSignal: controller.signal },
    );
    expect(result.stopped).toBe('window');
    expect(result.batches).toBe(1);
    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(seen[1]);
    // Combined (timeout + external) signal, not the raw external one.
    expect(seen[0]).not.toBe(controller.signal);
  });

  it('aborts a hung backlog count at the window deadline and releases the lock', async () => {
    let released = false;
    const result = await runExtractAtomsDrain(
      {
        withLock: async (work) => {
          try { return await work(); }
          finally { released = true; }
        },
        // Hangs until the drain's real-time deadline signal fires (10ms).
        countRemaining: (signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
        runBatch: async () => ({ extracted: 0, skipped: 0 }),
        now: () => 0, // injected clock never advances — the SIGNAL must save us
      },
      { windowMs: 10 },
    );
    expect(result.stopped).toBe('window');
    expect(result.remaining).toBeNull();
    expect(released).toBe(true);
  });

  it('rethrows external cancellation after releasing the lock', async () => {
    const controller = new AbortController();
    let released = false;
    const pending = runExtractAtomsDrain(
      {
        withLock: async (work) => {
          try { return await work(); }
          finally { released = true; }
        },
        countRemaining: (signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
        runBatch: async () => ({ extracted: 0, skipped: 0 }),
        now: () => 0,
      },
      { windowMs: 1_000_000, abortSignal: controller.signal },
    );
    controller.abort(new DOMException('worker timeout', 'AbortError'));
    await expect(pending).rejects.toThrow('worker timeout');
    expect(released).toBe(true);
  });

  it('classifies a deadline-exhausted zero-progress batch as window, not no_progress', async () => {
    let now = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5,
        runBatch: async () => {
          now = 100; // batch consumed the whole window and returned nothing
          return { extracted: 0, skipped: 0 };
        },
        now: () => now,
      },
      { windowMs: 100 },
    );
    expect(result.stopped).toBe('window');
    expect(result.batches).toBe(1);
  });

  it('bounds a hung lock acquisition with the drain deadline signal', async () => {
    const started = Date.now();
    await expect(runExtractAtomsDrain(
      {
        withLock: (_work, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
        countRemaining: async () => 1,
        runBatch: async () => ({ extracted: 0, skipped: 0 }),
        now: Date.now,
      },
      { windowMs: 10 },
    )).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
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

  // #2750: the deadline signal must reach the phase, the backlog count, AND
  // the lock wrapper — and the transcript path (brainDir) must stay wired
  // exactly as the routine callers expect (PR #2752 takeover reverted its
  // unsanctioned transcript-suppression scope change).
  it('threads the drain deadline signal through phase, count, and lock', () => {
    const jobsSrc = readFileSync(join(import.meta.dir, '../src/commands/jobs.ts'), 'utf8');
    expect(src).toContain('abortSignal: signal');
    expect(src).toContain('countExtractAtomsBacklog(engine, extractionSourceId, signal)');
    expect(src).toContain('brainDir: opts.brainDir');
    expect(src).not.toContain('_transcripts');
    expect(jobsSrc).toContain('abortSignal: job.signal');
  });
});
