/**
 * Ranker wave, Phase E2 (Cat 13 conceptual recall) — pure pins for
 * arm-confidence.ts, its composition through fusion-lists.ts, and the
 * `keyword_arm_confidence_floor` knob plane (bundle, config parse, resolution
 * chain, knobs hash `kacf=`, registry).
 *
 * The measured defect (Voyage space, reranker off, autocut off): hybrid nDCG@5
 * 53.0 on the held-out concepts vs bare vector 60.5 — the keyword arm's noise
 * on paraphrase probes drags the fused result below the vector arm. The ONE
 * pre-registered mechanism: when the keyword arm's scale-free margin ratio
 * `top / (top + second)` is below the floor, the keyword AND title lists fuse
 * at weight 0.5. Every bundle lands with the floor OFF (null).
 */

import { describe, expect, test } from 'bun:test';
import {
  KEYWORD_ARM_CONFIDENCE_FLOOR_MAX,
  KEYWORD_ARM_WEAK_WEIGHT,
  decideKeywordArmWeight,
  keywordArmConfidence,
  normalizeKeywordArmConfidenceFloor,
  type KeywordArmConfidenceDecision,
} from '../../src/core/search/arm-confidence.ts';
import { composeFusionLists, pushVectorList, type VectorArm } from '../../src/core/search/fusion-lists.ts';
import {
  MODE_BUNDLES,
  SEARCH_MODES,
  SEARCH_MODE_CONFIG_KEYS,
  attributeKnob,
  knobsHash,
  loadOverridesFromConfig,
  resolveSearchMode,
  type ResolvedSearchKnobs,
} from '../../src/core/search/mode.ts';
import { KNOB_DESCRIPTIONS, KNOB_NULL_LABELS, formatKnobValue } from '../../src/core/search/modes-report.ts';
import { KNOWN_CONFIG_KEYS } from '../../src/core/config.ts';
import { rrfFusionWeighted } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(slug: string, score: number, chunk_id = 1): SearchResult {
  return {
    slug,
    page_id: 1,
    title: slug,
    type: 'note',
    chunk_text: `${slug} body`,
    chunk_source: 'timeline',
    chunk_id,
    chunk_index: 0,
    score,
    stale: false,
  } as SearchResult;
}

const KS = { vectorK: 60, textRrfK: 50, imageRrfK: 75, keywordK: 66, baseRrfK: 60 };

