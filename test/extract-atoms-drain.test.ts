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
  extractAtomsDrainBatchFromPhaseDetails,
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
    expect(result.failures).toEqual([]);
    expect(result.failure_count).toBe(0);
    expect(result.omitted_failure_count).toBe(0);
    expect(result.last_error).toBeNull();
  });

  it('preserves mixed per-item failures from the same batch with their source locators', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: seq([3, 0, 0]),
        runBatch: async () => ({
          extracted: 1,
          skipped: 0,
          failureCount: 2,
          firstError: 'pages/alpha: request timed out',
          failures: [
            { source: 'pages/alpha', reason: 'transient_provider_error' },
            {
              source: 'pages/beta',
              reason: 'malformed_model_output:json_array_exceeds_3_atoms',
            },
          ],
        }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );

    expect(result.failures).toEqual([
      { batch: 1, source: 'pages/alpha', reason: 'transient_provider_error' },
      {
        batch: 1,
        source: 'pages/beta',
        reason: 'malformed_model_output:json_array_exceeds_3_atoms',
      },
    ]);
    expect(result.failure_count).toBe(2);
    expect(result.omitted_failure_count).toBe(0);
    expect(result.last_error).toBe('pages/alpha: transient_provider_error');
  });

  it('preserves failures across batches with one-based batch context', async () => {
    let batch = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: seq([2, 1, 0, 0]),
        runBatch: async () => {
          batch++;
          return {
            extracted: 1,
            skipped: 0,
            failureCount: 1,
            firstError: `pages/${batch}: failure ${batch}`,
            failures: [{ source: `pages/${batch}`, reason: `failure_${batch}` }],
          };
        },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );

    expect(result.failures).toEqual([
      { batch: 1, source: 'pages/1', reason: 'failure_1' },
      { batch: 2, source: 'pages/2', reason: 'failure_2' },
    ]);
    expect(result.failure_count).toBe(2);
    expect(result.omitted_failure_count).toBe(0);
    expect(result.last_error).toBe('pages/2: failure_2');
  });

  it('caps failure records and excludes arbitrary payloads from bounded output', async () => {
    const privatePayload = 'MODEL RESPONSE: confidential source page sentence';
    const secretLocator = 'pages/postgresql://admin:secret@private.example/brain';
    const failures = Array.from({ length: 30 }, (_, i) => ({
      source: i === 0 ? `${secretLocator}/${'x'.repeat(5000)}` : `pages/${i}`,
      reason: i === 0 ? privatePayload : `failure_${i}`,
      error: privatePayload,
    }));
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: seq([30, 0, 0]),
        runBatch: async () => ({
          extracted: 1,
          skipped: 0,
          failureCount: failures.length,
          firstError: `${failures[0].source}: ${failures[0].error}`,
          failures,
        }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );

    expect(result.failures).toHaveLength(25);
    expect(result.failure_count).toBe(30);
    expect(result.omitted_failure_count).toBe(5);
    expect(result.failure_count).toBe(result.failures.length + result.omitted_failure_count);
    expect(result.failures[0].source.length).toBeLessThanOrEqual(256);
    expect(result.failures[0].source).not.toContain('postgresql://');
    expect(result.failures[0].source).not.toContain('secret');
    expect(result.failures[0].reason).toBe('unknown_failure');
    expect(JSON.stringify(result)).not.toContain(privatePayload);
    expect(result.last_error).not.toContain(privatePayload);
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
          return {
            extracted: 0,
            skipped: 0,
            providerFailure: true,
            failureCount: 1,
            firstError: 'pages/rejected: untrusted atom output rejected by source guard',
            failures: [{
              source: 'pages/rejected',
              reason: 'source_guard:ambiguous_source_quote',
            }],
          };
        },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.status).toBe('provider_failure');
    expect(result.stopped).toBe('provider_failure');
    expect(batches).toBe(1);
    expect(result.remaining).toBe(5);
    expect(result.failures).toEqual([{
      batch: 1,
      source: 'pages/rejected',
      reason: 'source_guard:ambiguous_source_quote',
    }]);
    expect(result.failure_count).toBe(1);
    expect(result.omitted_failure_count).toBe(0);
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

  // issue #3218/#4730 — behaviorally pin the production adapter rather than
  // matching its source text. Raw `error` payloads must not cross the seam.
  it('adapts typed phase failures and derives providerFailure from zero processed items', () => {
    const batch = extractAtomsDrainBatchFromPhaseDetails({
      atoms_extracted: 0,
      duplicates_skipped: 2,
      transcripts_processed: 0,
      pages_processed: 0,
      failures: [
        { source: 'pages/a', reason: 'source_guard:missing_source_quote', error: 'private payload' },
        { source: 'pages/b', reason: 'transient_provider_error', error: 'provider response' },
      ],
    });
    expect(batch).toEqual({
      extracted: 0,
      skipped: 2,
      providerFailure: true,
      failureCount: 2,
      failures: [
        { source: 'pages/a', reason: 'source_guard:missing_source_quote' },
        { source: 'pages/b', reason: 'transient_provider_error' },
      ],
      firstError: 'pages/a: source_guard:missing_source_quote',
    });
    expect(JSON.stringify(batch)).not.toContain('private payload');
    expect(JSON.stringify(batch)).not.toContain('provider response');
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
