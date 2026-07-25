/**
 * v0.42.3.0 — autocut pure-function tests.
 *
 * Pins the score-discontinuity algorithm + the resolve ladder. No engine,
 * no network — applyAutocut takes a list + a scoreOf accessor.
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_AUTOCUT,
  autocutFromConfig,
  resolveAutocut,
  applyAutocut,
  type AutocutConfig,
} from '../../src/core/search/autocut.ts';

// A tiny result shape: just a score and an id so we can assert which
// items survived the cut.
type R = { id: string; rs?: number };
const scoreOf = (r: R) => r.rs;
const ON: AutocutConfig = { enabled: true, jumpRatio: 0.2, minKeep: 1 };

function mk(scores: Array<number | undefined>): R[] {
  return scores.map((rs, i) => ({ id: `r${i}`, rs }));
}

describe('DEFAULT_AUTOCUT', () => {
  test('module default is enabled with 0.20 jump + minKeep 1', () => {
    expect(DEFAULT_AUTOCUT.enabled).toBe(true);
    expect(DEFAULT_AUTOCUT.jumpRatio).toBe(0.2);
    expect(DEFAULT_AUTOCUT.minKeep).toBe(1);
  });
  test('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_AUTOCUT)).toBe(true);
  });
});

describe('applyAutocut — cuts on a real cliff', () => {
  test('clear cliff after rank 2 → keeps 2', () => {
    // 1.0, 0.944, 0.222, 0.111 → biggest gap 0.85→0.2 (0.722) clears 0.20.
    const r = applyAutocut(mk([0.9, 0.85, 0.2, 0.1]), scoreOf, ON);
    expect(r.kept.map((x) => x.id)).toEqual(['r0', 'r1']);
    expect(r.decision.applied).toBe(true);
    expect(r.decision.signal).toBe('rerank');
    expect(r.decision.kept).toBe(2);
    expect(r.decision.total).toBe(4);
    expect(r.decision.gapRatio).toBeGreaterThan(0.2);
  });

  test('cliff after rank 1 → keeps the single obvious answer', () => {
    const r = applyAutocut(mk([0.95, 0.1, 0.08, 0.05]), scoreOf, ON);
    expect(r.kept.map((x) => x.id)).toEqual(['r0']);
    expect(r.decision.applied).toBe(true);
  });

  test('preserves original order among kept items (robust to unsorted input)', () => {
    // Provider returned them out of order; autocut finds the cliff on a
    // sorted copy and keeps items >= threshold IN INPUT ORDER.
    const items = mk([0.85, 0.95, 0.12, 0.9]); // sorted desc: .95 .9 .85 .12
    const r = applyAutocut(items, scoreOf, ON);
    // Cliff is between .85 and .12 → threshold .85 → keep .85,.95,.9 → r0,r1,r3.
    expect(r.kept.map((x) => x.id)).toEqual(['r0', 'r1', 'r3']);
  });
});

describe('applyAutocut — declines to cut', () => {
  test('flat scores (no cliff) → returns all, signal none', () => {
    const r = applyAutocut(mk([0.9, 0.88, 0.86, 0.84]), scoreOf, ON);
    expect(r.kept.length).toBe(4);
    expect(r.decision.applied).toBe(false);
    expect(r.decision.signal).toBe('none');
  });

  test('all-equal scores → no cut', () => {
    const r = applyAutocut(mk([0.7, 0.7, 0.7, 0.7]), scoreOf, ON);
    expect(r.kept.length).toBe(4);
    expect(r.decision.applied).toBe(false);
  });

  test('the measured-RRF-flat case: rank1≈rank2 gap → no cut', () => {
    // Mirrors return-policy.ts's documented finding: a ~identical top gap is
    // NOT a separatrix. With these (correct vs wrong) shapes autocut stays out.
    const correct = applyAutocut(mk([0.602, 0.569, 0.55, 0.54]), scoreOf, ON);
    const wrong = applyAutocut(mk([0.569, 0.55, 0.54, 0.53]), scoreOf, ON);
    expect(correct.decision.applied).toBe(false);
    expect(wrong.decision.applied).toBe(false);
  });
});

describe('applyAutocut — no-op guards', () => {
  test('disabled → returns input unchanged', () => {
    const items = mk([0.9, 0.1]);
    const r = applyAutocut(items, scoreOf, { ...ON, enabled: false });
    expect(r.kept).toBe(items);
    expect(r.decision.applied).toBe(false);
  });

  test('empty input → no-op', () => {
    const r = applyAutocut([] as R[], scoreOf, ON);
    expect(r.kept).toEqual([]);
    expect(r.decision.applied).toBe(false);
  });

  test('single item → no-op (no cliff possible)', () => {
    const items = mk([0.9]);
    const r = applyAutocut(items, scoreOf, ON);
    expect(r.kept.length).toBe(1);
    expect(r.decision.applied).toBe(false);
  });

  test('<2 finite scores → no-op (fail-open reranker: no scores stamped)', () => {
    // All un-scored (reranker failed open → RRF order, no rerank_score).
    const items = mk([undefined, undefined, undefined]);
    const r = applyAutocut(items, scoreOf, ON);
    expect(r.kept.length).toBe(3);
    expect(r.decision.signal).toBe('none');
  });

  test('exactly 1 finite score among many → no-op', () => {
    const items = mk([0.9, undefined, undefined]);
    const r = applyAutocut(items, scoreOf, ON);
    expect(r.kept.length).toBe(3);
    expect(r.decision.applied).toBe(false);
  });

  test('top score <= 0 → no-op (score scale unusable)', () => {
    const r = applyAutocut(mk([0, -0.1, -0.5]), scoreOf, ON);
    expect(r.decision.applied).toBe(false);
  });

  test('non-finite scores are ignored', () => {
    const items = mk([0.9, Number.NaN, 0.1]);
    const r = applyAutocut(items, scoreOf, ON);
    // Only 0.9 and 0.1 are finite → 2 scored, cliff → keep r0; NaN item dropped.
    expect(r.kept.map((x) => x.id)).toEqual(['r0']);
  });
});

describe('applyAutocut — failsafe', () => {
  test('never returns empty when input is non-empty', () => {
    const r = applyAutocut(mk([0.9, 0.01]), scoreOf, ON);
    expect(r.kept.length).toBeGreaterThanOrEqual(1);
  });

  test('minKeep floor holds even with a cliff after rank 1', () => {
    // Cliff says keep 1, but minKeep=2 expands to 2.
    const r = applyAutocut(mk([0.95, 0.1, 0.08]), scoreOf, { ...ON, minKeep: 2 });
    expect(r.kept.length).toBeGreaterThanOrEqual(2);
  });

  test('higher jumpRatio means only dramatic cliffs cut', () => {
    const scores = mk([0.9, 0.6, 0.5, 0.4]); // top gap normalized ~0.33
    const lenient = applyAutocut(scores, scoreOf, { ...ON, jumpRatio: 0.2 });
    const strict = applyAutocut(scores, scoreOf, { ...ON, jumpRatio: 0.5 });
    expect(lenient.decision.applied).toBe(true);
    expect(strict.decision.applied).toBe(false);
  });
});

describe('applyAutocut — preserve predicate (Codex P1: alias-injected matches)', () => {
  // An alias-hop exact match is injected AFTER reranking, so it has no score.
  type AR = { id: string; rs?: number; alias?: boolean };
  const arScore = (r: AR) => r.rs;
  const isAlias = (r: AR) => r.alias === true;

  test('unscored alias item survives a cut that drops scored noise', () => {
    const items: AR[] = [
      { id: 'alias', alias: true }, // injected, no rerank_score
      { id: 'top', rs: 0.95 },
      { id: 'noise1', rs: 0.2 },
      { id: 'noise2', rs: 0.1 },
    ];
    const r = applyAutocut(items, arScore, ON, isAlias);
    // Cliff after 'top' drops noise1/noise2; 'alias' is preserved despite no score.
    expect(r.kept.map((x) => x.id).sort()).toEqual(['alias', 'top']);
    expect(r.decision.applied).toBe(true);
  });

  test('without the predicate, the unscored alias item is dropped on a cut', () => {
    const items: AR[] = [
      { id: 'alias', alias: true },
      { id: 'top', rs: 0.95 },
      { id: 'noise', rs: 0.1 },
    ];
    const r = applyAutocut(items, arScore, ON); // no preserve
    expect(r.kept.map((x) => x.id)).toEqual(['top']);
  });

  test('preserve does not force a cut on a flat curve (no-op still returns all)', () => {
    const items: AR[] = [
      { id: 'alias', alias: true },
      { id: 'a', rs: 0.6 },
      { id: 'b', rs: 0.58 },
    ];
    const r = applyAutocut(items, arScore, ON, isAlias);
    expect(r.decision.applied).toBe(false);
    expect(r.kept.length).toBe(3);
  });
});

describe('autocutFromConfig', () => {
  test('reads search.autocut + search.autocut_jump', () => {
    const out = autocutFromConfig({ search: { autocut: false, autocut_jump: 0.4 } });
    expect(out.enabled).toBe(false);
    expect(out.jumpRatio).toBe(0.4);
  });
  test('clamps out-of-range jump to fallback (ignored)', () => {
    expect(autocutFromConfig({ search: { autocut_jump: 5 } }).jumpRatio).toBeUndefined();
    expect(autocutFromConfig({ search: { autocut_jump: 0 } }).jumpRatio).toBeUndefined();
  });
  test('empty / missing config → empty partial', () => {
    expect(autocutFromConfig(null)).toEqual({});
    expect(autocutFromConfig({})).toEqual({});
  });
});

describe('resolveAutocut — precedence ladder', () => {
  test('defaults → config → per-call', () => {
    const cfg = resolveAutocut(undefined, { jumpRatio: 0.3 });
    expect(cfg.jumpRatio).toBe(0.3);
    expect(cfg.enabled).toBe(true); // default
  });
  test('per-call true/false overrides config enabled', () => {
    expect(resolveAutocut(false, { enabled: true }).enabled).toBe(false);
    expect(resolveAutocut(true, { enabled: false }).enabled).toBe(true);
  });
  test('per-call partial overrides specific fields', () => {
    const cfg = resolveAutocut({ jumpRatio: 0.5 }, { jumpRatio: 0.3, enabled: false });
    expect(cfg.jumpRatio).toBe(0.5);
    expect(cfg.enabled).toBe(false); // inherited from config (partial didn't set it)
  });
});