describe('keywordArmConfidence — scale-free margin ratio over the returned rows', () => {
  test('empty arm → margin 0, top 0', () => {
    expect(keywordArmConfidence([])).toEqual({ margin_ratio: 0, top_score: 0 });
  });

  test('a single row is uncontested → margin 1, top = its score', () => {
    expect(keywordArmConfidence([row('a', 0.31)])).toEqual({ margin_ratio: 1, top_score: 0.31 });
  });

  test('two rows: top / (top + second); an exact tie is 0.5', () => {
    expect(keywordArmConfidence([row('a', 0.2), row('b', 0.2)]).margin_ratio).toBeCloseTo(0.5, 12);
    const c = keywordArmConfidence([row('a', 0.3), row('b', 0.1)]);
    expect(c.margin_ratio).toBeCloseTo(0.75, 12);
    expect(c.top_score).toBe(0.3);
  });

  test('order-independent: takes the two LARGEST scores, not positions 0/1', () => {
    const asc = keywordArmConfidence([row('c', 0.05), row('b', 0.1), row('a', 0.3)]);
    const desc = keywordArmConfidence([row('a', 0.3), row('b', 0.1), row('c', 0.05)]);
    expect(asc).toEqual(desc);
    expect(asc.margin_ratio).toBeCloseTo(0.75, 12);
  });

  test('scale invariance: multiplying every score by a constant leaves the margin unchanged', () => {
    const base = [row('a', 0.3), row('b', 0.1), row('c', 0.02)];
    const scaled = base.map((r) => ({ ...r, score: r.score * 1000 }));
    expect(keywordArmConfidence(scaled).margin_ratio).toBeCloseTo(keywordArmConfidence(base).margin_ratio, 12);
    expect(keywordArmConfidence(scaled).top_score).toBeCloseTo(300, 9);
  });

  test('non-finite / non-positive scores count as 0 evidence', () => {
    expect(keywordArmConfidence([row('a', 0)]).margin_ratio).toBe(0);
    expect(keywordArmConfidence([row('a', Number.NaN), row('b', -1)]).margin_ratio).toBe(0);
    // A real top over a zero second is uncontested.
    expect(keywordArmConfidence([row('a', 0.2), row('b', 0)]).margin_ratio).toBe(1);
    expect(keywordArmConfidence([row('a', 0.2), row('b', Number.POSITIVE_INFINITY)]).margin_ratio).toBe(1);
  });

  test('margin lives in [0, 1]', () => {
    for (const rows of [[], [row('a', 1)], [row('a', 1), row('b', 1)], [row('a', 5), row('b', 1), row('c', 4)]]) {
      const m = keywordArmConfidence(rows).margin_ratio;
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
  });
});

describe('normalizeKeywordArmConfidenceFloor — the ONE range contract for keyword_arm_confidence_floor', () => {
  test('finite numbers in (0, 1] pass through (boundary 1 inclusive)', () => {
    expect(normalizeKeywordArmConfidenceFloor(0.6)).toBe(0.6);
    expect(normalizeKeywordArmConfidenceFloor(1)).toBe(1);
    expect(normalizeKeywordArmConfidenceFloor(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    expect(KEYWORD_ARM_CONFIDENCE_FLOOR_MAX).toBe(1);
  });

  test('null / false and the literals off / null / false → null (knob off)', () => {
    expect(normalizeKeywordArmConfidenceFloor(null)).toBeNull();
    expect(normalizeKeywordArmConfidenceFloor(false)).toBeNull();
    expect(normalizeKeywordArmConfidenceFloor('off')).toBeNull();
    expect(normalizeKeywordArmConfidenceFloor(' OFF ')).toBeNull();
    expect(normalizeKeywordArmConfidenceFloor('null')).toBeNull();
    expect(normalizeKeywordArmConfidenceFloor('false')).toBeNull();
  });

  test('numeric strings parse (config-key plane); garbage does not', () => {
    expect(normalizeKeywordArmConfidenceFloor('0.6')).toBe(0.6);
    expect(normalizeKeywordArmConfidenceFloor(' 1 ')).toBe(1);
    expect(normalizeKeywordArmConfidenceFloor('')).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor('   ')).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor('x')).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor('0.6abc')).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor('NaN')).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor('Infinity')).toBeUndefined();
  });

  test('out-of-range / non-finite / wrong-typed → undefined (unset: fall through)', () => {
    expect(normalizeKeywordArmConfidenceFloor(0)).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor(-0)).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor(-0.5)).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor(1.0001)).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor(2)).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor(Number.NaN)).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor(undefined)).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor(true)).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor({})).toBeUndefined();
    expect(normalizeKeywordArmConfidenceFloor([0.6])).toBeUndefined();
  });
});

describe('decideKeywordArmWeight — the weight decision', () => {
  const weak = [row('d1', 0.2), row('d2', 0.2)]; // margin 0.5
  const strong = [row('d1', 0.9)]; // margin 1
  const base = { vectorArmVoted: true, relationalQuery: false };

  test('floor null → weight undefined (no key emitted), decision still carries the margin', () => {
    const r = decideKeywordArmWeight({ keywordList: weak, floor: null, ...base });
    expect(r.weight).toBeUndefined();
    expect(r.decision).toEqual({ margin_ratio: 0.5, top_score: 0.2, downweighted: false });
  });

  test('floor set + weak arm + vector voted + non-relational → weight 0.5', () => {
    const r = decideKeywordArmWeight({ keywordList: weak, floor: 0.6, ...base });
    expect(r.weight).toBe(KEYWORD_ARM_WEAK_WEIGHT);
    expect(r.weight).toBe(0.5);
    expect(r.decision.downweighted).toBe(true);
  });

  test('strong arm → unchanged', () => {
    const r = decideKeywordArmWeight({ keywordList: strong, floor: 0.6, ...base });
    expect(r.weight).toBeUndefined();
    expect(r.decision).toEqual({ margin_ratio: 1, top_score: 0.9, downweighted: false });
  });

  test('relational query → unchanged even when weak', () => {
    const r = decideKeywordArmWeight({ keywordList: weak, floor: 0.6, vectorArmVoted: true, relationalQuery: true });
    expect(r.weight).toBeUndefined();
    expect(r.decision.downweighted).toBe(false);
  });

  test('no vector vote (keyword-only fallback shape) → unchanged even when weak', () => {
    const r = decideKeywordArmWeight({ keywordList: weak, floor: 0.6, vectorArmVoted: false, relationalQuery: false });
    expect(r.weight).toBeUndefined();
    expect(r.decision.downweighted).toBe(false);
  });

  test('empty keyword arm → never down-weighted (nothing to demote)', () => {
    const r = decideKeywordArmWeight({ keywordList: [], floor: 0.6, ...base });
    expect(r.weight).toBeUndefined();
    expect(r.decision).toEqual({ margin_ratio: 0, top_score: 0, downweighted: false });
  });

  test('the comparison is strict: margin == floor is NOT weak; floor 1 demotes every contested arm', () => {
    expect(decideKeywordArmWeight({ keywordList: weak, floor: 0.5, ...base }).weight).toBeUndefined();
    expect(decideKeywordArmWeight({ keywordList: weak, floor: 0.500001, ...base }).weight).toBe(0.5);
    expect(decideKeywordArmWeight({ keywordList: [row('a', 0.9), row('b', 0.01)], floor: 1, ...base }).weight).toBe(0.5);
    expect(decideKeywordArmWeight({ keywordList: strong, floor: 1, ...base }).weight).toBeUndefined();
  });
});

