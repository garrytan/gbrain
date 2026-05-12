/**
 * v0.30.0 (Slice A1): pure helpers for the resolution + scorecard layer.
 * Shared between Postgres + PGLite engines so the math + the (quality, outcome)
 * derivation are identical across backends.
 */

import { GBrainError } from './types.ts';
import type { TakeResolution, TakesScorecard } from './engine.ts';

/**
 * Derive the (quality, outcome) tuple that gets written to the takes row.
 * `quality` wins when both are set. Returns the tuple ready for an UPDATE.
 *
 * Throws TAKE_RESOLUTION_INVALID when neither field is set, or when the input
 * combines fields that the schema CHECK constraint would reject (e.g.
 * quality='partial' + outcome=true).
 *
 * The schema `takes_resolution_consistency` CHECK is defense-in-depth — this
 * function is the first line, surfacing a clear CLI-friendly error before
 * the row hits the DB.
 */
export function deriveResolutionTuple(
  resolution: TakeResolution,
): { quality: 'correct' | 'incorrect' | 'partial'; outcome: boolean | null } {
  const { quality, outcome } = resolution;
  if (quality === undefined && outcome === undefined) {
    throw new GBrainError(
      'TAKE_RESOLUTION_INVALID',
      'resolveTake: must pass either `quality` (correct|incorrect|partial) or `outcome` (true|false)',
      'use --quality on the CLI; --outcome is the back-compat alias and cannot express partial',
    );
  }
  if (quality !== undefined) {
    // Optional cross-check: when caller passed BOTH and they're inconsistent,
    // surface the contradiction loudly instead of silently overwriting.
    if (outcome !== undefined) {
      const expected = quality === 'correct' ? true : quality === 'incorrect' ? false : null;
      if (expected !== outcome) {
        throw new GBrainError(
          'TAKE_RESOLUTION_INVALID',
          `resolveTake: --quality=${quality} contradicts --outcome=${outcome}`,
          'pass only one of --quality or --outcome; they cannot disagree',
        );
      }
    }
    return {
      quality,
      outcome: quality === 'correct' ? true : quality === 'incorrect' ? false : null,
    };
  }
  // Back-compat path: only `outcome` was supplied (v0.28 callers).
  return {
    quality: outcome ? 'correct' : 'incorrect',
    outcome: outcome ?? null,
  };
}

/** Raw aggregate row shape returned by both engines' getScorecard SQL. */
export interface ScorecardRowRaw {
  total_bets: number;
  resolved: number;
  correct: number;
  incorrect: number;
  partial: number;
  brier: number | null;
}

/**
 * Finalize a scorecard from the raw aggregate row. Computes accuracy +
 * partial_rate; returns NULL for empty windows so CLI can render
 * "no resolved bets yet" instead of NaN. Brier comes straight from SQL.
 *
 * Brier scope (D5 + D11): `partial` rows are excluded from the Brier
 * denominator entirely because partial isn't a binary outcome. The
 * `partial_rate` field surfaces hedging behavior as a separate signal so
 * users see both the calibration math AND whether they're hedging into
 * the unmeasured bucket.
 */
export function finalizeScorecard(raw: ScorecardRowRaw): TakesScorecard {
  const correct = Number(raw.correct ?? 0);
  const incorrect = Number(raw.incorrect ?? 0);
  const partial = Number(raw.partial ?? 0);
  const resolved = Number(raw.resolved ?? 0);
  const totalBets = Number(raw.total_bets ?? 0);
  const binary = correct + incorrect;
  return {
    total_bets: totalBets,
    resolved,
    correct,
    incorrect,
    partial,
    accuracy: binary > 0 ? correct / binary : null,
    brier: binary > 0 && raw.brier !== null && raw.brier !== undefined
      ? Number(raw.brier)
      : null,
    partial_rate: resolved > 0 ? partial / resolved : null,
  };
}

/**
 * Threshold above which scorecard CLI emits a warning that calibration may
 * be optimistic (D11). 20% partial means 1 in 5 bets escaped the Brier
 * denominator — the user is hedging into the unmeasured bucket.
 */
export const PARTIAL_RATE_WARNING_THRESHOLD = 0.20;
