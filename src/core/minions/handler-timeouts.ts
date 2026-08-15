/**
 * handler-timeouts.ts — per-handler default wall-clock budgets (#1737).
 *
 * Short jobs (shell, lint, backlinks) want the tight default wall-clock
 * (`2 * lockDuration * max_stalled`, computed in `handleWallClockTimeouts`
 * when `timeout_ms IS NULL`). Long jobs do not: a 30-min LLM loop or a
 * 10-15 min embed backfill submitted WITHOUT an explicit `timeout_ms` would
 * inherit that short null-default and get wall-clock-killed mid-progress —
 * one half of #1737's thrash.
 *
 * Three layers apply the default (an explicit `opts.timeout_ms` always wins):
 *
 *   1. SUBMIT — `MinionQueue.add` stamps the default onto the row. The value
 *      lives in `minion_jobs.timeout_ms`, not worker memory, so wall-clock
 *      behavior is stable across worker restart.
 *   2. CLAIM — `MinionQueue.claim` COALESCEs a NULL `timeout_ms` from this
 *      map (and derives `timeout_at` from the coalesced value). This is the
 *      durable invariant: it covers rows inserted before layer 1 existed and
 *      any writer that bypasses add(). Persisted by the claim UPDATE, so the
 *      restart-stability property holds here too.
 *   3. ONE-SHOT — migration v128 backfilled `timeout_ms` for non-terminal
 *      rows that predate both layers (they would otherwise never re-claim
 *      or die at the short null-default first). v128's values are a
 *      deliberate authoring-time SNAPSHOT of this map — do NOT sync v128
 *      when editing the map below; layer 2 owns all future drift.
 *
 * The 30-min anchor matches the explicit value cycle/patterns.ts already
 * passes for subagent jobs, so this generalizes an existing convention
 * rather than inventing a new number.
 */

const THIRTY_MIN_MS = 30 * 60 * 1000;
const SIXTY_MIN_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

/**
 * Default wall-clock budget (ms) for long-running handler types. A handler
 * not in this map returns `null` → the short null-default wall-clock applies.
 */
export const HANDLER_DEFAULT_TIMEOUT_MS: Readonly<Record<string, number>> = {
  subagent: THIRTY_MIN_MS,
  subagent_aggregator: THIRTY_MIN_MS,
  'embed-backfill': THIRTY_MIN_MS,
  'autopilot-cycle': THIRTY_MIN_MS,
  // #2194 fix #3: brain-wide maintenance (embed-all/orphans/purge/…) can run
  // longer than a single source cycle; give it the same 30-min budget.
  'autopilot-global-maintenance': THIRTY_MIN_MS,
  // v0.42.x (#2390) — Life Chronicle: one page = one LLM extraction call + a
  // few writes. Generous 10-min budget (vs the tight null-default) covers a
  // slow gateway without the 30-min loop budget.
  chronicle_extract: TEN_MIN_MS,
  // #3207 — same shape as chronicle_extract: one page = one LLM extraction
  // call + a few writes. Was missing from this map, so it inherited the tight
  // null-default and got dead-lettered mid-generation on slow chat providers
  // (facts silently lost) — exactly the failure this file exists to prevent.
  'facts-absorb': TEN_MIN_MS,
  // Per-page contextual reindex jobs process chunks sequentially with one
  // rate-leased LLM synopsis call per chunk; large transcript pages need more
  // than the standard 30-min long-job budget.
  contextual_reindex_per_chunk: SIXTY_MIN_MS,
};

/**
 * The default `timeout_ms` to stamp for a handler when the submitter didn't
 * pass one. Returns `null` for short handlers (keep the tight wall-clock).
 */
export function defaultTimeoutMsFor(jobName: string): number | null {
  return HANDLER_DEFAULT_TIMEOUT_MS[jobName] ?? null;
}
