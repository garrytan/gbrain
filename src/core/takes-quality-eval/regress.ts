/**
 * takes-quality-eval/regress — compare a fresh run vs a prior receipt.
 *
 * Use case: after changing the takes extraction prompt, run a fresh eval
 * and compare against the last known-good receipt. If overall_score or any
 * dim mean dropped past a threshold, exit 1 → CI gate fails the change.
 *
 * The current run reuses the same corpus_sha8 / prompt_sha8 / models_sha8
 * / rubric_sha8 as the prior receipt to keep the comparison apples-to-apples.
 * If they differ, regress reports the inputs are dissimilar (informational
 * — caller decides whether to treat as a failure).
 */
import type { TakesQualityReceipt } from './receipt.ts';
import type { RubricDimension } from './rubric.ts';
import { RUBRIC_DIMENSIONS } from './rubric.ts';

export interface RegressionDelta {
  /** Per-dim mean delta (current − prior). Negative = regression. */
  dim_deltas: Partial<Record<RubricDimension, number>>;
  /** Overall score delta (current − prior). Negative = regression. */
  overall_delta: number;
  /** True when any dim regressed past `threshold`. */
  regressed: boolean;
  /** Threshold below which a dim drop counts as regression. Default 0.5. */
  threshold: number;
  /** Human-readable summary line. */
  summary: string;
  /** True if any 4-sha component differs between current and prior. */
  inputs_differ: boolean;
  /** Specific 4-sha diffs when inputs_differ. */
  input_diffs?: string[];
}

export interface RegressOpts {
  /** Per-dim mean drop threshold counting as regression. Default 0.5. */
  threshold?: number;
}

export function compareReceipts(
  current: TakesQualityReceipt,
  prior: TakesQualityReceipt,
  opts: RegressOpts = {},
): RegressionDelta {
  const threshold = opts.threshold ?? 0.5;

  const inputDiffs: string[] = [];
  if (current.corpus.corpus_sha8 !== prior.corpus.corpus_sha8) {
    inputDiffs.push(`corpus_sha8 differs (${prior.corpus.corpus_sha8} → ${current.corpus.corpus_sha8})`);
  }
  if (current.prompt_sha8 !== prior.prompt_sha8) {
    inputDiffs.push(`prompt_sha8 differs (${prior.prompt_sha8} → ${current.prompt_sha8})`);
  }
  if (current.models_sha8 !== prior.models_sha8) {
    inputDiffs.push(`models_sha8 differs (${prior.models_sha8} → ${current.models_sha8})`);
  }
  if (current.rubric_sha8 !== prior.rubric_sha8) {
    inputDiffs.push(`rubric_sha8 differs (${prior.rubric_sha8} → ${current.rubric_sha8})`);
  }
  const inputs_differ = inputDiffs.length > 0;

  const dim_deltas: Partial<Record<RubricDimension, number>> = {};
  let regressed = false;
  for (const dim of RUBRIC_DIMENSIONS) {
    const cur = current.scores[dim]?.mean;
    const pri = prior.scores[dim]?.mean;
    if (cur === undefined || pri === undefined) continue;
    const delta = round1(cur - pri);
    dim_deltas[dim] = delta;
    if (delta < -threshold) regressed = true;
  }

  const overall_delta = round1((current.overall_score ?? 0) - (prior.overall_score ?? 0));
  if (overall_delta < -threshold) regressed = true;

  const failingDims = Object.entries(dim_deltas)
    .filter(([, d]) => (d ?? 0) < -threshold)
    .map(([k, d]) => `${k}=${d}`);
  const summary = regressed
    ? `REGRESSION: overall ${overall_delta >= 0 ? '+' : ''}${overall_delta}` +
      (failingDims.length > 0 ? `; failing dims: ${failingDims.join(', ')}` : '')
    : `OK: overall ${overall_delta >= 0 ? '+' : ''}${overall_delta} (no dim regressed past ${threshold})`;

  return {
    dim_deltas,
    overall_delta,
    regressed,
    threshold,
    summary,
    inputs_differ,
    input_diffs: inputs_differ ? inputDiffs : undefined,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
