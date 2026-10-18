/**
 * Keyless check of the W7 forecast-journal gate instrument
 * (evals/forecast-journal/).
 *
 * Protects: the generator's output still hashes to the value
 * PREREGISTRATION.md froze, with the cohort shapes it states and placeholder
 * names only; Spearman ρ (ties at average ranks), set F1 and the median give
 * their textbook values; the decision rule fails on any one criterion.
 * Fails when: someone edits the generator after the freeze, or the
 * statistics drift. It guards the instrument, not the score: the scored run
 * is harness.ts --run.
 * Why new: the gate is new with W7.
 * Seams: none (pure functions; no brain).
 */
import { describe, expect, test } from 'bun:test';
import { checkInstrument } from '../evals/forecast-journal/harness.ts';
import { cohorts, skillOf, whoWasRight, LOW_N } from '../evals/forecast-journal/fixtures.ts';
import { decide, median, setF1, spearman, type GateResult } from '../evals/forecast-journal/score.ts';

describe('forecast-journal gate instrument', () => {
  test('the generator matches the frozen preregistration, with placeholder names only', () => {
    expect(checkInstrument()).toEqual([]);
  });

  test('cohort shape: skills evenly spaced, low-n holders, one overdue and one open each, one undated take', () => {
    const [c] = cohorts();
    expect([skillOf(1), skillOf(12)]).toEqual([0.3, 0.9]);
    expect(c!.holders.filter(h => h.skill === null).map(h => h.resolved)).toEqual([LOW_N, LOW_N]);
    for (const h of c!.holders) {
      const mine = c!.predictions.filter(p => p.holder === h.holder);
      expect(mine.filter(p => p.state === 'overdue')).toHaveLength(1);
      expect(mine.filter(p => p.state === 'open')).toHaveLength(1);
    }
    expect(c!.predictions.filter(p => p.state === 'undated')).toHaveLength(1);
    expect([...whoWasRight(c!).keys()]).toHaveLength(40);
  });

  test('spearman, set F1 and median', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearman([1, 2, 3], [1, 1, 2])).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(setF1(new Set(), new Set())).toBe(1);
    expect(setF1(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(0.5, 12);
    expect(setF1(new Set(['a']), new Set())).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  test('the decision rule fails on any one criterion', () => {
    const ok: GateResult = { rho_shrunk: [0.9], rho_raw: [0.9], median_rho_shrunk: 0.9, median_rho_raw: 0.9, share_rho_shrunk_at_least_min: 1, set_f1_macro: 1,
      denominator_mismatches: [], low_n_mismatches: [], labelling_mismatches: [], remote_probes: [{ probe: 'p', pass: true, detail: '' }] };
    expect(decide(ok)).toEqual({ pass: true, failed: [] });
    expect(decide({ ...ok, median_rho_shrunk: 0.79 }).pass).toBe(false);
    expect(decide({ ...ok, set_f1_macro: 0.94 }).pass).toBe(false);
    expect(decide({ ...ok, denominator_mismatches: ['x'] }).pass).toBe(false);
    expect(decide({ ...ok, low_n_mismatches: ['x'] }).pass).toBe(false);
    expect(decide({ ...ok, labelling_mismatches: ['x'] }).pass).toBe(false);
    expect(decide({ ...ok, remote_probes: [{ probe: 'p', pass: false, detail: '' }] }).pass).toBe(false);
  });
});
