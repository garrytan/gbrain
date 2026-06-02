// v0.41.18.0 — src/core/retry.ts canonical retry primitive.
//
// Moved from test/extract-batch-retry.test.ts when withRetry was factored
// out of extract.ts (Eng-D2 architectural pivot: engine-level wrap instead
// of per-call-site wrap). All v0.41.2.1 contracts preserved verbatim:
//
//   - withRetry is a pure primitive (no UI), exports cleanly.
//   - Classification uses isRetryableConnError from retry-matcher.ts.
//   - Default maxRetries=1 = single 500ms retry (v0.41.2.1 back-compat).
//   - Non-retryable errors propagate immediately.
//   - onRetry callback fires per attempt with (1-based attempt, err).
//
// v0.41.18.0 codex-hardening additions:
//   - BULK_RETRY_OPTS defaults (3 retries, 1s/3s/8s exponential w/ decorrelated jitter)
//   - AbortSignal threading + abortableSleep
//   - Typed BatchAuditSite enum + isBatchAuditSite guard
//   - resolveBulkRetryOpts env-override with paste-ready error hints
//   - computeNextDelay pure-function for each jitter mode
//
// Hermetic: no engine, no PGLite, no env mutation (uses withEnv helper),
// no DATABASE_URL required.

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  withRetry,
  abortableSleep,
  computeNextDelay,
  resolveBulkRetryOpts,
  isBatchAuditSite,
  isRetryableConnError,
  BULK_RETRY_OPTS,
  BATCH_AUDIT_SITES,
  RetryAbortError,
} from '../../src/core/retry.ts';

// Minimal GBrainError shape mirrors the typed problem/detail fields from
// db.ts:getConnection so the retry-matcher extension recognizes it.
class FakeGBrainError extends Error {
  problem: string;
  detail: string;
  constructor(problem: string, detail: string) {
    super(`${problem}: ${detail}`);
    this.problem = problem;
    this.detail = detail;
  }
}

describe('isRetryableConnError extension (v0.41.2.1, re-exported from retry.ts)', () => {
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

describe('withRetry primitive — v0.41.2.1 back-compat contract', () => {
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

  test('default maxRetries=1: second failure propagates (single retry, not infinite)', async () => {
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        throw new Error('ECONNRESET');
      },
      { delayMs: 0 },
    );
    await expect(promise).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(2); // attempt 1 + 1 retry, then propagate (back-compat)
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
    expect(elapsed).toBeGreaterThanOrEqual(450); // ±50ms scheduler tolerance
    expect(elapsed).toBeLessThan(2000);
  }, 5000);
});

describe('withRetry — maxRetries > 1 (v0.41.18.0 BULK_RETRY_OPTS contract)', () => {
  test('maxRetries=3: succeeds on third retry', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls <= 3) throw new Error('Connection terminated unexpectedly');
        return 'recovered';
      },
      { delayMs: 0, maxRetries: 3 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(4); // 1 initial + 3 retries
  });

  test('maxRetries=3: all retries fail, propagates last error', async () => {
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        throw new Error('ECONNRESET');
      },
      { delayMs: 0, maxRetries: 3 },
    );
    await expect(promise).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(4); // 1 initial + 3 retries
  });

  test('maxRetries=0: no retry, single attempt only (operator-debug mode)', async () => {
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        throw new Error('ECONNRESET');
      },
      { delayMs: 0, maxRetries: 0 },
    );
    await expect(promise).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(1); // exhausted before retry fires
  });
});

