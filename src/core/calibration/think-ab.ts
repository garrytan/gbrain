/**
 * v0.36.1.0 (T18 / D19) — A/B harness for `gbrain think`.
 *
 * Each invocation runs think TWICE on the same question: once baseline,
 * once --with-calibration. Both answers are written to the database in
 * a single think_ab_results row along with the user's preference. After
 * 30 days of data, `gbrain calibration ab-report` aggregates win/loss
 * and surfaces calibration_net_negative when the with-calibration variant
 * loses >55% of trials (n >= 20).
 *
 * The harness is the structural answer to CDX-18 (anti-bias rewrite may
 * make advice worse): we don't have to guess whether calibration helps;
 * we measure.
 *
 * v0.36.1.0 ship state:
 *   - The data PIPELINE is real (schema, write, aggregate).
 *   - The user-facing PROMPT ("which did you prefer?") is interactive on
 *     the CLI. Tests inject a non-interactive answer resolver so the
 *     pipeline runs hermetically.
 *   - The runThink calls are real engine calls; tests can stub by
 *     passing thinkRunner injection.
 */

import type { BrainEngine } from '../engine.ts';

export interface ABRunInput {
  question: string;
  /** Holder context for calibration. Default 'garry'. */
  holder?: string;
  /** Engine for DB write. */
  engine: BrainEngine;
  /** Source for the row. */
  sourceId: string;
  /** Inject for tests; production runs the real `runThink` twice. */
  thinkRunner?: (opts: { question: string; withCalibration: boolean }) => Promise<{ answer: string; modelUsed?: string }>;
  /** Inject for tests; production prompts the user via stdin. */
  preferenceResolver?: (opts: { baseline: string; withCalibration: string }) => Promise<'baseline' | 'with_calibration' | 'neither' | 'tie'>;
  /** Optional notes from the user. */
  notes?: string;
}

export interface ABRunResult {
  baselineAnswer: string;
  withCalibrationAnswer: string;
  preferred: 'baseline' | 'with_calibration' | 'neither' | 'tie';
  modelUsed?: string | undefined;
  rowId?: number;
}

/**
 * Run one A/B trial. Calls thinkRunner twice (or stubs), gets the
 * preference, writes the row.
 */
export async function runAbTrial(input: ABRunInput): Promise<ABRunResult> {
  if (!input.thinkRunner) {
    throw new Error('runAbTrial: thinkRunner not provided (production wiring lives in src/commands/think.ts)');
  }
  if (!input.preferenceResolver) {
    throw new Error('runAbTrial: preferenceResolver not provided');
  }

  const baseline = await input.thinkRunner({ question: input.question, withCalibration: false });
  const withCal = await input.thinkRunner({ question: input.question, withCalibration: true });
  const preferred = await input.preferenceResolver({
    baseline: baseline.answer,
    withCalibration: withCal.answer,
  });
  const rows = await input.engine.executeRaw<{ id: number }>(
    `INSERT INTO think_ab_results
       (source_id, question, baseline_answer, with_calibration_answer, preferred, model_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.sourceId,
      input.question,
      baseline.answer,
      withCal.answer,
      preferred,
      baseline.modelUsed ?? withCal.modelUsed ?? null,
      input.notes ?? null,
    ],
  );
  return {
    baselineAnswer: baseline.answer,
    withCalibrationAnswer: withCal.answer,
    preferred,
    modelUsed: baseline.modelUsed ?? withCal.modelUsed,
    ...(rows[0]?.id !== undefined ? { rowId: rows[0]!.id } : {}),
  };
}

export interface AbReportResult {
  total_trials: number;
  baseline_wins: number;
  with_calibration_wins: number;
  ties: number;
  neither: number;
  /** Win rate for --with-calibration as a fraction of decisive trials (excludes neither/tie). */
  with_calibration_win_rate: number | null;
  /** When true, the doctor surface flags calibration_net_negative. */
  net_negative: boolean;
  /** Threshold tests applied. */
  decisive_trials: number;
}

/**
 * Read the table + compute the win/loss breakdown over the last N days.
 * Pure aggregation over the row set.
 */
export async function buildAbReport(
  engine: BrainEngine,
  opts: { days?: number } = {},
): Promise<AbReportResult> {
  const days = opts.days ?? 30;
  const rows = await engine.executeRaw<{ preferred: string; count: number }>(
    `SELECT preferred, COUNT(*)::int AS count
       FROM think_ab_results
       WHERE ran_at >= now() - INTERVAL '${days} days'
       GROUP BY preferred`,
  );
  const counts = { baseline: 0, with_calibration: 0, tie: 0, neither: 0 };
  for (const r of rows) {
    if (r.preferred === 'baseline') counts.baseline = r.count;
    else if (r.preferred === 'with_calibration') counts.with_calibration = r.count;
    else if (r.preferred === 'tie') counts.tie = r.count;
    else if (r.preferred === 'neither') counts.neither = r.count;
  }
  const total = counts.baseline + counts.with_calibration + counts.tie + counts.neither;
  const decisive = counts.baseline + counts.with_calibration;
  const winRate = decisive > 0 ? counts.with_calibration / decisive : null;
  // calibration_net_negative threshold (D19): with-calibration loses
  // >55% of decisive trials over a sample of n >= 20.
  const netNegative = decisive >= 20 && winRate !== null && winRate < 0.45;
  return {
    total_trials: total,
    baseline_wins: counts.baseline,
    with_calibration_wins: counts.with_calibration,
    ties: counts.tie,
    neither: counts.neither,
    with_calibration_win_rate: winRate,
    net_negative: netNegative,
    decisive_trials: decisive,
  };
}

/** Human-format the report. */
export function formatAbReport(report: AbReportResult, days: number): string {
  const lines: string[] = [];
  lines.push(`A/B report (last ${days} days):`);
  lines.push(`  Total trials: ${report.total_trials}`);
  if (report.total_trials === 0) {
    lines.push('  No data yet. Try: gbrain think --ab "<question>"');
    return lines.join('\n');
  }
  lines.push(`  Baseline wins:           ${report.baseline_wins}`);
  lines.push(`  With-calibration wins:   ${report.with_calibration_wins}`);
  lines.push(`  Ties:                    ${report.ties}`);
  lines.push(`  Neither:                 ${report.neither}`);
  if (report.with_calibration_win_rate !== null) {
    const pct = (report.with_calibration_win_rate * 100).toFixed(1);
    lines.push(`  With-calibration win rate (decisive trials only): ${pct}% (n=${report.decisive_trials})`);
  }
  if (report.net_negative) {
    lines.push('');
    lines.push('⚠ calibration_net_negative: with-calibration is losing more than half of decisive trials.');
    lines.push('  Consider tuning the anti-bias prompt rewrite (src/core/think/prompt.ts) or');
    lines.push('  disabling --with-calibration via config until you tune.');
  }
  return lines.join('\n');
}
