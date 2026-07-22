/**
 * Shared retry primitive for transient connection errors (v0.41.18.0).
 *
 * THE PROBLEM
 * -----------
 * Long-running batch loops over Supabase Supavisor (session-mode pooler,
 * port 5432) periodically hit the pooler's circuit breaker (ECIRCUITBREAKER)
 * which needs **5-10s** to recover. The previous v0.41.2.1 helper (extract.ts
 * local `withRetry`) did a single 500ms retry — designed for PgBouncer
 * transaction-mode recycling (sub-second) and inadequate for Supavisor's
 * longer recovery window. Production result: ~3,000 rows lost per dream
 * cycle on a 16K-page brain as the breaker stayed hot across ~30 sequential
 * batches.
 *
 * THE FIX
 * -------
 * This module exports the canonical `withRetry` execution wrapper plus
 * `BULK_RETRY_OPTS` defaults tuned for the Supavisor recovery window.
 * Engine methods (`addLinksBatch` / `addTimelineEntriesBatch` / `upsertChunks`
 * in both postgres-engine.ts and pglite-engine.ts) wrap their internal SQL
 * in `withRetry(BULK_RETRY_OPTS)` so every caller — current AND future —
 * inherits retry as part of the data-primitive's contract.
 *
 * Retry classification routes through the canonical `isRetryableConnError`
 * from `retry-matcher.ts` (re-exported below) so error-shape recognition
 * never drifts across the codebase.
 *
 * BACKOFF MATH (D8 from codex review)
 * ------------------------------------
 * Defaults: `maxRetries=3, delayMs=1000, delayMaxMs=10000, jitter='decorrelated'`.
 * Total worst-case wait: ~1s + ~3s + ~8s = ~12s — covers full Supavisor
 * 5-10s circuit-breaker recovery window. The pre-codex `500/1000/2000`
 * shape totaled 3.5s and could still exhaust before recovery.
 *
 * **Decorrelated jitter** (AWS-style): `nextDelay = uniform(base, prevDelay*3)`
 * capped at `delayMaxMs`. Replaces naive `'full'` jitter (random in
 * [0, computed]) which allowed near-zero delays — bad because near-zero
 * retries re-hit the still-recovering breaker AND fail to randomize the
 * thundering-herd window across workers.
 *
 * ABORT SUPPORT (D9 from codex review)
 * ------------------------------------
 * `withRetry(fn, { signal })` threads an `AbortSignal` through to the
 * inter-attempt sleep. CLI shutdown signals (SIGTERM during deploys) abort
 * sleeping retries cleanly instead of forcing workers to ignore the signal
 * for up to `delayMaxMs` milliseconds.
 *
 * TYPED AUDIT-SITE ENUM (D10c from codex review)
 * ----------------------------------------------
 * `BATCH_AUDIT_SITES` is a closed const enum of every retry-emission site.
 * The CI lint guard `scripts/check-batch-audit-site.sh` fails the build if
 * a string-literal `auditSite: 'xyz'` doesn't appear in this list — catches
 * typo drift before doctor output fragments.
 *
 * ENV OVERRIDES (D3 cherry-pick)
 * ------------------------------
 * - GBRAIN_BULK_MAX_RETRIES   — int >= 0 (0 disables retries for debugging)
 * - GBRAIN_BULK_RETRY_BASE_MS — int > 0
 * - GBRAIN_BULK_RETRY_MAX_MS  — int >= base
 *
 * Bad values throw `GBrainError` with a paste-ready fix hint. Doctor's
 * `batch_retry_health` check also runs the validator at startup so misconfig
 * surfaces immediately, not at first retry.
 */

import { isRetryableConnError } from './retry-matcher.ts';

export { isRetryableConnError };

/**
 * Closed list of every site that emits batch-retry audit events. Add new
 * sites here; the CI guard at `scripts/check-batch-audit-site.sh` validates
 * that every string-literal `auditSite: '...'` in src/ matches an entry.
 */
export const BATCH_AUDIT_SITES = [
  // Engine-method defaults (used when caller doesn't supply auditSite).
  'addLinksBatch',
  'addTimelineEntriesBatch',
  'addTakesBatch',
  'upsertChunks',
  // extract.ts per-site labels.
  'extract.links_inc',
  'extract.timeline_inc',
  'extract.links_fs',
  'extract.timeline_fs',
  'extract.links_db',
  'extract.timeline_db',
  'extract.by_mention',
  // v0.42.7 (#1696): extract --stale incremental sweep.
  'extract.stale',
  // operations.ts MCP put_page auto-link path.
  'mcp.put_page.autolink',
  // sync.ts/reindex.ts orchestrator labels.
  'sync.import_file',
  'reindex.markdown',
  'reindex.multimodal',
  // backfill-base.ts outer connection-retry layer.
  'backfill.outer',
  // queue.ts Minion hot-path lock recovery (issue #1678): promoteDelayed
  // self-heal on a reaped pooler socket. claim/renewLock deliberately do NOT
  // route here (Codex #1/#2) — the poll loop and renewal-tick recover those.
  'minion-lock',
] as const;

