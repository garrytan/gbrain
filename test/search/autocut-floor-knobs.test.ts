/**
 * Autocut weak-top floor — knobsHash + config-parse edges the re-land's own
 * tests don't pin (ship-audit gap fill):
 *
 *  - `acmts=` default agreement: a knobs object that OMITS
 *    autocut_min_top_score must hash identically to an explicit 0.5 — the
 *    `?? 0.5` in knobsHash mirrors DEFAULT_AUTOCUT and applyAutocut's own
 *    `?? 0.5`, so a partial-knobs caller computes the same trimmed set the
 *    cache key claims (compute/cache agreement).
 *  - The documented 4-decimal precision: floors that differ in the 4th
 *    decimal (0.5001 vs 0.5004) must NOT collide, while differences beyond
 *    toFixed(4) (0.50001 vs 0.50004) intentionally DO collide.
 *  - loadOverridesFromConfig ignores NEGATIVE and non-numeric values (the
 *    committed test covers 1.5 but not -1 / garbage), and accepts the 1.0
 *    ceiling boundary.
 */
import { describe, expect, test } from 'bun:test';
import {
  knobsHash,
  loadOverridesFromConfig,
  resolveSearchMode,
  type ResolvedSearchKnobs,
} from '../../src/core/search/mode.ts';

describe('knobsHash acmts= — default + precision (weak-top floor)', () => {
  test('omitting autocut_min_top_score hashes the same as explicit 0.5 (?? 0.5 compute/cache agreement)', () => {
    const full = resolveSearchMode({ mode: 'balanced' }); // bundle floor 0.5
    const { autocut_min_top_score: _omit, ...rest } = full as unknown as Record<string, unknown>;
    expect(_omit).toBe(0.5);
    expect(knobsHash(rest as unknown as ResolvedSearchKnobs)).toBe(knobsHash(full));
  });

  test('floors differing in the 4th decimal produce DIFFERENT hashes (documented .toFixed(4) precision)', () => {
    const a = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { autocut_min_top_score: 0.5001 } }));
    const b = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { autocut_min_top_score: 0.5004 } }));
    expect(a).not.toBe(b);
  });

  test('differences beyond 4 decimals collide by design (toFixed(4) boundary pin)', () => {
    const a = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { autocut_min_top_score: 0.50001 } }));
    const b = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { autocut_min_top_score: 0.50004 } }));
    expect(a).toBe(b);
  });
});

describe('loadOverridesFromConfig search.autocut_min_top_score — out-of-range edges', () => {
  test('negative + non-numeric ignored (fall through to bundle); ceiling boundary 1 accepted', () => {
    // The committed test covers 1.5 (positive overflow); these are the arms it missed.
    expect(loadOverridesFromConfig({ 'search.autocut_min_top_score': '-1' }).autocut_min_top_score).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.autocut_min_top_score': '-0.01' }).autocut_min_top_score).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.autocut_min_top_score': 'abc' }).autocut_min_top_score).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.autocut_min_top_score': '' }).autocut_min_top_score).toBeUndefined();
    expect(loadOverridesFromConfig({ 'search.autocut_min_top_score': '1' }).autocut_min_top_score).toBe(1);
  });
});