describe('composeFusionLists — arm-confidence weighting of the keyword + title entries', () => {
  const gold = row('notes/gold', 0, 1);
  const d1 = row('notes/decoy-1', 0.2, 2);
  const d2 = row('notes/decoy-2', 0.2, 3);
  const rel = row('people/investor', 0, 4);

  function arms(): VectorArm[] {
    const a: VectorArm[] = [];
    pushVectorList(a, [gold], 'original');
    return a;
  }

  function compose(over: {
    floor?: number | null;
    arms?: VectorArm[];
    keyword?: SearchResult[];
    relationalQuery?: boolean;
    onDecision?: (d: KeywordArmConfidenceDecision) => void;
  } = {}) {
    return composeFusionLists({
      arms: over.arms ?? arms(),
      keywordFusionList: over.keyword ?? [d1, d2],
      titleFusionList: [d1, d2],
      relationalList: [rel],
      includeRelational: true,
      relationalQuery: over.relationalQuery,
      onKeywordArmConfidence: over.onDecision,
      ks: KS,
      knobs: { expansionVariantBudget: null, keywordArmConfidenceFloor: over.floor },
    });
  }

  test('floor null / unset → byte-identical entries: no `weight` key anywhere', () => {
    for (const floor of [null, undefined]) {
      const lists = compose({ floor });
      expect(lists).toEqual([
        { list: [gold], k: KS.vectorK },
        { list: [d1, d2], k: KS.keywordK },
        { list: [d1, d2], k: KS.keywordK },
        { list: [rel], k: KS.baseRrfK },
      ]);
      for (const e of lists) expect(e).not.toHaveProperty('weight');
    }
  });

  test('floor 0.6 + weak arm → keyword AND title entries weight 0.5; vector + relational untouched', () => {
    let decision: KeywordArmConfidenceDecision | undefined;
    const lists = compose({ floor: 0.6, onDecision: (d) => { decision = d; } });
    expect(lists).toEqual([
      { list: [gold], k: KS.vectorK },
      { list: [d1, d2], k: KS.keywordK, weight: 0.5 },
      { list: [d1, d2], k: KS.keywordK, weight: 0.5 },
      { list: [rel], k: KS.baseRrfK },
    ]);
    expect(lists[0]).not.toHaveProperty('weight');
    expect(lists[3]).not.toHaveProperty('weight');
    expect(decision).toEqual({ margin_ratio: 0.5, top_score: 0.2, downweighted: true });
  });

  test('strong arm (single keyword row) → unchanged; callback reports downweighted false', () => {
    let decision: KeywordArmConfidenceDecision | undefined;
    const lists = compose({ floor: 0.6, keyword: [d1], onDecision: (d) => { decision = d; } });
    expect(lists[1]).toEqual({ list: [d1], k: KS.keywordK });
    expect(lists[2]).toEqual({ list: [d1, d2], k: KS.keywordK });
    expect(decision).toEqual({ margin_ratio: 1, top_score: 0.2, downweighted: false });
  });

  test('relational query → unchanged (the relational arm owns that shape)', () => {
    let decision: KeywordArmConfidenceDecision | undefined;
    const lists = compose({ floor: 0.6, relationalQuery: true, onDecision: (d) => { decision = d; } });
    expect(lists).toEqual(compose({ floor: null }));
    expect(decision?.downweighted).toBe(false);
    expect(decision?.margin_ratio).toBe(0.5);
  });

  test('no text vector vote (keyword-only fallback shape / image-only arm) → unchanged', () => {
    const empty: VectorArm[] = [];
    pushVectorList(empty, [], 'original');
    expect(compose({ floor: 0.6, arms: empty })).toEqual(compose({ floor: null, arms: empty }));
    const imageOnly: VectorArm[] = [];
    pushVectorList(imageOnly, [gold], 'image');
    expect(compose({ floor: 0.6, arms: imageOnly })).toEqual(compose({ floor: null, arms: imageOnly }));
    // ...but a surviving expansion VARIANT is a real text vote.
    const variantOnly: VectorArm[] = [];
    pushVectorList(variantOnly, [], 'original');
    pushVectorList(variantOnly, [gold], 'variant');
    expect(compose({ floor: 0.6, arms: variantOnly })[2]).toEqual({ list: [d1, d2], k: KS.keywordK, weight: 0.5 });
  });

  test('empty keyword list → unchanged; the empty title list is still omitted', () => {
    const lists = composeFusionLists({
      arms: arms(),
      keywordFusionList: [],
      titleFusionList: [],
      relationalList: [],
      includeRelational: true,
      ks: KS,
      knobs: { expansionVariantBudget: null, keywordArmConfidenceFloor: 0.6 },
    });
    expect(lists).toEqual([{ list: [gold], k: KS.vectorK }, { list: [], k: KS.keywordK }]);
  });

  test('the callback fires exactly once per composition, even with the knob off; a throwing callback never breaks fusion', () => {
    let fired = 0;
    compose({ floor: null, onDecision: () => { fired++; } });
    compose({ floor: 0.6, onDecision: () => { fired++; } });
    expect(fired).toBe(2);
    expect(() => compose({ floor: 0.6, onDecision: () => { throw new Error('boom'); } })).not.toThrow();
  });

  test('end-to-end RRF: floor off → the lexical decoy wins top-1; floor 0.6 → gold wins (k 60 vec / 66 lexical)', () => {
    const off = rrfFusionWeighted(compose({ floor: null }), false);
    expect(off[0].slug).toBe('notes/decoy-1');
    const on = rrfFusionWeighted(compose({ floor: 0.6 }), false);
    expect(on[0].slug).toBe('notes/gold');
    // Decoy kept its votes at half weight: 0.5/66 + 0.5/66 < 1/60.
    const decoy = on.find((r) => r.slug === 'notes/decoy-1')!;
    expect(decoy.score).toBeLessThan(on[0].score);
  });
});

