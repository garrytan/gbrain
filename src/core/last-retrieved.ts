/**
 * v0.37.0 — `pages.last_retrieved_at` write-back for the LSD stale-page signal.
 *
 * Architecture (codex round 2 #3 + D11 + D2 + D13):
 *
 * - Op-layer, NOT engine-layer. This module is called from the `search` /
 *   `query` / `get_page` op handlers in `operations.ts` AFTER the engine
 *   returns. Internal callers (sync, migrations, helper flows) bypass the
 *   op layer entirely, so this never fires from `import-file.ts`, the
 *   dream cycle, doctor probes, etc. Pure signal: "a user-facing surface
 *   just surfaced this page."
 *
 * - 5-min throttle (D2). The UPDATE includes a `WHERE last_retrieved_at IS
 *   NULL OR last_retrieved_at < NOW() - INTERVAL '5 minutes'` clause so
 *   hot pages surfaced by many concurrent searches don't pile up MVCC
 *   row versions. ~90% of writes skipped in steady state on a heavily-
 *   searched brain. Mirrors `embedded_at` reset gating in `upsertChunks`.
 *
 * - Default-on with `search.track_retrieval` config escape hatch (D13).
 *   Operators worried about per-search write amplification can opt out:
 *   `gbrain config set search.track_retrieval false`. `gbrain doctor`'s
 *   brainstorm_health check surfaces the setting.
 *
 * - Best-effort. Any error (column missing, network blip, statement
 *   timeout) is swallowed with a stderr warn. The op result is unaffected.
 *   Two failure modes deserve graceful degradation: a pre-v77 brain that
 *   somehow reaches this code (column missing → SQLSTATE 42703) and a
 *   transient connection error.
 *
 * - Fire-and-forget. Caller does NOT await; the UPDATE runs concurrently
 *   with response serialization. If the caller awaited, a slow UPDATE
 *   would add latency to the visible response. Best-effort + concurrent =
 *   the user never sees the write-back cost in the response time.
 */

import type { BrainEngine } from './engine.ts';
import { isUndefinedColumnError } from './utils.ts';

let _trackRetrievalCache: { ts: number; enabled: boolean } | null = null;
const TRACK_RETRIEVAL_CACHE_TTL_MS = 30_000;

/**
 * v0.41.8.0 — fire-and-forget tracking + bounded drain.
 *
 * Issues #1247, #1269, #1290: PGLite CLI commands printed search /
 * query / get_page output then hung at ~95-98% CPU until SIGKILL.
 * Root cause: the IIFE below races `engine.disconnect()`. PGLite's
 * WASM runtime kept Bun's event loop alive while the dangling
 * UPDATE settled, and disconnect closed the DB out from under it.
 *
 * Solution mirrors the v0.36.1.x #1090 fix at
 * `src/core/search/hybrid.ts:awaitPendingSearchCacheWrites`: track
 * every IIFE promise in this module-scoped Set, expose a drain that
 * resolves once all settle. The CLI awaits the drain before
 * `engine.disconnect()` so the WASM handle never closes mid-write.
 *
 * Bounded with a 5s timeout via Promise.race. If a future
 * fire-and-forget bug produces a permanently-pending promise, the
 * drain stderr-warns with the pending count and resolves so the CLI
 * can disconnect rather than re-creating the hang at this layer.
 * The cli.ts caller then falls back to a narrow `process.exit(0)`
 * (only on timeout, only for non-daemon commands) to guarantee
 * exit. The companion `awaitPendingSearchCacheWrites` retrofit is
 * filed as a v0.41+ TODO to keep both helpers symmetric.
 */
const pendingLastRetrievedWrites = new Set<Promise<unknown>>();
const DRAIN_TIMEOUT_MS = 5_000;

export type DrainOutcome = { outcome: 'drained' | 'timeout'; pending: number };

