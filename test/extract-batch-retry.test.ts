// v0.41.2.1 — withRetry + logBatchRetry + snapshot-before-clear contract.
//
// Pinned contracts:
//   - withRetry is a pure primitive (no UI), exports cleanly so tests
//     import it without going through the 6 private flush() closures.
//   - Classification uses isRetryableConnError from src/core/retry-matcher.ts
//     (single source of truth; no inline pattern duplication).
//   - Retry-matcher extension recognizes gbrain's GBrainError shape
//     ({problem: 'No database connection'}) AND the literal message
//     pattern. PR #1416's reported batch-loss incident is closed.
//   - logBatchRetry writes stderr only when jsonMode is false.
//   - Snapshot contract: batch.slice() BEFORE batch.length=0 so producer
//     mutation during the 500ms retry delay can't lose items on retry.
//
// Hermetic: no engine, no PGLite, no env mutation, no DATABASE_URL.

import { describe, expect, test, beforeEach } from 'bun:test';
import { withRetry, logBatchRetry } from '../src/commands/extract.ts';
import { isRetryableConnError } from '../src/core/retry-matcher.ts';

// Minimal GBrainError shape — mirror the typed problem/detail fields used
// by db.ts:getConnection so the retry-matcher extension recognizes it.
class FakeGBrainError extends Error {
  problem: string;
  detail: string;
  constructor(problem: string, detail: string) {
    super(`${problem}: ${detail}`);
    this.problem = problem;
    this.detail = detail;
  }
}

describe('isRetryableConnError extension (v0.41.2.1)', () => {
  test('GBrainError with problem="No database connection" is retryable', () => {
    const err = new FakeGBrainError('No database connection', 'connect() has not been called');
    expect(isRetryableConnError(err)).toBe(true);
  });

  test('GBrainError with other problem is NOT retryable', () => {
    const err = new FakeGBrainError('Schema mismatch', 'expected vector(1536), got vector(1024)');
    expect(isRetryableConnError(err)).toBe(false);
  });

  test('plain Error with "No database connection" message is retryable (literal match)', () => {
    expect(isRetryableConnError(new Error('No database connection: connect() has not been called.'))).toBe(true);
  });

  test('constraint violation 23505 is NOT retryable', () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    expect(isRetryableConnError(err)).toBe(false);
  });
});

describe('withRetry primitive (v0.41.2.1)', () => {
  test('first-call success: returns value, no onRetry invocation', async () => {
    let calls = 0;
    let retried = false;
    const result = await withRetry(
      async () => { calls++; return 42; },
      { onRetry: () => { retried = true; }, delayMs: 0 },
    );
    expect(result).toBe(42);
    expect(calls).toBe(1);
    expect(retried).toBe(false);
  });

  test('retries on Connection terminated; second attempt succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('Connection terminated unexpectedly');
        return 'recovered';
      },
      { delayMs: 0 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  test('retries on GBrainError "No database connection"; second succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new FakeGBrainError('No database connection', 'connect() has not been called');
        return 'ok';
      },
      { delayMs: 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test('non-retryable error propagates immediately, no retry', async () => {
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        const err = Object.assign(new Error('duplicate key'), { code: '23505' });
        throw err;
      },
      { delayMs: 0 },
    );
    await expect(promise).rejects.toThrow('duplicate key');
    expect(calls).toBe(1); // no retry on 23505
  });

  test('second failure propagates (single retry, not infinite)', async () => {
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        throw new Error('ECONNRESET');
      },
      { delayMs: 0 },
    );
    await expect(promise).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(2); // attempt 1 + retry, then propagate
  });

  test('onRetry callback receives (attempt=1, err)', async () => {
    let received: { attempt: number; err: unknown } | null = null;
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('Connection terminated unexpectedly');
        return null;
      },
      {
        onRetry: (attempt, err) => { received = { attempt, err }; },
        delayMs: 0,
      },
    );
    expect(received).not.toBeNull();
    expect(received!.attempt).toBe(1);
    expect(received!.err).toBeInstanceOf(Error);
    expect((received!.err as Error).message).toBe('Connection terminated unexpectedly');
  });

  test('delayMs default is 500ms when not specified', async () => {
    let calls = 0;
    const start = Date.now();
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('ECONNRESET');
        return null;
      },
      // no delayMs override
    );
    const elapsed = Date.now() - start;
    expect(calls).toBe(2);
    // Allow ±50ms tolerance for scheduler jitter
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(2000); // never close to forever
  }, 5000);
});

