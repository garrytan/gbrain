// v0.41.18.0 — withRetry stress regression test (T7 / CEO D6).
//
// Pins the contract the engine-level batch wrap depends on:
//   - 30% blip rate (matches the production Supavisor incident shape)
//   - 100 simulated batches
//   - BULK_RETRY_OPTS defaults (maxRetries=3, decorrelated jitter)
//   - Asserts zero row loss when failures are bounded by maxRetries
//   - Asserts retries DO fire (so a future "optimize" can't silently
//     disable retries and pass the suite)
//   - Audit JSONL records correct outcome per case
//
// Lives in .slow.test.ts tier per CLAUDE.md test taxonomy. Uses delayMs=1
// for hermeticity — the test exercises the retry/jitter math + audit emission,
// not real timing.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from '../helpers/with-env.ts';
import {
  withRetry,
  computeNextDelay,
  BULK_RETRY_OPTS,
} from '../../src/core/retry.ts';
import {
  logBatchRetry,
  logBatchExhausted,
  readRecentBatchRetryEvents,
} from '../../src/core/audit/batch-retry-audit.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-stress-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

/**
 * Simulate the engine-level batchRetry helper without spinning up a real
 * engine. Mirrors postgres-engine.ts batchRetry: withRetry + audit emission
 * for both success-after-retry AND exhausted-retry paths.
 */
async function simulateEngineBatchRetry<T>(
  auditSite: 'addLinksBatch',
  batchSize: number,
  fn: () => Promise<T>,
): Promise<T> {
  let prevDelay = 0;
  let onRetryCount = 0;
  try {
    return await withRetry(fn, {
      maxRetries: BULK_RETRY_OPTS.maxRetries,
      delayMs: 1, // hermeticity — not testing real timing
      delayMaxMs: 10,
      jitter: BULK_RETRY_OPTS.jitter,
      onRetry: (attempt, err) => {
        onRetryCount++;
        const delay = computeNextDelay(attempt - 1, prevDelay, 1, 10, BULK_RETRY_OPTS.jitter);
        prevDelay = delay;
        logBatchRetry(auditSite, batchSize, attempt, delay, err);
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'RetryAbortError') throw err;
    const { isRetryableConnError } = await import('../../src/core/retry.ts');
    if (isRetryableConnError(err)) {
      logBatchExhausted(auditSite, batchSize, BULK_RETRY_OPTS.maxRetries + 1, err);
    }
    throw err;
  }
}

describe('stress: 100 batches × 30% blip rate with BULK_RETRY_OPTS', () => {
  test('eventual success on all batches when blip count <= maxRetries', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // Deterministic seeded "blip" generator: a fixed sequence so failures
      // happen at predictable batch positions. 30% blip rate, but the
      // number of CONSECUTIVE blips on any one batch never exceeds 2 (which
      // is comfortably within BULK_RETRY_OPTS.maxRetries=3). This validates
      // the recovery path — zero row loss expected.
      let totalBatches = 0;
      let totalLost = 0;
      let totalRetries = 0;

      for (let batchIdx = 0; batchIdx < 100; batchIdx++) {
        // Each batch fails 0-2 times then succeeds. Pseudo-random based on
        // batchIdx for deterministic test runs.
        const failureBudget = batchIdx % 10 < 3 ? (batchIdx % 3) + 1 : 0;
        let calls = 0;
        try {
          await simulateEngineBatchRetry('addLinksBatch', 100, async () => {
            calls++;
            if (calls <= failureBudget) {
              throw new Error('Connection terminated unexpectedly');
            }
            return 'ok';
          });
          totalBatches++;
          if (failureBudget > 0) totalRetries += failureBudget;
        } catch {
          totalLost++;
        }
      }

      expect(totalBatches).toBe(100);
      expect(totalLost).toBe(0);
      // 30% of batches blip; each blipping batch retries 1-3 times.
      // At minimum some retries should have fired.
      expect(totalRetries).toBeGreaterThan(0);

      // Audit JSONL should record every retry attempt.
      const auditResult = readRecentBatchRetryEvents(24);
      const successEvents = auditResult.events.filter((e) => e.outcome === 'success');
      const exhaustedEvents = auditResult.events.filter((e) => e.outcome === 'exhausted');
      expect(successEvents.length).toBe(totalRetries);
      expect(exhaustedEvents.length).toBe(0);
    });
  }, 30_000);

  test('exhausted retries recorded when blip count > maxRetries', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // Force batch 7 to fail more times than maxRetries allows.
      const failOn = 7;
      const failureCount = BULK_RETRY_OPTS.maxRetries + 1; // exceeds budget
      let lostBatches = 0;
      let successfulBatches = 0;

      for (let batchIdx = 0; batchIdx < 20; batchIdx++) {
        let calls = 0;
        try {
          await simulateEngineBatchRetry('addLinksBatch', 50, async () => {
            calls++;
            if (batchIdx === failOn && calls <= failureCount) {
              throw new Error('Connection terminated unexpectedly');
            }
            return 'ok';
          });
          successfulBatches++;
        } catch {
          lostBatches++;
        }
      }

      expect(successfulBatches).toBe(19);
      expect(lostBatches).toBe(1);

      const auditResult = readRecentBatchRetryEvents(24);
      const exhausted = auditResult.events.filter((e) => e.outcome === 'exhausted');
      expect(exhausted.length).toBe(1);
      expect(exhausted[0].site).toBe('addLinksBatch');
      expect(exhausted[0].batch_size).toBe(50);
    });
  }, 30_000);

  test('non-retryable error propagates immediately, no exhausted audit', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      let calls = 0;
      try {
        await simulateEngineBatchRetry('addLinksBatch', 10, async () => {
          calls++;
          const err = Object.assign(new Error('duplicate key'), { code: '23505' });
          throw err;
        });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toContain('duplicate key');
      }
      expect(calls).toBe(1); // no retry on non-retryable

      const auditResult = readRecentBatchRetryEvents(24);
      // Non-retryable errors are NOT audited — they're caller bugs/data
      // issues, not retry-budget exhaustion.
      expect(auditResult.events.length).toBe(0);
    });
  }, 30_000);
});