describe('keyword_arm_confidence_floor knob plane (bundle, parse, chain, hash, registry)', () => {
  test('every bundle lands at null (behavior-preserving; the Phase E2 receipt decides the flip)', () => {
    for (const m of SEARCH_MODES) {
      expect(MODE_BUNDLES[m].keyword_arm_confidence_floor).toBeNull();
    }
  });

  test('loadOverridesFromConfig: (0, 1] and the off/null literals parse; everything else falls through', () => {
    const via = (v: string) => loadOverridesFromConfig({ 'search.keyword_arm_confidence_floor': v });
    expect(via('0.6').keyword_arm_confidence_floor).toBe(0.6);
    expect(via('1').keyword_arm_confidence_floor).toBe(1);
    expect(via('off').keyword_arm_confidence_floor).toBeNull();
    expect(via('OFF').keyword_arm_confidence_floor).toBeNull();
    expect(via('null').keyword_arm_confidence_floor).toBeNull();
    expect(via('false').keyword_arm_confidence_floor).toBeNull();
    for (const bad of ['0', '1.5', '-1', 'x', '', 'NaN', 'Infinity', '0.6abc']) {
      expect(via(bad)).not.toHaveProperty('keyword_arm_confidence_floor');
    }
    expect(loadOverridesFromConfig({})).not.toHaveProperty('keyword_arm_confidence_floor');
  });

  test('the config parser IS the normalizer (one range contract, two seams)', () => {
    for (const v of ['0.6', '1', '0', '1.5', '-1', 'NaN', '', 'x', 'off', 'null', 'false', 'OFF']) {
      const expected = normalizeKeywordArmConfidenceFloor(v);
      const parsed = loadOverridesFromConfig({ 'search.keyword_arm_confidence_floor': v });
      if (expected === undefined) expect(parsed).not.toHaveProperty('keyword_arm_confidence_floor');
      else expect(parsed.keyword_arm_confidence_floor).toBe(expected as number | null);
    }
  });

  test('resolution chain: per-call > config override > bundle; a null override is honored, not skipped', () => {
    expect(resolveSearchMode({ mode: 'balanced' }).keyword_arm_confidence_floor).toBeNull();
    expect(resolveSearchMode({ mode: 'balanced', overrides: { keyword_arm_confidence_floor: 0.6 } }).keyword_arm_confidence_floor).toBe(0.6);
    expect(
      resolveSearchMode({ mode: 'balanced', overrides: { keyword_arm_confidence_floor: 0.6 }, perCall: { keyword_arm_confidence_floor: 0.3 } })
        .keyword_arm_confidence_floor,
    ).toBe(0.3);
    expect(
      resolveSearchMode({ mode: 'balanced', overrides: { keyword_arm_confidence_floor: 0.6 }, perCall: { keyword_arm_confidence_floor: null } })
        .keyword_arm_confidence_floor,
    ).toBeNull();
    const input = { mode: 'balanced', overrides: { keyword_arm_confidence_floor: null } } as const;
    expect(attributeKnob('keyword_arm_confidence_floor', input, resolveSearchMode(input)).source).toBe('override');
    // An out-of-range config value resolves to the bundle (null).
    expect(
      resolveSearchMode({ mode: 'balanced', overrides: loadOverridesFromConfig({ 'search.keyword_arm_confidence_floor': '1.5' }) })
        .keyword_arm_confidence_floor,
    ).toBeNull();
  });

  test('an invalid per-call value normalized to undefined falls through and hashes as off (never kacf=NaN)', () => {
    const off = resolveSearchMode({ mode: 'balanced' });
    for (const bad of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const r = resolveSearchMode({ mode: 'balanced', perCall: { keyword_arm_confidence_floor: normalizeKeywordArmConfidenceFloor(bad) } });
      expect(r.keyword_arm_confidence_floor).toBeNull();
      expect(knobsHash(r)).toBe(knobsHash(off));
    }
    const r = resolveSearchMode({
      mode: 'balanced',
      overrides: { keyword_arm_confidence_floor: 0.6 },
      perCall: { keyword_arm_confidence_floor: normalizeKeywordArmConfidenceFloor(Number.NaN) },
    });
    expect(r.keyword_arm_confidence_floor).toBe(0.6);
  });

  test('knobsHash folds the floor (kacf=): off vs 0.6 vs 0.5 all differ; null is stable; a partial literal hashes as off', () => {
    const base = resolveSearchMode({ mode: 'balanced' });
    const off = knobsHash(base);
    const offExplicit = knobsHash({ ...base, keyword_arm_confidence_floor: null });
    const six = knobsHash({ ...base, keyword_arm_confidence_floor: 0.6 });
    const five = knobsHash({ ...base, keyword_arm_confidence_floor: 0.5 });
    expect(off).toBe(offExplicit);
    expect(new Set([off, six, five]).size).toBe(3);
    const { keyword_arm_confidence_floor: _drop, ...partial } = base;
    expect(knobsHash(partial as ResolvedSearchKnobs)).toBe(off);
    // Same-value floors hash identically (toFixed(3) is the canonical form).
    expect(knobsHash({ ...base, keyword_arm_confidence_floor: 0.6 })).toBe(six);
  });

  test('registered everywhere the knob plane needs it (reset key, config registry, dashboard row + null label)', () => {
    expect(SEARCH_MODE_CONFIG_KEYS).toContain('search.keyword_arm_confidence_floor');
    expect(KNOWN_CONFIG_KEYS).toContain('search.keyword_arm_confidence_floor');
    expect(typeof KNOB_DESCRIPTIONS.keyword_arm_confidence_floor).toBe('string');
    expect(KNOB_NULL_LABELS.keyword_arm_confidence_floor).toBe('off (null)');
    expect(formatKnobValue('keyword_arm_confidence_floor', null)).toBe('off (null)');
    expect(formatKnobValue('keyword_arm_confidence_floor', 0.6)).toBe('0.6');
  });
});
