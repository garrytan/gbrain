/**
 * takes-quality-eval/aggregate — verdict logic for one cycle.
 *
 * Adapted from src/core/cross-modal-eval/aggregate.ts with one key
 * tightening (codex review #5): a model's contribution is dropped from
 * the verdict if it omits any of the 5 declared rubric dimensions. The
 * old `union of whatever-parsed dimensions` rule let a model omit a dim
 * and still PASS. For a regression gate, missing-dim → contributes-nothing
 * is the correct default.
 *
 * Pass criterion:
 *   - At least 2 of 3 model calls succeeded with parseable AND complete
 *     scores (all 5 declared dims present).
 *   - Every declared dim's mean across contributing models is >= 7.
 *   - Every declared dim's min across contributing models is >= 5.
 *
 * Inconclusive: fewer than 2 contributing models. Empty-scores PASS bug
 * from cross-modal-eval v1 stays guarded — the same successful-count
 * threshold logic applies, just over the stricter set.
 */

import type { ParsedModelResult } from '../eval-shared/json-repair.ts';
import {
  RUBRIC_DIMENSIONS,
  PASS_MEAN_THRESHOLD,
  PASS_FLOOR_THRESHOLD,
  MIN_SUCCESSES_FOR_VERDICT,
  type RubricDimension,
} from './rubric.ts';

export type SlotResult =
  | { ok: true; modelId: string; parsed: ParsedModelResult }
  | { ok: false; modelId: string; error: string };

export interface AggregateInput {
  slots: SlotResult[];
}

export interface DimensionRoll {
  mean: number;
  min: number;
  max: number;
  scores: number[];
  per_model: Record<string, number>;
  failReason?: 'mean_below_7' | 'min_below_5';
}

export interface AggregateResult {
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** Slots that returned parseable AND complete (all 5 dims) scores. */
  successes: number;
  /** Slots that errored or returned incomplete scores. */
  failures: number;
  dimensions: Record<RubricDimension, DimensionRoll> | Record<string, never>;
  overall: number | undefined;
  topImprovements: string[];
  errors: Array<{ modelId: string; error: string }>;
  verdictMessage: string;
}

const TOP_IMPROVEMENTS_CAP = 10;
const DEDUP_PREFIX_LEN = 40;

/**
 * Returns true iff `parsed.scores` contains a finite number for every
 * declared rubric dimension. Codex review #5: missing-dim disqualifies
 * the contribution.
 */
function hasAllRequiredDims(parsed: ParsedModelResult): boolean {
  for (const dim of RUBRIC_DIMENSIONS) {
    const entry = parsed.scores[dim];
    if (!entry || !Number.isFinite(entry.score)) return false;
  }
  return true;
}

export function aggregate(input: AggregateInput): AggregateResult {
  // Partition slots into contributing (parseable AND complete) vs. failed.
  const contributing: Array<Extract<SlotResult, { ok: true }>> = [];
  const failed: Array<{ modelId: string; error: string }> = [];

  for (const s of input.slots) {
    if (!s.ok) {
      failed.push({ modelId: s.modelId, error: s.error });
      continue;
    }
    if (!hasAllRequiredDims(s.parsed)) {
      const missing = RUBRIC_DIMENSIONS.filter(d => {
        const e = s.parsed.scores[d];
        return !e || !Number.isFinite(e.score);
      });
      failed.push({
        modelId: s.modelId,
        error: `incomplete_scores: missing dim(s) [${missing.join(', ')}]`,
      });
      continue;
    }
    contributing.push(s);
  }

  if (contributing.length < MIN_SUCCESSES_FOR_VERDICT) {
    return {
      verdict: 'inconclusive',
      successes: contributing.length,
      failures: failed.length,
      dimensions: {},
      overall: undefined,
      topImprovements: [],
      errors: failed,
      verdictMessage:
        `INCONCLUSIVE: only ${contributing.length} of ${input.slots.length} models returned ` +
        `complete scores (need >=${MIN_SUCCESSES_FOR_VERDICT}). See receipt for per-slot errors.`,
    };
  }

  // Roll up per declared dimension.
  const dimensions = {} as Record<RubricDimension, DimensionRoll>;
  for (const dim of RUBRIC_DIMENSIONS) {
    const scores: number[] = [];
    const perModel: Record<string, number> = {};
    for (const s of contributing) {
      const score = s.parsed.scores[dim].score;
      scores.push(score);
      perModel[s.modelId] = score;
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const roll: DimensionRoll = {
      mean: round1(mean),
      min,
      max,
      scores,
      per_model: perModel,
    };
    if (roll.mean < PASS_MEAN_THRESHOLD) roll.failReason = 'mean_below_7';
    else if (roll.min < PASS_FLOOR_THRESHOLD) roll.failReason = 'min_below_5';
    dimensions[dim] = roll;
  }

  const dimRolls = Object.values(dimensions);
  const overall = round1(dimRolls.reduce((a, b) => a + b.mean, 0) / dimRolls.length);
  const allDimsPass = dimRolls.every(d => !d.failReason);
  const verdict: 'pass' | 'fail' = allDimsPass ? 'pass' : 'fail';

  const topImprovements = dedupImprovements(
    contributing.flatMap(s => s.parsed.improvements),
  ).slice(0, TOP_IMPROVEMENTS_CAP);

  const verdictMessage =
    verdict === 'pass'
      ? `PASS: every dim mean >=${PASS_MEAN_THRESHOLD} and min >=${PASS_FLOOR_THRESHOLD} ` +
        `across ${contributing.length}/${input.slots.length} models. Overall ${overall}/10.`
      : describeFailure(dimensions, contributing.length, input.slots.length, overall);

  return {
    verdict,
    successes: contributing.length,
    failures: failed.length,
    dimensions,
    overall,
    topImprovements,
    errors: failed,
    verdictMessage,
  };
}

function describeFailure(
  dimensions: Record<RubricDimension, DimensionRoll>,
  successes: number,
  total: number,
  overall: number,
): string {
  const failedDims = (Object.entries(dimensions) as Array<[RubricDimension, DimensionRoll]>).filter(
    ([, d]) => d.failReason,
  );
  if (failedDims.length === 0) {
    return `FAIL: aggregate failure with no dimension flagged.`;
  }
  const reasons = failedDims
    .map(([name, d]) => {
      if (d.failReason === 'mean_below_7') return `${name} mean=${d.mean} (<${PASS_MEAN_THRESHOLD})`;
      return `${name} min=${d.min} (<${PASS_FLOOR_THRESHOLD}; scores=[${d.scores.join(', ')}])`;
    })
    .join('; ');
  return `FAIL across ${successes}/${total} models. Overall ${overall}/10. Failing: ${reasons}.`;
}

function dedupImprovements(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.slice(0, DEDUP_PREFIX_LEN).toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