describe('logBatchRetry helper (v0.41.2.1)', () => {
  let stderrCaptured: string[] = [];
  let originalStderr: typeof console.error;

  beforeEach(() => {
    stderrCaptured = [];
    originalStderr = console.error;
    console.error = (...args: unknown[]) => {
      stderrCaptured.push(args.map(String).join(' '));
    };
  });

  test('writes single stderr line when jsonMode=false', () => {
    logBatchRetry('extract.links_fs', 73, new Error('Connection terminated'), false);
    try {
      expect(stderrCaptured).toHaveLength(1);
      expect(stderrCaptured[0]).toContain('extract.links_fs');
      expect(stderrCaptured[0]).toContain('73');
      expect(stderrCaptured[0]).toContain('Connection terminated');
    } finally {
      console.error = originalStderr;
    }
  });

  test('writes NOTHING when jsonMode=true', () => {
    logBatchRetry('extract.links_fs', 73, new Error('ECONNRESET'), true);
    try {
      expect(stderrCaptured).toHaveLength(0);
    } finally {
      console.error = originalStderr;
    }
  });

  test('handles non-Error throwables by stringifying', () => {
    logBatchRetry('extract.timeline_db', 12, 'string-error', false);
    try {
      expect(stderrCaptured).toHaveLength(1);
      expect(stderrCaptured[0]).toContain('string-error');
    } finally {
      console.error = originalStderr;
    }
  });
});

describe('snapshot-before-clear contract (load-bearing for PR #1416 fix)', () => {
  // This contract is what the 6 flush() sites depend on. The retry primitive
  // doesn't enforce it itself — the call site must snapshot the batch BEFORE
  // clearing it, so a producer pushing during the retry delay can't lose
  // items on retry. We simulate the flush() pattern directly.

  test('snapshot is what retry sends, NOT the post-clear batch', async () => {
    let batch: number[] = [1, 2, 3, 4, 5];
    let receivedOnAttempt: number[][] = [];

    async function flushPattern() {
      if (batch.length === 0) return;
      // Snapshot-before-clear, as flush sites in extract.ts do
      const snapshot = batch.slice();
      batch.length = 0;
      let calls = 0;
      await withRetry(
        async () => {
          calls++;
          receivedOnAttempt.push(snapshot.slice());
          if (calls === 1) {
            // Producer mutates `batch` during the retry delay (simulated by
            // pushing items right now — the retry hasn't fired yet, but in
            // real code the producer's next iteration writes here).
            batch.push(99, 100, 101);
            throw new Error('Connection terminated unexpectedly');
          }
          return snapshot.length;
        },
        { delayMs: 0 },
      );
    }

    await flushPattern();

    // Both attempts must have received the SAME snapshot — not the
    // post-clear batch state. If snapshot-before-clear is broken,
    // attempt 2 sees [99, 100, 101] (producer's new items only).
    expect(receivedOnAttempt).toHaveLength(2);
    expect(receivedOnAttempt[0]).toEqual([1, 2, 3, 4, 5]);
    expect(receivedOnAttempt[1]).toEqual([1, 2, 3, 4, 5]); // retry sends snapshot, not batch
    // batch contains the producer's new items, ready for next flush
    expect(batch).toEqual([99, 100, 101]);
  });

  test('error message uses snapshot length, not post-clear batch length', async () => {
    let batch: number[] = [10, 20, 30];
    let capturedErrorMsg = '';

    async function flushPattern() {
      if (batch.length === 0) return;
      const snapshot = batch.slice();
      batch.length = 0; // batch.length is now 0
      try {
        await withRetry(
          async () => {
            throw new Error('ECONNRESET'); // both attempts fail
          },
          { delayMs: 0 },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The CONTRACT: error message reads snapshot.length, NOT batch.length
        capturedErrorMsg = `batch error (${snapshot.length} rows lost): ${msg}`;
      }
    }

    await flushPattern();
    expect(capturedErrorMsg).toContain('3 rows lost'); // snapshot had 3, not batch's 0
    expect(capturedErrorMsg).toContain('ECONNRESET');
  });
});
