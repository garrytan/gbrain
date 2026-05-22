/**
 * v0.30.0 (Slice A1): tests for the pure resolution + scorecard helpers.
 * Covers the (quality, outcome) tuple derivation and the Brier math
 * including the partial-exclusion contract (D5 + D11).
 */

import { describe, test, expect } from 'bun:test';
import {
  deriveResolutionTuple,
  finalizeScorecard,
  PARTIAL_RATE_WARNING_THRESHOLD,
} from '../src/core/takes-resolution.ts';
import { GBrainError } from '../src/core/types.ts';

describe('deriveResolutionTuple', () => {
  test('quality=correct → (correct, true)', () => {
    expect(deriveResolutionTuple({ quality: 'correct', resolvedBy: 'garry' })).toEqual({
      quality: 'correct',
      outcome: true,
    });
  });

  test('quality=incorrect → (incorrect, false)', () => {
    expect(deriveResolutionTuple({ quality: 'incorrect', resolvedBy: 'garry' })).toEqual({
      quality: 'incorrect',
      outcome: false,
    });
  });

  test('quality=partial → (partial, null)', () => {
    expect(deriveResolutionTuple({ quality: 'partial', resolvedBy: 'garry' })).toEqual({
      quality: 'partial',
      outcome: null,
    });
  });

  test('outcome=true (back-compat alias) → (correct, true)', () => {
    expect(deriveResolutionTuple({ outcome: true, resolvedBy: 'garry' })).toEqual({
      quality: 'correct',
      outcome: true,
    });
  });

  test('outcome=false (back-compat alias) → (incorrect, false)', () => {
    expect(deriveResolutionTuple({ outcome: false, resolvedBy: 'garry' })).toEqual({
      quality: 'incorrect',
      outcome: false,
    });
  });

  test('quality wins when both inputs supplied AND consistent', () => {
    // outcome=true is consistent with quality=correct; quality wins.
    expect(deriveResolutionTuple({ quality: 'correct', outcome: true, resolvedBy: 'garry' })).toEqual({
      quality: 'correct',
      outcome: true,
    });
  });

  test('contradictory quality + outcome throws TAKE_RESOLUTION_INVALID', () => {
    expect(() =>
      deriveResolutionTuple({ quality: 'correct', outcome: false, resolvedBy: 'garry' })
    ).toThrow(GBrainError);
    expect(() =>
      deriveResolutionTuple({ quality: 'partial', outcome: true, resolvedBy: 'garry' })
    ).toThrow(GBrainError);
  });

  test('neither field set throws TAKE_RESOLUTION_INVALID', () => {
    expect(() =>
      deriveResolutionTuple({ resolvedBy: 'garry' })
    ).toThrow(GBrainError);
  });

  // v0.36.1.1 R1-class: 'unresolvable' joins partial as null-outcome.
  test('R1: quality=unresolvable → (unresolvable, null)', () => {
    expect(deriveResolutionTuple({ quality: 'unresolvable', resolvedBy: 'garry' })).toEqual({
      quality: 'unresolvable',
      outcome: null,
    });
  });

  test('R4-helper: unresolvable + outcome=true is contradictory (throws)', () => {
    // Defense-in-depth: deriveResolutionTuple rejects contradictory inputs
    // before the schema CHECK fires. unresolvable requires null outcome —
    // same shape as partial.
    expect(() =>
      deriveResolutionTuple({ quality: 'unresolvable', outcome: true, resolvedBy: 'garry' })
    ).toThrow(GBrainError);
    expect(() =>
      deriveResolutionTuple({ quality: 'unresolvable', outcome: false, resolvedBy: 'garry' })
    ).toThrow(GBrainError);
  });
});

