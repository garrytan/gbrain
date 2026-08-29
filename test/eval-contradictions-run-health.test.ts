/**
 * #3889 — all-errors probe run must not render as a clean "0 contradictions".
 *
 * Covers the shared honesty predicate (run-health.ts), the doctor check body
 * for the zero-total case, and the CLI summary builder (unknown bucket
 * printed, judge-failed banner + Wilson-CI suppression).
 */

import { describe, test, expect } from 'bun:test';
import {
  assessRunHealth,
  inferVerdictSum,
  isJudgeFailedRun,
  sumVerdicts,
  zeroTotalContradictionsCheck,
} from '../src/core/eval-contradictions/run-health.ts';
import { buildRunSummaryLines } from '../src/commands/eval-suspected-contradictions.ts';
import type { ProbeReport } from '../src/core/eval-contradictions/types.ts';

function mkReport(over: Partial<ProbeReport> = {}): ProbeReport {
  return {
    schema_version: 1,
    run_id: 'r1',
    judge_model: 'anthropic:claude-haiku-4-5',
    prompt_version: '2',
    truncation_policy: '1500-chars-utf8-safe',
    top_k: 5,
    sampling: 'deterministic',
    queries_evaluated: 3,
    queries_with_contradiction: 0,
    queries_with_any_finding: 0,
    total_contradictions_flagged: 0,
    verdict_breakdown: {
      no_contradiction: 0,
      contradiction: 0,
      temporal_supersession: 0,
      temporal_regression: 0,
      temporal_evolution: 0,
      negation_artifact: 0,
    },
    calibration: {
      queries_total: 3,
      queries_judged_clean: 3,
      queries_with_contradiction: 0,
      wilson_ci_95: { point: 0, lower: 0, upper: 0.56 },
    },
    judge_errors: { parse_fail: 0, refusal: 0, timeout: 0, http_5xx: 0, unknown: 0, total: 0, note: 'errors are counted' },
    cost_usd: { judge: 0, embedding: 0, total: 0, estimate_note: 'soft ceiling' },
    cache: { hits: 0, misses: 0, hit_rate: 0 },
    duration_ms: 12,
    source_tier_breakdown: { curated_vs_curated: 0, curated_vs_bulk: 0, bulk_vs_bulk: 0, other: 0 },
    per_query: [],
    hot_pages: [],
    ...over,
  };
}

describe('run-health predicate (#3889)', () => {
  test('isJudgeFailedRun: zero verdicts + errors => failed', () => {
    expect(isJudgeFailedRun(0, 5)).toBe(true);
    expect(isJudgeFailedRun(0, 0)).toBe(false);   // nothing attempted: not failed
    expect(isJudgeFailedRun(3, 5)).toBe(false);   // partial errors: not failed
  });

  test('sumVerdicts tolerates partial/absent breakdowns', () => {
    expect(sumVerdicts(undefined)).toBe(0);
    expect(sumVerdicts(null)).toBe(0);
    expect(sumVerdicts({ contradiction: 2, no_contradiction: 3 })).toBe(5);
  });

  test('inferVerdictSum falls back to per_query pairs on pre-v0.34 rows', () => {
    // Old rows lack verdict_breakdown; pairs_judged + pairs_cache_hit is the
    // same denominator.
    expect(inferVerdictSum({
      per_query: [
        { pairs_judged: 2, pairs_cache_hit: 1 },
        { pairs_judged: 0, pairs_cache_hit: 0 },
      ],
    })).toBe(3);
    expect(inferVerdictSum({})).toBe(0);
    expect(inferVerdictSum(undefined)).toBe(0);
  });

  test('assessRunHealth: all-errors run flags judge_failed with error rate 1', () => {
    const h = assessRunHealth({
      judge_errors_total: 7,
      report_json: { verdict_breakdown: { no_contradiction: 0, contradiction: 0 } },
    });
    expect(h.judge_failed).toBe(true);
    expect(h.error_rate).toBe(1);
  });

  test('assessRunHealth: partial errors do NOT flag judge_failed', () => {
    const h = assessRunHealth({
      judge_errors_total: 1,
      report_json: { verdict_breakdown: { no_contradiction: 9, contradiction: 0 } },
    });
    expect(h.judge_failed).toBe(false);
    expect(h.error_rate).toBeCloseTo(0.1);
  });
});

describe('doctor zero-total check body (#3889)', () => {
  test('all-errors run => warn, not ok', () => {
    const check = zeroTotalContradictionsCheck({
      ran_at: '2026-08-20T10:00:00Z',
      queries_evaluated: 5,
      judge_errors_total: 12,
      report_json: { verdict_breakdown: { no_contradiction: 0, contradiction: 0 } },
    });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('not trustworthy');
    expect(check.message).toContain('12');
  });

  test('clean zero-finding run stays ok', () => {
    const check = zeroTotalContradictionsCheck({
      ran_at: '2026-08-20T10:00:00Z',
      queries_evaluated: 5,
      judge_errors_total: 0,
      report_json: { verdict_breakdown: { no_contradiction: 10, contradiction: 0 } },
    });
    expect(check.status).toBe('ok');
    expect(check.message).toContain('no suspected contradictions');
  });

  test('zero-finding run with SOME errors stays ok but reports the error rate', () => {
    const check = zeroTotalContradictionsCheck({
      ran_at: '2026-08-20T10:00:00Z',
      queries_evaluated: 5,
      judge_errors_total: 2,
      report_json: { verdict_breakdown: { no_contradiction: 8, contradiction: 0 } },
    });
    expect(check.status).toBe('ok');
    expect(check.message).toContain('judge errors: 2');
    expect(check.message).toContain('20%');
  });
});

describe('CLI summary builder (#3889)', () => {
  test('judge errors line prints all five buckets (unknown included) so they sum to total', () => {
    const r = mkReport({
      judge_errors: { parse_fail: 1, refusal: 0, timeout: 1, http_5xx: 0, unknown: 2, total: 4, note: 'counted' },
      verdict_breakdown: {
        no_contradiction: 3, contradiction: 0, temporal_supersession: 0,
        temporal_regression: 0, temporal_evolution: 0, negation_artifact: 0,
      },
    });
    const line = buildRunSummaryLines(r, false).find((l) => l.includes('Judge errors:'));
    expect(line).toBeTruthy();
    expect(line).toContain('unknown=2');
    // Buckets sum to total: extract every printed bucket count and compare.
    const buckets = [...line!.matchAll(/(?:parse_fail|refusal|timeout|http_5xx|unknown)=(\d+)/g)]
      .map((m) => Number(m[1]));
    expect(buckets.length).toBe(5);
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(4);
  });

  test('judge_failed run: banner shown, 0/N headline and Wilson CI suppressed', () => {
    const r = mkReport({
      run_status: 'judge_failed',
      judge_errors: { parse_fail: 0, refusal: 0, timeout: 0, http_5xx: 6, unknown: 0, total: 6, note: 'counted' },
    });
    const lines = buildRunSummaryLines(r, false);
    const text = lines.join('\n');
    expect(text).toContain('JUDGE FAILED');
    expect(text).toContain('unknown (judge produced no verdicts)');
    expect(text).not.toContain('Wilson CI');
    expect(text).not.toContain('0 / 3');
  });

  test('ok run keeps the headline + Wilson CI', () => {
    const r = mkReport({ run_status: 'ok' });
    const text = buildRunSummaryLines(r, false).join('\n');
    expect(text).toContain('Queries with >=1 contradiction: 0 / 3');
    expect(text).toContain('Wilson CI 95%');
  });
});
