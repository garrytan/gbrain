import { describe, expect, it } from 'bun:test';
import { runExtractAtomsDrain } from '../src/core/cycle/extract-atoms-drain.ts';
import { drainOutcome } from '../src/core/cycle/extract-atoms-drain-outcome.ts';

describe('atom drain window expiry during batch startup', () => {
  it('keeps a soft window stop retryable when the batch returns no work', async () => {
    let counts = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: (work) => work(new AbortController().signal),
        countRemaining: async () => { counts++; return 5; },
        runBatch: async ({ stopSignal }) => {
          if (!stopSignal.aborted) await new Promise<void>((resolve) => {
            stopSignal.addEventListener('abort', () => resolve(), { once: true });
          });
          expect(stopSignal.aborted).toBe(true);
          return { extracted: 0, skipped: 0 };
        },
        now: () => 0,
      },
      { windowMs: 10 },
    );

    expect(result.stopped).toBe('window');
    expect(counts).toBe(2); // initial count and final count, without a no-progress recount
    expect(drainOutcome(result)).toMatchObject({ status: 'incomplete', exit: 11, retryable: true });
  });
});