export type BatchAuditSite = (typeof BATCH_AUDIT_SITES)[number];

export type JitterMode = 'none' | 'full' | 'decorrelated';

export interface WithRetryOpts {
  /** Maximum retry attempts (default 1 = single retry, v0.41.2.1 back-compat). */
  maxRetries?: number;
  /** Base delay in ms (default 500). */
  delayMs?: number;
  /** Maximum delay cap in ms (default 8000). */
  delayMaxMs?: number;
  /** Jitter policy (default 'none' for back-compat). */
  jitter?: JitterMode;
  /** AbortSignal for clean shutdown during inter-attempt sleep. */
  signal?: AbortSignal;
  /** Audit-site label for observability. Must be in BATCH_AUDIT_SITES. */
  auditSite?: BatchAuditSite;
  /**
   * Per-attempt callback fires on each retry (attempt is 1-based).
   *
   * v0.41.25.0: now awaited. Sync callbacks (the only in-tree shape) work
   * identically; async callbacks correctly delay the inter-attempt sleep.
   */
  onRetry?: (attempt: number, err: unknown) => void | Promise<void>;
  /**
   * v0.41.25.0 — invoked between attempts AFTER `isRetryableConnError`
   * classification but BEFORE the inter-attempt sleep. Use this to rebuild
   * a dead connection / pool before the retry fires.
   *
   * Fail-loud posture (per codex finding 3 from /codex review): if reconnect
   * throws, the throw PROPAGATES out of `withRetry` AS the new error,
   * replacing the original retryable. Operators see the real cause
   * ("auth failed", "EHOSTUNREACH") instead of "No database connection"
   * for hours when DB credentials are bad.
   *
   * Engine-level callers (PostgresEngine.batchRetry) inject
   * `(ctx) => this.reconnect(ctx)` which already handles both module and
   * instance pools, race-safe via the `_reconnecting` guard.
   *
   * v0.42.x (#1685 CODEX #8): receives the triggering error so the engine can
   * classify it (pooler reap vs network/auth) for the pool-recovery audit. The
   * arg is optional — back-compat zero-arg callbacks (`() => this.reconnect()`)
   * still satisfy the type.
   */
  reconnect?: (ctx?: { error?: unknown }) => Promise<void>;
}

/**
 * Tuned defaults for bulk DB writes against Supavisor session-mode pooler.
 * The single source of truth for engine-level retry behavior.
 *
 * Total worst-case wait: ~1s + ~3s + ~8s ≈ 12s. Covers the 5-10s Supavisor
 * circuit-breaker recovery window with headroom.
 */
export const BULK_RETRY_OPTS: Required<Pick<WithRetryOpts, 'maxRetries' | 'delayMs' | 'delayMaxMs' | 'jitter'>> = {
  maxRetries: 3,
  delayMs: 1000,
  delayMaxMs: 10_000,
  jitter: 'decorrelated',
};

/**
 * AbortError variant thrown when `signal` fires mid-retry-sleep. Tagged so
 * callers can distinguish "user/system aborted" from "retries exhausted".
 */
export class RetryAbortError extends Error {
  readonly tag = 'RETRY_ABORTED' as const;
  constructor(message = 'Retry aborted via signal') {
    super(message);
    this.name = 'RetryAbortError';
  }
}

/**
 * Race a setTimeout against an AbortSignal. Resolves after `ms` ms OR rejects
 * with RetryAbortError if signal fires first. Cleans up the timer either way
 * (no zombie timers on abort).
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RetryAbortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RetryAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Compute the next sleep delay given the current attempt index and prior delay.
 * Pure function; deterministic given (rng, params).
 *
 * - jitter='none': exponential `base * 2^attempt`, capped at maxDelay
 * - jitter='full': uniform in [0, computed exponential]
 * - jitter='decorrelated': uniform in [base, prevDelay*3], capped at maxDelay
 */
export function computeNextDelay(
  attempt: number,
  prevDelay: number,
  base: number,
  maxDelay: number,
  jitter: JitterMode,
  rng: () => number = Math.random,
): number {
  if (jitter === 'decorrelated') {
    // AWS-style: nextDelay = uniform(base, prevDelay * 3), capped at maxDelay.
    // On the very first retry (prevDelay === 0), fall back to `base` as the
    // floor so we don't degenerate to uniform(base, 0) which would always
    // pick base. Codex review caught the missing-prevDelay initialization.
    const lo = base;
    const hi = Math.max(base, prevDelay * 3);
    const capped = Math.min(hi, maxDelay);
    // Math.random() returns [0, 1); but tests inject rng=1 for upper-bound
    // assertions, so clamp the result to [lo, capped] to keep the formula
    // safe under any rng. Range can be 0 when lo === capped (first retry
    // floor case); Math.floor handles that.
    return Math.min(capped, Math.max(lo, Math.floor(lo + rng() * (capped - lo + 1))));
  }
  const exponential = Math.min(base * Math.pow(2, attempt), maxDelay);
  if (jitter === 'full') {
    return Math.floor(rng() * exponential);
  }
  return exponential;
}

