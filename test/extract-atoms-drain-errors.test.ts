/**
 * #4539 — the drain surfaces WHY it failed.
 *
 * Pre-fix: runPhaseExtractAtoms returned failures[] in its phase details, but
 * the drain adapter (runExtractAtomsDrainForSource) collapsed them to bare
 * counts, ExtractAtomsDrainResult had no error field, and dream.ts printed
 * only `stopped: no_progress` — a run that failed on every item looked
 * identical to "nothing eligible".
 *
 * Post-fix: runBatch carries failureCount + firstError, the pure loop
 * accumulates them into result.failure_count / result.last_error, and both
 * ride the --json payload verbatim.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  runExtractAtomsDrain,
  MAX_DRAIN_FAILURE_RECORDS,
  MAX_DRAIN_FAILURE_REASON_CHARS,
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
            ? { extracted: 1, skipped: 0, failureCount: 2, firstError: 'pages/a: malformed model output' }
            : { extracted: 0, skipped: 0, providerFailure: true, failureCount: 3, firstError: 'pages/b: 429 rate limit' };
        },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.failure_count).toBe(5);
    expect(result.last_error).toBe('pages/b: 429 rate limit');
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
        runBatch: async () => ({ extracted: 0, skipped: 0, failureCount: 5, firstError: 'pages/x: provider 400' }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('no_progress');
    expect(result.failure_count).toBe(5);
    expect(result.last_error).toBe('pages/x: provider 400');
  });
});

// #4730 — the drain preserves EVERY per-item failure (bounded, typed,
// sanitized) instead of collapsing a mixed-failure run to count + one
// representative error. failure_count === failures.length +
// omitted_failure_count always holds, so the record cap is visible.
describe('extract_atoms drain typed per-item failures (#4730)', () => {
  it('mixed per-item reasons in ONE batch are all preserved, in order', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 3,
        runBatch: async () => ({
          extracted: 1,
          skipped: 0,
          failureCount: 3,
          failures: [
            { source: 'pages/a', reason: 'malformed model output: no JSON array in response' },
            { source: 'pages/b', reason: 'provider 400 bad request' },
            { source: 'pages/c', reason: 'atom identity conflict for atoms/x' },
          ],
        }),
        now: () => 0,
      },
      { windowMs: 1_000_000, maxBatches: 1 },
    );
    expect(result.failure_count).toBe(3);
    expect(result.omitted_failure_count).toBe(0);
    expect(result.failures).toEqual([
      { batch: 1, source: 'pages/a', reason: 'malformed model output: no JSON array in response' },
      { batch: 1, source: 'pages/b', reason: 'provider 400 bad request' },
      { batch: 1, source: 'pages/c', reason: 'atom identity conflict for atoms/x' },
    ]);
    // Pre-#4730 only this one survived; now it is derived, not the whole story.
    expect(result.last_error).toBe('pages/a: malformed model output: no JSON array in response');
  });

  it('failures ACROSS batches carry their batch number', async () => {
    let batch = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5,
        runBatch: async () => {
          batch++;
          return batch === 1
            ? { extracted: 1, skipped: 0, failureCount: 1, failures: [{ source: 'pages/a', reason: 'parse failure' }] }
            : { extracted: 1, skipped: 0, failureCount: 1, failures: [{ source: 'pages/b', reason: 'timeout' }] };
        },
        now: () => 0,
      },
      { windowMs: 1_000_000, maxBatches: 2 },
    );
    expect(result.failure_count).toBe(2);
    expect(result.failures).toEqual([
      { batch: 1, source: 'pages/a', reason: 'parse failure' },
      { batch: 2, source: 'pages/b', reason: 'timeout' },
    ]);
    expect(result.last_error).toBe('pages/b: timeout');
  });

  it('clean run reports failures: [] and omitted_failure_count: 0', async () => {
    const counts = [1, 0];
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
    expect(result.failures).toEqual([]);
    expect(result.omitted_failure_count).toBe(0);
  });

  it('caps records at MAX_DRAIN_FAILURE_RECORDS and reports the omission — never silent', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      source: `pages/p${i}`,
      reason: `failure ${i}`,
    }));
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 40,
        runBatch: async () => ({ extracted: 1, skipped: 0, failureCount: many.length, failures: many }),
        now: () => 0,
      },
      { windowMs: 1_000_000, maxBatches: 1 },
    );
    expect(result.failures).toHaveLength(MAX_DRAIN_FAILURE_RECORDS);
    expect(result.failure_count).toBe(40);
    expect(result.omitted_failure_count).toBe(40 - MAX_DRAIN_FAILURE_RECORDS);
    // Reconcilability invariant from the issue's acceptance criteria.
    expect(result.failure_count).toBe(result.failures.length + result.omitted_failure_count);
    // Batch order preserved: the FIRST records survive the cap.
    expect(result.failures[0]).toEqual({ batch: 1, source: 'pages/p0', reason: 'failure 0' });
  });

  it('a count-only adapter (#4539 shape) reconciles via omitted_failure_count', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5,
        runBatch: async () => ({ extracted: 1, skipped: 0, failureCount: 4, firstError: 'pages/x: err' }),
        now: () => 0,
      },
      { windowMs: 1_000_000, maxBatches: 1 },
    );
    expect(result.failure_count).toBe(4);
    expect(result.failures).toEqual([]);
    expect(result.omitted_failure_count).toBe(4);
    expect(result.last_error).toBe('pages/x: err');
  });

  it('sanitizes records: connection info redacted, whitespace collapsed, length bounded', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 1,
        runBatch: async () => ({
          extracted: 1,
          skipped: 0,
          failureCount: 2,
          failures: [
            { source: '  pages/with\n\nnewlines  ', reason: 'FATAL: password=hunter2 refused' },
            { source: 'pages/long', reason: 'x'.repeat(2000) },
          ],
        }),
        now: () => 0,
      },
      { windowMs: 1_000_000, maxBatches: 1 },
    );
    expect(result.failures[0]!.source).toBe('pages/with newlines');
    expect(result.failures[0]!.reason).toContain('<REDACTED:password>');
    expect(result.failures[0]!.reason).not.toContain('hunter2');
    expect(result.failures[1]!.reason.length).toBeLessThanOrEqual(MAX_DRAIN_FAILURE_REASON_CHARS);
  });

  it('malformed injected records are dropped from details but still counted', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 2,
        runBatch: async () => ({
          extracted: 1,
          skipped: 0,
          failureCount: 2,
          failures: [
            { source: 'pages/ok', reason: 'real failure' },
            { source: 42, reason: null } as unknown as { source: string; reason: string },
          ],
        }),
        now: () => 0,
      },
      { windowMs: 1_000_000, maxBatches: 1 },
    );
    expect(result.failures).toEqual([{ batch: 1, source: 'pages/ok', reason: 'real failure' }]);
    expect(result.failure_count).toBe(2);
    expect(result.omitted_failure_count).toBe(1);
  });
});

// #4730 — the production wiring forwards the phase's {source, error} records
// as typed {source, reason} pairs (source-text pin, same style as the #3218
// providerFailure pin in extract-atoms-drain.test.ts).
describe('runExtractAtomsDrainForSource forwards typed per-item failures (#4730)', () => {
  const src = readFileSync(
    join(import.meta.dir, '../src/core/cycle/extract-atoms-drain.ts'),
    'utf8',
  );
  it('maps d.failures {source, error} → {source, reason} and returns them on the batch', () => {
    const runBatchBlock = src.slice(src.indexOf('runBatch: async () => {'));
    expect(runBatchBlock).toContain(".map(({ source, error }) => ({ source, reason: error }))");
    expect(runBatchBlock).toContain('failures: typedFailures');
  });
});
