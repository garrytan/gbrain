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
  // Fire-and-forget on purpose. We deliberately do NOT return the promise.
  void (async () => {
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
}
