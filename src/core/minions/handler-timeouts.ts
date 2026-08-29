/**
 * handler-timeouts.ts — per-handler-type defaults for the TWO time knobs a
 * Minion job carries: the wall-clock budget (`timeout_ms`, #1737) and the
 * lock lease (`lock_duration_ms`, #4145). They are DIFFERENT quantities —
 * the budget bounds total runtime (subagent: 30min), the lease bounds how
 * long a dead worker's claim survives before the stall sweep reclaims it
 * (subagent: 300s) — and deriving one from the other would couple two
 * unrelated tunables behind an implicit ratio policy. Both maps live here,
 * under one header, precisely so they can't drift apart unseen.
 *
 * WALL-CLOCK BUDGETS: short jobs (shell, lint, backlinks) want the tight
 * default wall-clock (`2 * lock * max_stalled`, computed in
 * `handleWallClockTimeouts` when `timeout_ms IS NULL`). Long jobs do not: a
 * 30-min LLM loop submitted WITHOUT an explicit `timeout_ms` would inherit
 * that short null-default and get wall-clock-killed mid-progress.
 *
 * LOCK LEASES: the worker-global default lease is 30s — right for 2s shell
 * jobs (fast dead-worker reclaim), structurally wrong for 173s-average LLM
 * jobs, which had to renew ~12 consecutive times per run; under host CPU
 * saturation a missed window force-evicted healthy handlers (the #4145
 * incident). Long handlers get a 300s lease (5 renewal chances at the
 * clamped 60s cadence); `shell` deliberately stays NULL → worker default
 * (child processes don't starve the loop, and verify-before-evict protects
 * them anyway). Trade: dead-worker reclaim for mapped types slows to
 * ≤ lease + reclaim grace + sweep cadence.
 *
 * Both defaults apply through the same layers (an explicit opts value
 * always wins):
 *
 *   1. SUBMIT — `MinionQueue.add` stamps the default onto the row. The value
 *      lives on minion_jobs, not worker memory, so behavior is stable
 *      across worker restart.
 *   2. CLAIM — `MinionQueue.claim` COALESCEs a NULL column from the map
 *      (and derives `timeout_at` / `lock_until` from the coalesced value).
 *      This is the durable invariant: it covers rows inserted before
 *      layer 1 existed and any writer that bypasses add().
 *   3. ONE-SHOT — migration v128 backfilled `timeout_ms` for pre-#1737
 *      rows. v128's values are a deliberate authoring-time SNAPSHOT — do
 *      NOT sync v128 when editing the maps; layer 2 owns all future drift.
 *      (`lock_duration_ms` needs no backfill: NULL simply means "worker
 *      default", which is the pre-#4145 behavior.)
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
  'connector-sync': THIRTY_MIN_MS,
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

const FIVE_MIN_MS = 5 * 60 * 1000;
const TWO_MIN_MS = 2 * 60 * 1000;

/**
 * Default lock lease (ms) for long-running handler types (#4145). A handler
 * not in this map returns `null` → the worker-global `lockDuration` default
 * (30s) applies — see the header for why `shell` is deliberately absent.
 * 300s = the issue's proposed lease for 173s-average LLM jobs (5 renewal
 * chances at the 60s clamped cadence); 120s covers the single-LLM-call
 * handlers whose p99 comfortably exceeds a 30s lease.
 */
export const HANDLER_DEFAULT_LOCK_DURATION_MS: Readonly<Record<string, number>> = {
  subagent: FIVE_MIN_MS,
  subagent_aggregator: FIVE_MIN_MS,
  'embed-backfill': FIVE_MIN_MS,
  'connector-sync': FIVE_MIN_MS,
  'autopilot-cycle': FIVE_MIN_MS,
  'autopilot-global-maintenance': FIVE_MIN_MS,
  contextual_reindex_per_chunk: FIVE_MIN_MS,
  chronicle_extract: TWO_MIN_MS,
  'facts-absorb': TWO_MIN_MS,
};

export function defaultLockDurationMsFor(jobName: string): number | null {
  return HANDLER_DEFAULT_LOCK_DURATION_MS[jobName] ?? null;
}

/** Clamp bounds for explicit per-job lease input — [5s, 1h]. The floor
 *  kills the 1ms-lock foot-gun (instant stall-reclaim thrash); the ceiling
 *  kills the immortal-lock foot-gun (a crashed worker's claim surviving an
 *  hour). Shared by queue.add, the CLI flag, and the MCP op (ENG-E4) so
 *  three hand-copied bounds can't drift. The DB CHECK only enforces > 0;
 *  this clamp is the operative bound (precedent: max_stalled [1,100]). */
export const LOCK_DURATION_MS_MIN = 5_000;
export const LOCK_DURATION_MS_MAX = 3_600_000;

export function clampLockDurationMs(raw: number): number {
  return Math.max(LOCK_DURATION_MS_MIN, Math.min(LOCK_DURATION_MS_MAX, Math.floor(raw)));
}
