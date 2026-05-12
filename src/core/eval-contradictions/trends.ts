/**
 * eval-contradictions/trends — M5 time-series helpers.
 *
 * Thin orchestration over engine.writeContradictionsRun + loadContradictionsTrend.
 * Render helpers produce the plain-text chart for `gbrain eval
 * suspected-contradictions trend`. Pure data structures — no LLM or filesystem.
 */

import type { BrainEngine } from '../engine.ts';
import type { ProbeReport, SourceTierBreakdown } from './types.ts';
export type { ProbeReport, SourceTierBreakdown } from './types.ts';

export interface TrendRow {
  run_id: string;
  ran_at: string;
  judge_model: string;
  queries_evaluated: number;
  queries_with_contradiction: number;
  total_contradictions_flagged: number;
  wilson_ci_lower: number;
  wilson_ci_upper: number;
  judge_errors_total: number;
  cost_usd_total: number;
  duration_ms: number;
  source_tier_breakdown: SourceTierBreakdown;
  /** Full ProbeReport blob; consumed by `review` sub-subcommand. */
  report_json: ProbeReport;
}

/** Write one row per run. Returns true iff inserted (idempotent on run_id). */
export async function writeRunRow(
  engine: BrainEngine,
  report: ProbeReport,
  durationMs: number,
): Promise<boolean> {
  return engine.writeContradictionsRun({
    run_id: report.run_id,
    judge_model: report.judge_model,
    prompt_version: report.prompt_version,
    queries_evaluated: report.queries_evaluated,
    queries_with_contradiction: report.queries_with_contradiction,
    total_contradictions_flagged: report.total_contradictions_flagged,
    wilson_ci_lower: report.calibration.wilson_ci_95.lower,
    wilson_ci_upper: report.calibration.wilson_ci_95.upper,
    judge_errors_total: report.judge_errors.total,
    cost_usd_total: report.cost_usd.total,
    duration_ms: durationMs,
    source_tier_breakdown: report.source_tier_breakdown as unknown as Record<string, unknown>,
    report_json: report as unknown as Record<string, unknown>,
  });
}

/** Load the last N days of runs, newest first. */
export async function loadTrend(engine: BrainEngine, days: number): Promise<TrendRow[]> {
  const rows = await engine.loadContradictionsTrend(days);
  return rows.map((r) => ({
    run_id: r.run_id,
    ran_at: r.ran_at,
    judge_model: r.judge_model,
    queries_evaluated: r.queries_evaluated,
    queries_with_contradiction: r.queries_with_contradiction,
    total_contradictions_flagged: r.total_contradictions_flagged,
    wilson_ci_lower: r.wilson_ci_lower,
    wilson_ci_upper: r.wilson_ci_upper,
    judge_errors_total: r.judge_errors_total,
    cost_usd_total: r.cost_usd_total,
    duration_ms: r.duration_ms,
    source_tier_breakdown: (r.source_tier_breakdown ?? { curated_vs_curated: 0, curated_vs_bulk: 0, bulk_vs_bulk: 0, other: 0 }) as unknown as SourceTierBreakdown,
    report_json: r.report_json as unknown as ProbeReport,
  }));
}

/**
 * Plain-text chart. ~10 columns wide; each row shows the run, headline pct,
 * Wilson CI bounds, and a simple ASCII bar of `total_flagged` against a
 * 0..max scale.
 */
export function renderTrendChart(rows: readonly TrendRow[]): string {
  if (rows.length === 0) {
    return 'No contradiction-probe runs in this window. Run `gbrain eval suspected-contradictions` to populate.';
  }
  const max = Math.max(1, ...rows.map((r) => r.total_contradictions_flagged));
  const barWidth = 30;
  const lines: string[] = [];
  lines.push('Date         Model               Q  WithCx  Flag  CI95           Bar');
  lines.push('-----------  ------------------  -  ------  ----  -------------  ' + '-'.repeat(barWidth));
  for (const r of rows) {
    const date = r.ran_at.slice(0, 10);
    const model = r.judge_model.split(':').pop()!.slice(0, 18).padEnd(18);
    const q = String(r.queries_evaluated).padStart(2);
    const withCx = String(r.queries_with_contradiction).padStart(6);
    const flag = String(r.total_contradictions_flagged).padStart(4);
    const ci = `${(r.wilson_ci_lower * 100).toFixed(0).padStart(2)}-${(r.wilson_ci_upper * 100).toFixed(0).padStart(2)}%`.padEnd(13);
    const fill = Math.round((r.total_contradictions_flagged / max) * barWidth);
    const bar = '#'.repeat(fill) + '.'.repeat(barWidth - fill);
    lines.push(`${date}   ${model}  ${q}  ${withCx}  ${flag}  ${ci}  ${bar}`);
  }
  return lines.join('\n');
}