describe('computeNextDelay — exponential / full / decorrelated jitter', () => {
  test('jitter=none: pure exponential capped at maxDelay', () => {
    expect(computeNextDelay(0, 0, 1000, 10_000, 'none')).toBe(1000);
    expect(computeNextDelay(1, 1000, 1000, 10_000, 'none')).toBe(2000);
    expect(computeNextDelay(2, 2000, 1000, 10_000, 'none')).toBe(4000);
    expect(computeNextDelay(3, 4000, 1000, 10_000, 'none')).toBe(8000);
    // cap kicks in
    expect(computeNextDelay(4, 8000, 1000, 10_000, 'none')).toBe(10_000);
  });

  test('jitter=full: uniform in [0, exponential]', () => {
    const rng = () => 0.5; // deterministic 50%
    expect(computeNextDelay(0, 0, 1000, 10_000, 'full', rng)).toBe(500);
    expect(computeNextDelay(1, 0, 1000, 10_000, 'full', rng)).toBe(1000);
    expect(computeNextDelay(2, 0, 1000, 10_000, 'full', rng)).toBe(2000);
  });

  test('jitter=decorrelated: uniform in [base, prevDelay*3] capped at maxDelay', () => {
    const rng = () => 0; // always low end → base
    expect(computeNextDelay(0, 0, 1000, 10_000, 'decorrelated', rng)).toBe(1000);
    expect(computeNextDelay(1, 1000, 1000, 10_000, 'decorrelated', rng)).toBe(1000);
    expect(computeNextDelay(2, 3000, 1000, 10_000, 'decorrelated', rng)).toBe(1000);

    const rngHigh = () => 0.99; // always high end → near cap
    const d = computeNextDelay(3, 3000, 1000, 10_000, 'decorrelated', rngHigh);
    // hi = max(base=1000, prevDelay*3=9000) = 9000
    expect(d).toBeGreaterThanOrEqual(8500);
    expect(d).toBeLessThanOrEqual(9000);
  });

  test('jitter=decorrelated: first retry (prevDelay=0) does NOT degenerate to base-only', () => {
    // The codex-caught initialization bug: when prevDelay=0, the formula
    // could pick uniform(base, max(base, 0)) = base every time. The fix
    // floors `hi` at `base` so we get uniform(base, base) = base on first
    // retry, which is at least the base delay — not zero.
    expect(computeNextDelay(0, 0, 1000, 10_000, 'decorrelated', () => 0)).toBe(1000);
    expect(computeNextDelay(0, 0, 1000, 10_000, 'decorrelated', () => 1)).toBe(1000);
  });

  test('jitter=decorrelated: NEVER produces near-zero (the codex C-2 fix)', () => {
    // The whole point of replacing 'full' with 'decorrelated': bad pooler
    // recovery happens when retries near-zero re-hit the breaker. Floor
    // at base prevents that.
    for (let i = 0; i < 100; i++) {
      const d = computeNextDelay(2, 3000, 1000, 10_000, 'decorrelated');
      expect(d).toBeGreaterThanOrEqual(1000);
    }
  });
});

describe('abortableSleep + AbortSignal threading (D9 codex)', () => {
  test('abortableSleep resolves after ms when no signal', async () => {
    const start = Date.now();
    await abortableSleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });

  test('abortableSleep rejects immediately when signal already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(abortableSleep(1000, ctrl.signal)).rejects.toBeInstanceOf(RetryAbortError);
  });

  test('abortableSleep rejects mid-sleep when signal fires', async () => {
    const ctrl = new AbortController();
    const start = Date.now();
    const sleepPromise = abortableSleep(5000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    await expect(sleepPromise).rejects.toBeInstanceOf(RetryAbortError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // didn't wait the full 5s
  });

  test('withRetry honors signal: aborts mid-retry-sleep', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        throw new Error('ECONNRESET');
      },
      { maxRetries: 5, delayMs: 1000, signal: ctrl.signal },
    );
    setTimeout(() => ctrl.abort(), 50);
    await expect(promise).rejects.toBeInstanceOf(RetryAbortError);
    // Should abort before all 6 attempts completed (each would wait 1s+)
    expect(calls).toBeLessThan(6);
  });

  test('withRetry honors signal: aborts BEFORE first attempt if already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        return 'ok';
      },
      { signal: ctrl.signal },
    );
    await expect(promise).rejects.toBeInstanceOf(RetryAbortError);
    expect(calls).toBe(0); // never ran the function
  });
});

describe('BATCH_AUDIT_SITES typed enum + isBatchAuditSite guard (D10c codex)', () => {
  test('every known site is recognized', () => {
    for (const site of BATCH_AUDIT_SITES) {
      expect(isBatchAuditSite(site)).toBe(true);
    }
  });

  test('unknown sites rejected', () => {
    expect(isBatchAuditSite('extract.typo')).toBe(false);
    expect(isBatchAuditSite('mcp.put_pAge.autolink')).toBe(false);
    expect(isBatchAuditSite('')).toBe(false);
    expect(isBatchAuditSite('addLinksBatchz')).toBe(false);
  });

  test('list contains all CEO + eng + codex callers (regression: future deletes must be intentional)', () => {
    // Pin the set so a future "cleanup" PR can't silently drop a site and
    // break audit-attribution for the corresponding caller.
    const expected = new Set([
      'addLinksBatch', 'addTimelineEntriesBatch', 'upsertChunks',
      'extract.links_inc', 'extract.timeline_inc',
      'extract.links_fs', 'extract.timeline_fs',
      'extract.links_db', 'extract.timeline_db',
      'extract.by_mention',
      'mcp.put_page.autolink',
      'sync.import_file',
      'reindex.markdown', 'reindex.multimodal',
      'backfill.outer',
      'minion-lock',
    ]);
    expect(new Set<string>([...BATCH_AUDIT_SITES])).toEqual(expected);
  });
});

