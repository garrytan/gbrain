/**
 * #4539 — the drain surfaces WHY it failed.
 *
 * Pre-fix: runPhaseExtractAtoms returned failures[] in its phase details, but
 * the drain adapter (runExtractAtomsDrainForSource) collapsed them to bare
 * counts, ExtractAtomsDrainResult had no error field, and dream.ts printed
 * only `stopped: no_progress` — a run that failed on every item looked
 * identical to "nothing eligible".
 *
 * Post-fix: runBatch carries failureCount plus content-free typed failures;
 * the pure loop accumulates them into result.failure_count / result.last_error.
 */

import { describe, it, expect } from 'bun:test';
import {
  runExtractAtomsDrain,
  type ExtractAtomsDrainDeps,
} from '../src/core/cycle/extract-atoms-drain.ts';

const passThroughLock: ExtractAtomsDrainDeps['withLock'] = (work) => work();

describe('extract_atoms drain error surfacing (#4539)', () => {
  it('accumulates failure_count and keeps the most recent firstError', async () => {
    let batch = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5,
        runBatch: async () => {
          batch++;
          return batch === 1
            ? {
              extracted: 1,
              skipped: 0,
              failureCount: 2,
              failures: [{ source: 'pages/a', reason: 'malformed_model_output:no_json_array' }],
            }
            : {
              extracted: 0,
              skipped: 0,
              providerFailure: true,
              failureCount: 3,
              failures: [{ source: 'pages/b', reason: 'global_llm_rate_limit' }],
            };
        },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.failure_count).toBe(5);
    expect(result.last_error).toBe('pages/b: global_llm_rate_limit');
    expect(result.status).toBe('provider_failure');
  });

  it('clean run reports failure_count 0 and last_error null', async () => {
    const counts = [2, 1, 0];
    let i = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => counts[Math.min(i++, counts.length - 1)],
        runBatch: async () => ({ extracted: 1, skipped: 0 }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('drained');
    expect(result.failure_count).toBe(0);
    expect(result.last_error).toBeNull();
  });

  it('a failing no-progress run carries the error that explains it', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5,
        // Partial-failure shape: some items skipped-as-failures, no atoms —
        // the loop stops no_progress, and pre-fix the reason was invisible.
        runBatch: async () => ({
          extracted: 0,
          skipped: 0,
          failureCount: 5,
          failures: [{ source: 'pages/x', reason: 'item_error' }],
        }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('no_progress');
    expect(result.failure_count).toBe(5);
    expect(result.last_error).toBe('pages/x: item_error');
  });
});
