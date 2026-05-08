/**
 * cross-modal-eval/aggregate — verdict logic for one cycle.
 *
 * Inputs: per-slot results from the 3 frontier models (each either a parsed
 * scores object or a captured error). Output: verdict + dim averages +
 * top improvements + verdict prose.
 *
 * Pass criterion (Q2 + Q3):
 *   - At least 2 of 3 model calls succeeded with parseable scores.
 *   - Every dimension's mean across successful models is >= 7.
 *   - For every dimension, no successful model scored < 5 (the floor).
 *
 * Inconclusive (Q3): fewer than 2 models succeeded.
 *   `Object.values({}).every(...) === true`, so an empty scores map would
 *   silently PASS without this guard. Test 6 in aggregate.test.ts is the
 *   regression guard.
 */

import type { ParsedModelResult } from './json-repair.ts';

export type SlotResult =
  | { ok: true; modelId: string; parsed: ParsedModelResult }
  | { ok: false; modelId: string; error: string };

export interface AggregateInput {
  /** One entry per slot (typically 3). */
  slots: SlotResult[];
}

export interface DimensionRoll {
  /** Mean across successful models. */
  mean: number;
  /** Minimum across successful models (the floor). */
  min: number;
  /** All raw scores from successful models, in slot order. */
  scores: number[];
  /** Pass=false reason if this dim fails. */
  failReason?: 'mean_below_7' | 'min_below_5';
}

export interface AggregateResult {
  /** Verdict: 'pass' | 'fail' | 'inconclusive' (Q3=A). */
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** Number of slots that returned parseable scores. */
  successes: number;
  /** Number of slots that errored or returned unparseable output. */
  failures: number;
  /** Per-dimension roll-up; undefined if inconclusive. */
  dimensions: Record<string, DimensionRoll>;
  /** Mean of dimension means; undefined if inconclusive. */
  overall: number | undefined;
  /** Top 10 deduplicated improvements across all successful models. */
  topImprovements: string[];
  /** Slot-level error notes (carried through to receipt). */
  errors: Array<{ modelId: string; error: string }>;
  /** Human-readable one-liner for stderr / receipt verdict prose. */
  verdictMessage: string;
}

const PASS_MEAN_THRESHOLD = 7;
const PASS_FLOOR_THRESHOLD = 5;
const MIN_SUCCESSES_FOR_VERDICT = 2;
const TOP_IMPROVEMENTS_CAP = 10;
const DEDUP_PREFIX_LEN = 40;

export function aggregate(input: AggregateInput): AggregateResult {
  const successes = input.slots.filter(s => s.ok);
  const failures = input.slots.filter(s => !s.ok) as Array<
    Extract<SlotResult, { ok: false }>
  >;
  const errors = failures.map(f => ({ modelId: f.modelId, error: f.error }));

  if (successes.length < MIN_SUCCESSES_FOR_VERDICT) {
    return {
      verdict: 'inconclusive',
      successes: successes.length,
      failures: failures.length,
      dimensions: {},
      overall: undefined,
      topImprovements: [],
      errors,
      verdictMessage:
        `INCONCLUSIVE: only ${successes.length} of ${input.slots.length} models returned ` +
        `parseable scores (need >=${MIN_SUCCESSES_FOR_VERDICT}). See receipt for per-slot errors.`,
    };
  }

  // Roll up per-dimension across successful slots.
  const dimensions: Record<string, DimensionRoll> = {};
  const allDimNames = new Set<string>();
  for (const s of successes) {
    if (s.ok) {
      for (const dim of Object.keys(s.parsed.scores)) {
        allDimNames.add(dim);
      }
    }
  }
  for (const dim of allDimNames) {
    const scores: number[] = [];
    for (const s of successes) {
      if (s.ok) {
        const entry = s.parsed.scores[dim];
        if (entry && Number.isFinite(entry.score)) scores.push(entry.score);
      }
    }
    if (scores.length === 0) continue;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const min = Math.min(...scores);
    const roll: DimensionRoll = { mean: round1(mean), min, scores };
    if (roll.mean < PASS_MEAN_THRESHOLD) roll.failReason = 'mean_below_7';
    else if (roll.min < PASS_FLOOR_THRESHOLD) roll.failReason = 'min_below_5';
    dimensions[dim] = roll;
  }

  const dimRolls = Object.values(dimensions);
  const overall =
    dimRolls.length > 0
      ? round1(dimRolls.reduce((a, b) => a + b.mean, 0) / dimRolls.length)
      : 0;
  const allDimsPass = dimRolls.every(d => !d.failReason);
  const verdict: 'pass' | 'fail' = allDimsPass ? 'pass' : 'fail';

  const topImprovements = dedupImprovements(
    successes.flatMap(s => (s.ok ? s.parsed.improvements : [])),
  ).slice(0, TOP_IMPROVEMENTS_CAP);

  const verdictMessage =
    verdict === 'pass'
      ? `PASS: every dimension mean >=${PASS_MEAN_THRESHOLD} and min >=${PASS_FLOOR_THRESHOLD} ` +
        `across ${successes.length}/${input.slots.length} models. Overall ${overall}/10.`
      : describeFailure(dimensions, successes.length, input.slots.length, overall);

  return {
    verdict,
    successes: successes.length,
    failures: failures.length,
    dimensions,
    overall,
    topImprovements,
    errors,
    verdictMessage,
  };
}

function describeFailure(
  dimensions: Record<string, DimensionRoll>,
  successes: number,
  total: number,
  overall: number,
): string {
  const failed = Object.entries(dimensions).filter(([, d]) => d.failReason);
  if (failed.length === 0) {
    return `FAIL: aggregate failure with no dimension flagged (likely zero dimensions returned).`;
  }
  const reasons = failed
    .map(([name, d]) => {
      if (d.failReason === 'mean_below_7') {
        return `${name} mean=${d.mean} (<${PASS_MEAN_THRESHOLD})`;
      }
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