/**
 * Retry wrapper for transient connection errors.
 *
 * - Default `maxRetries=1` preserves v0.41.2.1's "single 500ms retry" contract.
 * - Pass `BULK_RETRY_OPTS` for the Supavisor-tuned 3-retry exponential shape.
 * - Non-retryable errors (per `isRetryableConnError`) throw immediately.
 * - AbortSignal triggers `RetryAbortError` mid-sleep.
 * - v0.41.25.0: optional `reconnect` callback runs between attempts AFTER
 *   classification but BEFORE the sleep. Fail-loud — a reconnect throw
 *   propagates as the new error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOpts = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 1;
  const baseDelay = opts.delayMs ?? 500;
  const maxDelay = opts.delayMaxMs ?? 8_000;
  const jitter: JitterMode = opts.jitter ?? 'none';
  const signal = opts.signal;

  let lastErr: unknown;
  let prevDelay = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new RetryAbortError();
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableConnError(err)) throw err;
      lastErr = err;
      if (attempt >= maxRetries) break;
      // v0.41.25.0: onRetry is now awaited so async observability + audit
      // hooks correctly run before the inter-attempt sleep. Sync arrows
      // (the only in-tree shape) work identically.
      await opts.onRetry?.(attempt + 1, err);
      // v0.41.25.0: optional reconnect hook. PostgresEngine.batchRetry
      // injects `() => this.reconnect()` so a null-singleton from a
      // sibling caller's mid-process disconnect doesn't keep the retry
      // hammering against a dead reference. Fail-loud: any throw from
      // reconnect (auth failure, network partition) propagates AS the
      // new error — operators see the real cause, not the symptom.
      // v0.41.25 also ships diagnostic instrumentation on disconnect
      // call sites to find the offending caller; this hook is the
      // immediate-recovery half of that pair.
      if (opts.reconnect) {
        if (signal?.aborted) throw new RetryAbortError();
        // Thread the triggering error so the engine can classify it (pooler
        // reap vs other) for the pool-recovery audit (#1685 CODEX #8).
        await opts.reconnect({ error: err });
      }
      const delay = computeNextDelay(attempt, prevDelay, baseDelay, maxDelay, jitter);
      prevDelay = delay;
      await abortableSleep(delay, signal);
    }
  }
  throw lastErr;
}

/**
 * Resolve BULK_RETRY_OPTS from env vars. Called at boundaries that need
 * operator-tunable behavior: engine methods at first-use, doctor at startup.
 *
 * Throws GBrainError with paste-ready fix on bad input. Never silently
 * falls back to defaults — bad config should fail loud.
 */
export function resolveBulkRetryOpts(
  env: NodeJS.ProcessEnv = process.env,
): typeof BULK_RETRY_OPTS {
  const out = { ...BULK_RETRY_OPTS };

  const maxRetries = env.GBRAIN_BULK_MAX_RETRIES;
  if (maxRetries !== undefined && maxRetries !== '') {
    const n = Number(maxRetries);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `GBRAIN_BULK_MAX_RETRIES must be an integer >= 0 (got "${maxRetries}"). ` +
        `Fix: export GBRAIN_BULK_MAX_RETRIES=3   # or 0 to disable retries`,
      );
    }
    out.maxRetries = n;
  }

  const baseMs = env.GBRAIN_BULK_RETRY_BASE_MS;
  if (baseMs !== undefined && baseMs !== '') {
    const n = Number(baseMs);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `GBRAIN_BULK_RETRY_BASE_MS must be an integer > 0 (got "${baseMs}"). ` +
        `Fix: export GBRAIN_BULK_RETRY_BASE_MS=1000`,
      );
    }
    out.delayMs = n;
  }

  const maxMs = env.GBRAIN_BULK_RETRY_MAX_MS;
  if (maxMs !== undefined && maxMs !== '') {
    const n = Number(maxMs);
    if (!Number.isInteger(n) || n < out.delayMs) {
      throw new Error(
        `GBRAIN_BULK_RETRY_MAX_MS must be an integer >= GBRAIN_BULK_RETRY_BASE_MS=${out.delayMs} ` +
        `(got "${maxMs}"). Fix: export GBRAIN_BULK_RETRY_MAX_MS=10000`,
      );
    }
    out.delayMaxMs = n;
  }

  return out;
}

/**
 * Type guard for valid audit-site labels. Use at call sites that accept
 * runtime strings (e.g. CLI flags) to fail loudly on unknown sites.
 */
export function isBatchAuditSite(value: string): value is BatchAuditSite {
  return (BATCH_AUDIT_SITES as readonly string[]).includes(value);
}
