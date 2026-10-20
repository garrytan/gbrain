/**
 * #6817: every DrainStop against its exit code, JSON status and retryability,
 * plus the provider-failure classification the drain carries to that mapping.
 */
import { describe, expect, test } from 'bun:test';
import { drainOutcome, type DrainOutcome } from '../src/core/cycle/extract-atoms-drain-outcome.ts';
import {
  batchProviderFailureClass,
  runExtractAtomsDrain,
  type DrainStop,
  type ExtractAtomsDrainDeps,
} from '../src/core/cycle/extract-atoms-drain.ts';

describe('drainOutcome: one row per stop (#6817)', () => {
  const rows: Array<[DrainStop, number | null, number, boolean, DrainOutcome['status'], DrainOutcome['code']]> = [
    ['drained', 0, 0, false, 'ok', undefined],
    ['drained', null, 11, true, 'incomplete', 'atom_drain_incomplete'],
    ['window', 4, 11, true, 'incomplete', 'atom_drain_incomplete'],
    ['deadline', 4, 11, true, 'incomplete', 'atom_drain_incomplete'],
    ['lock_lost', 4, 11, true, 'incomplete', 'atom_drain_incomplete'],
    ['aborted', 4, 11, true, 'incomplete', 'atom_drain_incomplete'],
    ['max_batches', 4, 11, true, 'incomplete', 'atom_drain_incomplete'],
    ['budget', 4, 11, true, 'incomplete', 'atom_drain_incomplete'],
    ['no_progress', 4, 1, false, 'incomplete', 'atom_drain_no_progress'],
    ['no_progress', null, 11, true, 'incomplete', 'atom_drain_incomplete'],
  ];
  test.each(rows)('%s with remaining %p exits %d (retryable %p)', (stopped, remaining, exit, retryable, status, code) => {
    const outcome = drainOutcome({ status: 'ok', stopped, remaining });
    expect({ exit: outcome.exit, retryable: outcome.retryable, status: outcome.status, code: outcome.code }).toEqual({ exit, retryable, status, code });
  });

  test.each([
    ['auth', 1, false], ['billing', 1, false], ['model_not_found', 1, false], ['content_block', 1, false],
    ['rate_limit', 11, true], ['transient', 11, true], [undefined, 11, true],
  ] as const)('provider_failure class %p exits %d', (cls, exit, retryable) => {
    for (const remaining of [5, 0, null]) {
      expect(drainOutcome({ status: 'provider_failure', stopped: 'provider_failure', remaining, provider_failure_class: cls }))
        .toEqual({ status: 'provider_failure', exit, retryable, code: 'atom_drain_provider_failure', reason: cls ?? 'transient' });
    }
  });
});

describe('provider failure classification (#6817)', () => {
  test('the phase halt class wins; an all-content-block batch is content_block; anything else is transient', () => {
    for (const halted of ['auth', 'billing', 'model_not_found', 'rate_limit'] as const) expect(batchProviderFailureClass(halted, [])).toBe(halted);
    expect(batchProviderFailureClass(undefined, [{ reason: 'provider blocked content: safety' }])).toBe('content_block');
    expect(batchProviderFailureClass(undefined, [{ reason: 'provider blocked content: safety' }, { reason: '503 overloaded' }])).toBe('transient');
    expect(batchProviderFailureClass(undefined, [])).toBe('transient');
    expect(batchProviderFailureClass('something_else', [{ reason: 'boom' }])).toBe('transient');
  });

  test('the drain result carries the failing batch class, and only on provider_failure', async () => {
    const lock: ExtractAtomsDrainDeps['withLock'] = (work) => work(new AbortController().signal);
    const run = (batch: Awaited<ReturnType<ExtractAtomsDrainDeps['runBatch']>>) => runExtractAtomsDrain(
      { withLock: lock, countRemaining: async () => 3, runBatch: async () => batch, now: () => 0 }, { windowMs: 1_000_000, maxBatches: 1 });
    expect((await run({ extracted: 0, skipped: 0, providerFailure: true, providerFailureClass: 'auth' })).provider_failure_class).toBe('auth');
    expect((await run({ extracted: 0, skipped: 0, providerFailure: true })).provider_failure_class).toBe('transient');
    expect((await run({ extracted: 1, skipped: 0 })).provider_failure_class).toBeUndefined();
  });
});
