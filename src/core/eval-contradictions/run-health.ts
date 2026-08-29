/**
 * eval-contradictions/run-health — the #3889 honesty predicate.
 *
 * A run whose judge failed on EVERY pair produces a verdict_breakdown that
 * sums to 0 while judge_errors.total > 0. Reporting that run as
 * "0 contradictions" is a lie — no pair was ever scored. This module is the
 * single shared predicate:
 *
 *   - the runner stamps `run_status: 'judge_failed'` on the ProbeReport,
 *   - the CLI suppresses the 0/N headline + Wilson CI and exits 1,
 *   - doctor downgrades the green "no contradictions" check to a warn.
 *
 * Pure functions only — no engine, no I/O — so doctor and the CLI share one
 * definition and the tests are hermetic.
 */

import type { VerdictBreakdown } from './types.ts';

/** Sum every numeric bucket in a (possibly partial/untyped) verdict breakdown. */
export function sumVerdicts(vb: Partial<VerdictBreakdown> | null | undefined): number {
  if (!vb || typeof vb !== 'object') return 0;
  let sum = 0;
  for (const v of Object.values(vb)) {
    if (typeof v === 'number' && Number.isFinite(v)) sum += v;
  }
  return sum;
}

/** True iff the run scored zero pairs while at least one judge call errored. */
export function isJudgeFailedRun(verdictSum: number, judgeErrorsTotal: number): boolean {
  return verdictSum === 0 && judgeErrorsTotal > 0;
}

/**
 * Recover the run's verdict count from a persisted report_json. Prefers the
 * v0.34+ verdict_breakdown; pre-v0.34 rows fall back to per-query
 * pairs_judged + pairs_cache_hit (the same denominator — every judged or
 * cache-served pair produced exactly one verdict).
 */
export function inferVerdictSum(report: Record<string, unknown> | null | undefined): number {
  const vb = report?.verdict_breakdown;
  if (vb && typeof vb === 'object') return sumVerdicts(vb as Partial<VerdictBreakdown>);
  const perQuery = report?.per_query;
  if (Array.isArray(perQuery)) {
    let sum = 0;
    for (const q of perQuery) {
      const row = q as Record<string, unknown> | null;
      if (typeof row?.pairs_judged === 'number') sum += row.pairs_judged;
      if (typeof row?.pairs_cache_hit === 'number') sum += row.pairs_cache_hit;
    }
    return sum;
  }
  return 0;
}

export interface RunHealth {
  judge_failed: boolean;
  verdict_sum: number;
  judge_errors_total: number;
  /** errors / (verdicts + errors); null when the run attempted zero pairs. */
  error_rate: number | null;
}

/** Doctor-side assessment of a persisted eval_contradictions_runs row. */
export function assessRunHealth(row: {
  judge_errors_total?: number | null;
  report_json?: Record<string, unknown> | null;
}): RunHealth {
  const judgeErrorsTotal =
    typeof row.judge_errors_total === 'number' && Number.isFinite(row.judge_errors_total)
      ? row.judge_errors_total
      : 0;
  const verdictSum = inferVerdictSum(row.report_json);
  const attempted = verdictSum + judgeErrorsTotal;
  return {
    judge_failed: isJudgeFailedRun(verdictSum, judgeErrorsTotal),
    verdict_sum: verdictSum,
    judge_errors_total: judgeErrorsTotal,
    error_rate: attempted > 0 ? judgeErrorsTotal / attempted : null,
  };
}

/**
 * Doctor check body for the "zero suspected contradictions" case. Returns a
 * warn (not ok) when the latest run judged nothing but errored — otherwise
 * the honest green message, annotated with the error rate when any judge
 * call failed.
 */
export function zeroTotalContradictionsCheck(latest: {
  ran_at: string;
  queries_evaluated: number;
  judge_errors_total?: number | null;
  report_json?: Record<string, unknown> | null;
}): { status: 'ok' | 'warn'; message: string } {
  const health = assessRunHealth(latest);
  const day = latest.ran_at.slice(0, 10);
  if (health.judge_failed) {
    return {
      status: 'warn',
      message:
        `Latest probe run (${day}) judged ZERO pairs — all ${health.judge_errors_total} judge calls errored. ` +
        `The "0 contradictions" result is not trustworthy. Check the judge model/API key and re-run ` +
        '`gbrain eval suspected-contradictions`.',
    };
  }
  const errNote =
    health.judge_errors_total > 0 && health.error_rate !== null
      ? ` (judge errors: ${health.judge_errors_total}, ${(health.error_rate * 100).toFixed(0)}% of pairs)`
      : '';
  return {
    status: 'ok',
    message: `Latest probe run (${day}) found no suspected contradictions across ${latest.queries_evaluated} queries${errNote}.`,
  };
}
