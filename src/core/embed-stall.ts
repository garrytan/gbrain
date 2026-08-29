/**
 * #4599 — progress-keyed stall watchdog for embed drains (mirror of sync's
 * #1950 watchdog in `src/commands/sync.ts` / `sync-reconcile.ts`).
 *
 * The incident shape: an `embed --stale` drain goes quiet forever — a lost
 * promise, a wedged pooler connection (PgBouncer 6543), or an HTTP call whose
 * abort is ignored. The single-flight lock heartbeat keeps refreshing (it
 * fires on its own timer), so nothing bounds the run and the locks are held
 * until a human kills the process. Root cause is unpinned (#4599 stays open);
 * this watchdog bounds the failure: abort, clean up, return a resumable error
 * result.
 *
 * Two clocks, one trigger (wave decision T6+X5):
 *   - LIVENESS is keyed at embedding-API-response grain: EVERY settled embed
 *     call — success, error, or retry attempt — ticks `noteEmbedApiResponse()`
 *     (hooked in `src/core/embed-retry.ts:embedBatchWithBackoff`). Liveness is
 *     diagnostic: it distinguishes "drain fully wedged (no API responses)"
 *     from "live but failing (retry storm)" in the abort message.
 *   - The TRIGGER is SUCCESSFUL forward progress: chunks embedded
 *     (`readProgress()`, wired to `EmbedResult.embedded`). No successful
 *     progress for the threshold ⇒ stall. A provider retry storm that never
 *     lands a chunk WILL trip it BY DESIGN: the run aborts with
 *     `reason: 'stall_timeout'`, locks released, partial progress banked, and
 *     the next run resumes cleanly. Bounded beats unbounded.
 *
 * Consecutive-stall backoff (operator note): each stall abort is resumable,
 * but a persistent wedge (dead provider, poisoned page) will trip EVERY
 * re-run at full threshold cost. Schedulers that auto-re-run embed jobs
 * should back off between consecutive stall aborts rather than tight-loop;
 * the failure_samples / job error carries `stall_timeout` for exactly that
 * classification.
 *
 * Architecture (wave decision X6): this module and its caller
 * (`runEmbedCore`) live below the process boundary — a stall produces an
 * ERROR RESULT (`reason: 'stall_timeout'`), never a `process.exit`. Only the
 * CLI wrapper (`src/commands/embed.ts:runEmbed`) maps it to a non-zero
 * process exit; minion handlers convert it to a failed job via
 * `assertEmbedNotStalled`.
 *
 * The check interval is deliberately NOT unref'd (unlike sync's, which rides
 * alongside an always-awaited drain): for non-single-flight callers the
 * watchdog can be the ONLY handle keeping the event loop alive when the drain
 * promise is lost — unref'ing it would turn the hang into a silent exit-0.
 * `stop()` clears it on every normal path.
 */

import { resolveStallAbortSecondsFromEnv } from './stall-env.ts';

/** Default no-successful-progress window (seconds). Same default as sync's #1950 watchdog. */
export const DEFAULT_EMBED_STALL_ABORT_SEC = 900;

/** Bound on the watchdog's OWN cleanup (lock release + summary flush) before the force path (X5). */
export const EMBED_STALL_CLEANUP_DEADLINE_MS = 10_000;

/**
 * Resolve `GBRAIN_EMBED_STALL_ABORT_SECONDS` (env-only incident knob, mirroring
 * `GBRAIN_SYNC_STALL_ABORT_SECONDS`). Unset/empty/garbage → default 900;
 * `0` (or any value <= 0) disables the watchdog.
 */
export function resolveEmbedStallAbortSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolveStallAbortSecondsFromEnv(
    'GBRAIN_EMBED_STALL_ABORT_SECONDS', DEFAULT_EMBED_STALL_ABORT_SEC, env,
  );
}

// ---------------------------------------------------------------------------
// Embedding-API-response liveness (module-level: embed runs are single-flight
// per process; the drains and the retry wrapper share this one clock).
// ---------------------------------------------------------------------------

let _lastApiResponseAt: number | null = null;

/**
 * Tick the liveness clock. Called by `embedBatchWithBackoff` after EVERY
 * settled embed attempt — success AND error/retry. This is the T6
 * "embedding-API-response grain": retries prove the loop is alive even when
 * nothing is succeeding.
 */