export async function awaitPendingLastRetrievedWrites(
  timeoutMs: number = DRAIN_TIMEOUT_MS,
): Promise<DrainOutcome> {
  if (pendingLastRetrievedWrites.size === 0) {
    return { outcome: 'drained', pending: 0 };
  }
  // Snapshot up front: if a new write appears after we start draining,
  // we deliberately don't await it. CLI flow guarantees op-dispatch
  // is complete before this call, so the set is effectively frozen.
  const snapshot = Array.from(pendingLastRetrievedWrites);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const drain = Promise.allSettled(snapshot).then(() => 'drained' as const);
  const outcome = await Promise.race([drain, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    const pending = pendingLastRetrievedWrites.size;
    console.warn(
      `[last-retrieved] drain timed out after ${timeoutMs}ms; ` +
        `${pending} writes still pending`,
    );
    // Adversarial-review C1: in long-lived daemons (`gbrain serve`), a
    // timed-out IIFE stays in the set forever because its `.finally`
    // never fires. Repeated timeouts leak references without bound.
    // Drop this snapshot's tracked promises explicitly so the next
    // drain doesn't see ghosts. The IIFEs themselves keep running and
    // their results are still discarded; we just stop accumulating
    // references to forever-pending work.
    for (const p of snapshot) {
      pendingLastRetrievedWrites.delete(p);
    }
    return { outcome: 'timeout', pending };
  }
  return { outcome: 'drained', pending: 0 };
}

function trackLastRetrievedWrite(promise: Promise<unknown>): void {
  pendingLastRetrievedWrites.add(promise);
  promise
    .finally(() => pendingLastRetrievedWrites.delete(promise))
    .catch(() => {
      /* swallow — IIFE already logged; .finally already removed */
    });
}

/** Test seam — clears the pending set so each test starts clean. */
export function _resetPendingLastRetrievedWritesForTests(): void {
  pendingLastRetrievedWrites.clear();
}

/** Test seam — peek the current pending count. */
export function _peekPendingLastRetrievedWritesForTests(): number {
  return pendingLastRetrievedWrites.size;
}

/**
 * Resolve `search.track_retrieval` config with a 30s in-process cache so
 * hot-path callers don't pay a SELECT per search. Default-on: missing
 * config OR unparseable value → true (D13 default).
 */
async function isTrackingEnabled(engine: BrainEngine): Promise<boolean> {
  const now = Date.now();
  if (_trackRetrievalCache && now - _trackRetrievalCache.ts < TRACK_RETRIEVAL_CACHE_TTL_MS) {
    return _trackRetrievalCache.enabled;
  }
  let enabled = true;
  try {
    const raw = await engine.getConfig('search.track_retrieval');
    if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') {
      enabled = false;
    }
  } catch {
    // getConfig miss / connection blip → default to enabled (D13 default).
  }
  _trackRetrievalCache = { ts: now, enabled };
  return enabled;
}

/** Test seam — drops the cache so subsequent calls re-read config. */
export function _resetTrackRetrievalCacheForTests(): void {
  _trackRetrievalCache = null;
}

/**
 * Bump `last_retrieved_at` on the given page_ids. Fire-and-forget — caller
 * MUST NOT await this for the op response. Empty ids list is a no-op.
 *
 * @param engine The BrainEngine handling the op.
 * @param pageIds The page ids surfaced by the op (search hits, query results,
 *   or the single id returned by get_page).
 */
export function bumpLastRetrievedAt(engine: BrainEngine, pageIds: number[]): void {
  if (pageIds.length === 0) return;
  // Fire-and-forget on purpose for callers (MCP, internal). The CLI
  // path awaits the drain helper below before disconnecting, which
  // is how #1247/#1269/#1290 are fixed without exposing the IIFE
  // promise to every caller.
  const promise = (async () => {
    try {
      const enabled = await isTrackingEnabled(engine);
      if (!enabled) return;
      // 5-minute throttle (D2) + best-effort. The UPDATE is idempotent:
      // setting last_retrieved_at = NOW() multiple times in a row is the
      // same as setting it once (TIMESTAMPTZ comparison is monotonic).
      await engine.executeRaw(
        `UPDATE pages
           SET last_retrieved_at = NOW()
           WHERE id = ANY($1::int[])
             AND (last_retrieved_at IS NULL
                  OR last_retrieved_at < NOW() - INTERVAL '5 minutes')`,
        [pageIds]
      );
    } catch (err) {
      // Pre-v77 brain (column missing) falls through silently — the search
      // op already returned, the LSD signal just stays NULL until upgrade.
      if (isUndefinedColumnError(err, 'last_retrieved_at')) return;
      // Other errors: stderr-warn but don't break the op response.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[last-retrieved] write-back failed (best-effort): ${msg}`);
    }
  })();
  trackLastRetrievedWrite(promise);
}