describe('decorrelated jitter sanity over 100 attempts', () => {
  test('never produces near-zero delays (codex C-2 regression lock)', () => {
    // Sample 100 retries against BULK_RETRY_OPTS to confirm the floor.
    // Pre-codex-C-2, jitter='full' would have allowed near-zero delays
    // here ~10% of the time. Decorrelated jitter floors at delayMs.
    let prev = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const d = computeNextDelay(
        attempt % BULK_RETRY_OPTS.maxRetries,
        prev,
        BULK_RETRY_OPTS.delayMs,
        BULK_RETRY_OPTS.delayMaxMs,
        BULK_RETRY_OPTS.jitter,
      );
      // Floor at delayMs = 1000ms (Supavisor recovery floor).
      expect(d).toBeGreaterThanOrEqual(BULK_RETRY_OPTS.delayMs);
      expect(d).toBeLessThanOrEqual(BULK_RETRY_OPTS.delayMaxMs);
      prev = d;
    }
  });

  test('cumulative wait reaches >= 8s in worst-case (covers 5-10s Supavisor window)', () => {
    let bestTotal = 0;
    for (let trial = 0; trial < 100; trial++) {
      let prev = 0;
      let total = 0;
      for (let attempt = 0; attempt < BULK_RETRY_OPTS.maxRetries; attempt++) {
        const d = computeNextDelay(
          attempt,
          prev,
          BULK_RETRY_OPTS.delayMs,
          BULK_RETRY_OPTS.delayMaxMs,
          BULK_RETRY_OPTS.jitter,
        );
        prev = d;
        total += d;
      }
      if (total > bestTotal) bestTotal = total;
    }
    // BULK_RETRY_OPTS produces decorrelated worst case ~10+s+ (delayMaxMs cap).
    expect(bestTotal).toBeGreaterThanOrEqual(8000);
  });
});
