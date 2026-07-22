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
 * Fix: known long handlers get a sane long default STAMPED ONTO THE JOB ROW
 * at submit time (see `MinionQueue.add`). Stamping at submit (not mutating at
 * claim) keeps the wall-clock behavior stable across worker restart — the
 * value lives in `minion_jobs.timeout_ms`, not in worker memory.
 *
 * Existing already-queued jobs are NOT backfilled: they keep whatever
 * `timeout_ms` they were inserted with (usually NULL → the old behavior).
 * Only NEW submissions pick up the default. An explicit `opts.timeout_ms`
 * always wins.
 *
 * The 30-min anchor matches the explicit value cycle/patterns.ts already
 * passes for subagent jobs, so this generalizes an existing convention
 * rather than inventing a new number.
 */

const THIRTY_MIN_MS = 30 * 60 * 1000;
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
};

/**
 * The default `timeout_ms` to stamp for a handler when the submitter didn't
 * pass one. Returns `null` for short handlers (keep the tight wall-clock).
 */
export function defaultTimeoutMsFor(jobName: string): number | null {
  return HANDLER_DEFAULT_TIMEOUT_MS[jobName] ?? null;
}