describe('finalizeScorecard (Brier math)', () => {
  test('n=0: returns nulls, no divide-by-zero', () => {
    const card = finalizeScorecard({
      total_bets: 0, resolved: 0, correct: 0, incorrect: 0, partial: 0, brier: null,
    });
    expect(card).toEqual({
      total_bets: 0,
      resolved: 0,
      correct: 0,
      incorrect: 0,
      partial: 0,
      accuracy: null,
      brier: null,
      partial_rate: null,
      unresolvable_count: 0,
      unresolvable_rate: null,
    });
  });

  test('all correct: accuracy=1, Brier reflects mean (weight - 1)^2', () => {
    // 3 correct bets at weight 0.7. Per-row Brier = (0.7 - 1)^2 = 0.09.
    // Mean = 0.09. Accuracy = 3/3 = 1.0.
    const card = finalizeScorecard({
      total_bets: 3, resolved: 3, correct: 3, incorrect: 0, partial: 0, brier: 0.09,
    });
    expect(card.accuracy).toBe(1.0);
    expect(card.brier).toBeCloseTo(0.09, 5);
    expect(card.partial_rate).toBe(0);
  });

  test('all incorrect: accuracy=0, Brier reflects mean weight^2', () => {
    // 3 incorrect bets at weight 0.7. Per-row Brier = (0.7 - 0)^2 = 0.49.
    const card = finalizeScorecard({
      total_bets: 3, resolved: 3, correct: 0, incorrect: 3, partial: 0, brier: 0.49,
    });
    expect(card.accuracy).toBe(0.0);
    expect(card.brier).toBeCloseTo(0.49, 5);
  });

  test('hand-calculated reference: 4 mixed bets', () => {
    // bets: weight=0.9 correct, weight=0.6 correct, weight=0.7 incorrect, weight=0.4 incorrect
    // Brier per row: (0.9-1)^2=0.01, (0.6-1)^2=0.16, (0.7-0)^2=0.49, (0.4-0)^2=0.16
    // Mean: (0.01+0.16+0.49+0.16)/4 = 0.205
    // Accuracy: 2/4 = 0.5
    const card = finalizeScorecard({
      total_bets: 4, resolved: 4, correct: 2, incorrect: 2, partial: 0, brier: 0.205,
    });
    expect(card.accuracy).toBe(0.5);
    expect(card.brier).toBeCloseTo(0.205, 5);
    expect(card.partial_rate).toBe(0);
  });

  test('D5: partial excluded from Brier denominator; appears in partial_rate', () => {
    // 2 correct, 1 incorrect, 1 partial. Brier reflects only the 3 binary rows
    // (the SQL aggregation passes partial=null per row to AVG, so partial
    // doesn't affect Brier in finalizeScorecard either).
    // partial_rate = 1/4 = 0.25
    const card = finalizeScorecard({
      total_bets: 4, resolved: 4, correct: 2, incorrect: 1, partial: 1, brier: 0.18,
    });
    // accuracy uses correct + incorrect denominator (binary), excluding partial.
    expect(card.accuracy).toBeCloseTo(2 / 3, 5);
    expect(card.partial_rate).toBe(0.25);
    expect(card.brier).toBe(0.18);
  });

  test('D11: partial_rate threshold constant matches plan (20%)', () => {
    expect(PARTIAL_RATE_WARNING_THRESHOLD).toBe(0.20);
  });

  test('all-partial scorecard: Brier null, accuracy null, partial_rate=1', () => {
    const card = finalizeScorecard({
      total_bets: 5, resolved: 5, correct: 0, incorrect: 0, partial: 5, brier: null,
    });
    expect(card.brier).toBeNull();
    expect(card.accuracy).toBeNull();
    expect(card.partial_rate).toBe(1);
  });

  test('partial_rate = 0 when no partial bets', () => {
    const card = finalizeScorecard({
      total_bets: 2, resolved: 2, correct: 1, incorrect: 1, partial: 0, brier: 0.5,
    });
    expect(card.partial_rate).toBe(0);
  });

  // v0.36.1.1 R5 — sibling-field semantics. `resolved` MUST keep the v0.36.1.0
  // 3-state meaning so historical comparisons stay valid; unresolvable rows
  // live in the new sibling fields only.
  test('R5: unresolvable_count + unresolvable_rate populated; resolved/accuracy/partial_rate unchanged', () => {
    // 2 correct, 1 incorrect, 1 partial, 1 unresolvable. resolved=4 (3-state),
    // unresolvable_count=1. unresolvable_rate = 1 / (4 + 1) = 0.2.
    const card = finalizeScorecard({
      total_bets: 5,
      resolved: 4,
      correct: 2,
      incorrect: 1,
      partial: 1,
      brier: 0.2,
      unresolvable_count: 1,
    });
    expect(card.resolved).toBe(4); // 3-state, NOT 5
    expect(card.unresolvable_count).toBe(1);
    expect(card.unresolvable_rate).toBeCloseTo(0.2, 5);
    // accuracy unchanged: correct / (correct + incorrect) = 2/3
    expect(card.accuracy).toBeCloseTo(2 / 3, 5);
    // partial_rate unchanged: partial / resolved (3-state denominator) = 1/4
    expect(card.partial_rate).toBe(0.25);
    // brier unchanged
    expect(card.brier).toBe(0.2);
  });

  test('R5: legacy v0.36.1.0 ScorecardRowRaw (no unresolvable_count) backfills count=0; rate=0 when resolved>0', () => {
    // Engines pre-v0.36.1.1 won't return unresolvable_count in the row. The
    // optional `?` on ScorecardRowRaw + default-0 in finalizeScorecard means
    // existing brains keep working. unresolvable_rate matches partial_rate
    // semantics: 0 when there are resolved rows but no unresolvable ones.
    const card = finalizeScorecard({
      total_bets: 3, resolved: 3, correct: 2, incorrect: 1, partial: 0, brier: 0.18,
    });
    expect(card.unresolvable_count).toBe(0);
    expect(card.unresolvable_rate).toBe(0);
  });

  test('R5: empty brain (resolved=0 AND unresolvable_count=0) → unresolvable_rate=null', () => {
    // Only when BOTH counts are zero do we return null (avoid divide-by-zero
    // and signal "no data" rather than "0% unresolvable on no data").
    const card = finalizeScorecard({
      total_bets: 0, resolved: 0, correct: 0, incorrect: 0, partial: 0, brier: null,
    });
    expect(card.unresolvable_count).toBe(0);
    expect(card.unresolvable_rate).toBeNull();
  });

  test('R5: brain with only unresolvable rows surfaces unresolvable_rate=1.0', () => {
    const card = finalizeScorecard({
      total_bets: 5, resolved: 0, correct: 0, incorrect: 0, partial: 0, brier: null,
      unresolvable_count: 5,
    });
    expect(card.resolved).toBe(0);
    expect(card.unresolvable_count).toBe(5);
    expect(card.unresolvable_rate).toBe(1.0);
    expect(card.accuracy).toBeNull();
    expect(card.brier).toBeNull();
    expect(card.partial_rate).toBeNull(); // resolved is 0 → null per existing contract
  });
});