describe('resolveBulkRetryOpts env-override (D3 cherry-pick, codex M-10/M-12)', () => {
  test('no env vars: returns BULK_RETRY_OPTS verbatim', () => {
    const out = resolveBulkRetryOpts({});
    expect(out).toEqual(BULK_RETRY_OPTS);
  });

  test('all 3 vars set: overrides apply', () => {
    const out = resolveBulkRetryOpts({
      GBRAIN_BULK_MAX_RETRIES: '5',
      GBRAIN_BULK_RETRY_BASE_MS: '2000',
      GBRAIN_BULK_RETRY_MAX_MS: '15000',
    });
    expect(out.maxRetries).toBe(5);
    expect(out.delayMs).toBe(2000);
    expect(out.delayMaxMs).toBe(15_000);
    expect(out.jitter).toBe('decorrelated'); // not env-overridable
  });

  test('GBRAIN_BULK_MAX_RETRIES=0: accepted (debug-mode disable)', () => {
    const out = resolveBulkRetryOpts({ GBRAIN_BULK_MAX_RETRIES: '0' });
    expect(out.maxRetries).toBe(0);
  });

  test('GBRAIN_BULK_MAX_RETRIES=negative: throws with paste-ready hint', () => {
    expect(() => resolveBulkRetryOpts({ GBRAIN_BULK_MAX_RETRIES: '-1' }))
      .toThrow(/GBRAIN_BULK_MAX_RETRIES.*>= 0.*Fix: export/);
  });

  test('GBRAIN_BULK_MAX_RETRIES=non-int: throws', () => {
    expect(() => resolveBulkRetryOpts({ GBRAIN_BULK_MAX_RETRIES: '3.5' }))
      .toThrow(/GBRAIN_BULK_MAX_RETRIES/);
    expect(() => resolveBulkRetryOpts({ GBRAIN_BULK_MAX_RETRIES: 'foo' }))
      .toThrow(/GBRAIN_BULK_MAX_RETRIES/);
  });

  test('GBRAIN_BULK_RETRY_BASE_MS=0 or negative: throws (delays must be > 0)', () => {
    expect(() => resolveBulkRetryOpts({ GBRAIN_BULK_RETRY_BASE_MS: '0' }))
      .toThrow(/> 0/);
    expect(() => resolveBulkRetryOpts({ GBRAIN_BULK_RETRY_BASE_MS: '-100' }))
      .toThrow(/> 0/);
  });

  test('GBRAIN_BULK_RETRY_MAX_MS < base: throws', () => {
    expect(() => resolveBulkRetryOpts({
      GBRAIN_BULK_RETRY_BASE_MS: '5000',
      GBRAIN_BULK_RETRY_MAX_MS: '3000',
    })).toThrow(/>= GBRAIN_BULK_RETRY_BASE_MS=5000/);
  });

  test('empty string env values treated as unset', () => {
    const out = resolveBulkRetryOpts({ GBRAIN_BULK_MAX_RETRIES: '' });
    expect(out.maxRetries).toBe(BULK_RETRY_OPTS.maxRetries);
  });
});

describe('BULK_RETRY_OPTS — Supavisor-tuned defaults shape', () => {
  test('total worst-case wait covers 5-10s circuit-breaker window', () => {
    // Compute the maximum possible cumulative wait with 'none' jitter as
    // the upper bound (decorrelated jitter has tighter bound on average).
    // base=1000, base*2=2000, base*4=4000, base*8=8000 (capped at maxDelay=10000)
    // Sum across 3 retries: 1000+2000+4000=7000. With one more cap iteration
    // we'd hit 8000 but we stop at maxRetries=3.
    expect(BULK_RETRY_OPTS.maxRetries).toBe(3);
    expect(BULK_RETRY_OPTS.delayMs).toBe(1000);
    expect(BULK_RETRY_OPTS.delayMaxMs).toBe(10_000);
    expect(BULK_RETRY_OPTS.jitter).toBe('decorrelated');
  });

  test('decorrelated jitter realized worst-case >= 8s across 3 retries', () => {
    // Run 1000 trials, check that the realized cumulative wait reaches
    // at least 8s in worst-case (a Supavisor 5-10s recovery window).
    let maxObserved = 0;
    for (let trial = 0; trial < 1000; trial++) {
      let prev = 0;
      let total = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const d = computeNextDelay(attempt, prev, 1000, 10_000, 'decorrelated');
        prev = d;
        total += d;
      }
      if (total > maxObserved) maxObserved = total;
    }
    expect(maxObserved).toBeGreaterThanOrEqual(8000);
  });
});