export function noteEmbedApiResponse(now: number = Date.now()): void {
  _lastApiResponseAt = now;
}

/** @internal test seam — reset the module-level liveness clock. */
export function _resetEmbedApiLivenessForTests(): void {
  _lastApiResponseAt = null;
}

export interface EmbedStallInfo {
  thresholdSeconds: number;
  /** ms since the last SUCCESSFUL forward progress (or watchdog start). */
  msSinceLastProgress: number;
  /**
   * ms since the last settled embed API call OBSERVED WHILE THIS WATCHDOG WAS
   * ARMED, or null if none. Scoped to the run so a long-lived worker's
   * previous embed job can't make a fully wedged drain look "alive".
   */
  msSinceLastApiResponse: number | null;
}

export interface EmbedStallWatchdog {
  /** Resolves exactly once, when the stall threshold is crossed. Never rejects. */
  readonly stalled: Promise<EmbedStallInfo>;
  /** True once the watchdog has fired (idempotent — it fires at most once). */
  readonly fired: boolean;
  /** Disarm. Safe to call multiple times and after firing. */
  stop(): void;
}

/**
 * Arm a stall watchdog over a drain. `readProgress()` must be monotonic
 * non-decreasing (chunks embedded); any observed change resets the stall
 * clock. Fires at most once; `stop()` disarms.
 */
export function createEmbedStallWatchdog(opts: {
  thresholdSeconds: number;
  readProgress: () => number;
  /** Test seam. Default: min(5000, threshold ms) — sync's cadence. */
  checkIntervalMs?: number;
  /** Test seam. Default: Date.now. */
  now?: () => number;
}): EmbedStallWatchdog {
  const now = opts.now ?? Date.now;
  const thresholdMs = opts.thresholdSeconds * 1000;
  const checkEveryMs = opts.checkIntervalMs ?? Math.min(5000, thresholdMs);

  let fired = false;
  let lastSeenProgress = opts.readProgress();
  const armedAt = now();
  let lastProgressAt = armedAt;
  let resolveStalled: (info: EmbedStallInfo) => void = () => {};
  const stalled = new Promise<EmbedStallInfo>((resolve) => {
    resolveStalled = resolve;
  });

  const timer = setInterval(() => {
    if (fired) return;
    const cur = opts.readProgress();
    const t = now();
    if (cur !== lastSeenProgress) {
      lastSeenProgress = cur;
      lastProgressAt = t;
      return;
    }
    if (t - lastProgressAt >= thresholdMs) {
      fired = true;
      clearInterval(timer);
      resolveStalled({
        thresholdSeconds: opts.thresholdSeconds,
        msSinceLastProgress: t - lastProgressAt,
        msSinceLastApiResponse:
          _lastApiResponseAt === null || _lastApiResponseAt < armedAt
            ? null
            : t - _lastApiResponseAt,
      });
    }
  }, checkEveryMs);
  // NOT unref'd — see the module comment: for non-single-flight callers this
  // interval can be the only thing keeping a lost-promise hang loud.

  return {
    stalled,
    get fired() {
      return fired;
    },
    stop(): void {
      clearInterval(timer);
      // Do NOT resolve `stalled` here: a stopped watchdog that never fired
      // must never win the caller's race against the drain.
    },
  };
}

/**
 * Convert a stall error RESULT into a thrown error. Minion handlers (`embed`,
 * `embed-catch-up` in `src/commands/jobs.ts`) call this so a stalled drain
 * marks the JOB failed — the X6 contract: core returns, handlers throw, only
 * the CLI wrapper exits the process.
 */
export function assertEmbedNotStalled(result: {
  reason?: 'stall_timeout';
  embedded: number;
}): void {
  if (result.reason !== 'stall_timeout') return;
  throw new Error(
    `embed stall watchdog aborted the drain (reason: stall_timeout): no successful embed progress ` +
      `within GBRAIN_EMBED_STALL_ABORT_SECONDS; partial progress banked (embedded=${result.embedded}), ` +
      `single-flight locks released — re-run (or re-submit the job) to resume.`,
  );
}
