/**
 * issue #1685 (GAP C) — cause-ranked doctor issues.
 *
 * The #1685 posture ask: `gbrain doctor` is the single health truth, and it
 * surfaces CAUSE before symptoms. During the #1678 incident the loud lines were
 * all downstream DB-cascade noise (CONNECTION_ENDED, lock-renewal-failed) while
 * the one true cause (RSS-watchdog OOM kill) scrolled by once. This module ranks
 * the non-ok checks so the operator reads root causes first.
 *
 * HONESTY CONTRACT (CODEX #9): two checks both failing does NOT prove one caused
 * the other. So:
 *   - Tier membership (root vs symptom) is ORDERING ONLY. It sorts roots above
 *     symptoms; it asserts NO causality.
 *   - `downstream_of` — the one place we DO claim a causal link — is set ONLY
 *     from a small map of KNOWN, grounded edges, AND only when the named root is
 *     itself in the failing set. It is deliberately NOT a root×symptom cartesian.
 *     "Everything failing is downstream of every root" is the false-precision we
 *     refuse to ship.
 *
 * Pure: no I/O, no engine, no process.exit. Unit-tested directly by
 * `test/doctor-cause-rank.test.ts`, including the drift guard that every name in
 * the cause graph still exists in `doctor-categories.ts` (DECISION 4A).
 */

import {
  BRAIN_CHECK_NAMES,
  SKILL_CHECK_NAMES,
  OPS_CHECK_NAMES,
  META_CHECK_NAMES,
} from './doctor-categories.ts';

/** Minimal structural shape of a doctor Check that ranking needs. */
export interface RankableCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  details?: Record<string, unknown>;
}

export interface RankedIssue {
  name: string;
  status: 'warn' | 'fail';
  /**
   * Coarse sort bucket. `root` = a designated root-cause check; `symptom` =
   * everything else (NOT a proof that it's a downstream effect — just "not on
   * the root-cause list"). The precise causal claim lives in `downstream_of`.
   */
  tier: 'root' | 'symptom';
  /**
   * Set ONLY for a known causal edge whose root is also failing. Absent
   * otherwise — we never invent causality from co-occurrence.
   */
  downstream_of?: string;
  /** One-line fix. Prefers `details.fix_hint`; falls back to the check message. */
  fix: string;
}

/**
 * Checks that, when failing, are usually the DISEASE. Sorted to the top so the
 * operator reads the cause first. Membership is ORDERING ONLY (CODEX #9).
 */
export const ROOT_CAUSE_CHECKS: ReadonlySet<string> = new Set([
  'worker_oom_loop',
  'pool_reap_health',
  'connection',
  'sync_freshness',
  'schema_version',
]);

/**
 * Checks that are commonly DOWNSTREAM noise during an incident. Sorted below
 * roots. Ordering only — not a causal claim.
 */
export const SYMPTOM_CHECKS: ReadonlySet<string> = new Set([
  'queue_health',
  'batch_retry_health',
  'supervisor',
  'stale_locks',
]);

/**
 * KNOWN causal edges (symptom → root). `downstream_of` is set ONLY from this
 * map AND ONLY when the named root is itself failing. Each edge is a real,
 * grounded link, not a taxonomy guess:
 *   - queue_health → worker_oom_loop: an RSS-watchdog OOM kill aborts in-flight
 *     jobs; queue_health reads the SAME `error_text='aborted: watchdog'` rows
 *     that worker_oom_loop counts for bare workers.
 *   - supervisor → worker_oom_loop: the watchdog drain is a supervisor
 *     `worker_exited likely_cause=rss_watchdog` — the exact event
 *     worker_oom_loop's supervised half counts.
 */
const DOWNSTREAM_EDGES: Readonly<Record<string, string>> = {
  queue_health: 'worker_oom_loop',
  supervisor: 'worker_oom_loop',
};

function tierOf(name: string): 'root' | 'symptom' {
  return ROOT_CAUSE_CHECKS.has(name) ? 'root' : 'symptom';
}

/**
 * Rank non-ok checks: fail before warn, root before symptom, then name
 * (deterministic). Returns the full ranked list; the renderer caps to top-N.
 */
export function rankIssues(checks: RankableCheck[]): RankedIssue[] {
  const failing = checks.filter((c) => c.status !== 'ok');
  const failingNames = new Set(failing.map((c) => c.name));

  const issues: RankedIssue[] = failing.map((c) => {
    const root = DOWNSTREAM_EDGES[c.name];
    const downstream_of = root && failingNames.has(root) ? root : undefined;
    const hint = c.details?.fix_hint;
    const fix =
      typeof hint === 'string' && hint.trim().length > 0 ? hint : c.message;
    return {
      name: c.name,
      status: c.status as 'warn' | 'fail',
      tier: tierOf(c.name),
      ...(downstream_of ? { downstream_of } : {}),
      fix,
    };
  });

  const statusRank = (s: string): number => (s === 'fail' ? 0 : 1);
  const tierRank = (t: string): number => (t === 'root' ? 0 : 1);
  issues.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      tierRank(a.tier) - tierRank(b.tier) ||
      a.name.localeCompare(b.name),
  );
  return issues;
}

/** Every name referenced by the cause graph (tiers). Drift-guard target (4A). */
export const CAUSE_GRAPH_NAMES: ReadonlySet<string> = new Set([
  ...ROOT_CAUSE_CHECKS,
  ...SYMPTOM_CHECKS,
]);

/** Union of all category-known check names — the drift-guard comparison set. */
export function allKnownCheckNames(): ReadonlySet<string> {
  return new Set<string>([
    ...BRAIN_CHECK_NAMES,
    ...SKILL_CHECK_NAMES,
    ...OPS_CHECK_NAMES,
    ...META_CHECK_NAMES,
  ]);
}
