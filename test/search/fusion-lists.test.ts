/**
 * Ranker wave, Phase A — pure pins for fusion-lists.ts + weighted RRF.
 *
 * The measured defect (LongMemEval tokenmax arm 54.9% vs plain hybrid 93.2%
 * recall_all@5): expansion variant lists fused at the SAME k and weight as the
 * original query's list, so two variants agreeing on a distractor outvoted the
 * original's gold. The fix is budget-normalized weighted RRF: variant/clause
 * arms share ONE total weight `expansion_variant_budget`; `null` = legacy.
 *
 * Also pins the role-tagging correction: the old positional mapping ("last
 * list is the image branch") mis-tagged a TEXT variant list as the image when
 * the both-mode image branch fell open but expansion produced ≥ 2 lists.
 */

import { describe, expect, test } from 'bun:test';
import {
  composeFusionLists,
  normalizeExpansionVariantBudget,
  pushVectorList,
  textArmsNonEmpty,
  EXPANSION_VARIANT_BUDGET_MAX,
  type FusionListEntry,
  type VectorArm,
} from '../../src/core/search/fusion-lists.ts';
import { loadOverridesFromConfig, resolveSearchMode, knobsHash } from '../../src/core/search/mode.ts';
import { rrfFusionWeighted, textVectorArmNonEmpty } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(slug: string, chunk_id = 1): SearchResult {
  return {
    slug,
    page_id: 1,
    title: slug,
    type: 'note',
    chunk_text: `${slug} body`,
    chunk_source: 'timeline',
    chunk_id,
    chunk_index: 0,
    score: 0,
    stale: false,
  } as SearchResult;
}

const KS = { vectorK: 60, textRrfK: 50, imageRrfK: 75, keywordK: 66, baseRrfK: 60 };

const gold = row('notes/gold', 1);
const distractor = row('notes/distractor', 2);
const filler = (n: number) => row(`notes/filler-${n}`, 100 + n);

/**
 * Exact fixture: gold in the ORIGINAL at rank 0 only; the distractor at rank
 * 0 in BOTH variants and absent from the original. No lexical arms.
 */
function expansionFixture(): VectorArm[] {
  const arms: VectorArm[] = [];
  pushVectorList(arms, [gold, filler(1), filler(2)], 'original');
  pushVectorList(arms, [distractor, filler(3)], 'variant');
  pushVectorList(arms, [distractor, filler(4)], 'variant');
  return arms;
}

function fuse(arms: VectorArm[], budget: number | null): SearchResult[] {
  const lists = composeFusionLists({
    arms,
    keywordFusionList: [],
    titleFusionList: [],
    relationalList: [],
    includeRelational: true,
    ks: KS,
    knobs: { expansionVariantBudget: budget },
  });
  return rrfFusionWeighted(lists, false);
}

const scoreOf = (rs: SearchResult[], slug: string) => rs.find((r) => r.slug === slug)!.score;

describe('composeFusionLists — expansion variant budget (the 38-point gap)', () => {
  test('null (legacy) and 2.0: two agreeing variants outvote the original → distractor top-1', () => {
    expect(fuse(expansionFixture(), null)[0].slug).toBe('notes/distractor');
    expect(fuse(expansionFixture(), 2.0)[0].slug).toBe('notes/distractor');
  });

  test('2.0 with two variants is legacy exactly (weight 1 each) — identical fused scores', () => {
    const legacy = fuse(expansionFixture(), null).map((r) => [r.slug, r.score]);
    const two = fuse(expansionFixture(), 2.0).map((r) => [r.slug, r.score]);
    expect(two).toEqual(legacy);
  });

  test('0.5 subordinates the variants → gold top-1', () => {
    expect(fuse(expansionFixture(), 0.5)[0].slug).toBe('notes/gold');
  });

  test('1.0 ties two agreeing rank-0 variants against the original rank-0 vote exactly', () => {
    const fused = fuse(expansionFixture(), 1.0);
    expect(scoreOf(fused, 'notes/gold')).toBeCloseTo(scoreOf(fused, 'notes/distractor'), 12);
  });

  test('gold/distractor ratio is strictly increasing across budgets {2.0, 1.0, 0.5, 0.25}', () => {
    const ratios = [2.0, 1.0, 0.5, 0.25].map((b) => {
      const fused = fuse(expansionFixture(), b);
      return scoreOf(fused, 'notes/gold') / scoreOf(fused, 'notes/distractor');
    });
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
    // Arithmetic anchors: b/k total for two rank-0 variants vs 1/k for the
    // original → ratio = 1/b (normalization cancels).
    expect(ratios[0]).toBeCloseTo(0.5, 12);
    expect(ratios[1]).toBeCloseTo(1.0, 12);
    expect(ratios[2]).toBeCloseTo(2.0, 12);
    expect(ratios[3]).toBeCloseTo(4.0, 12);
  });

  test('weight is budget / n over NON-EMPTY variant+clause arms; original keeps weight 1 (no key)', () => {
    const arms: VectorArm[] = [];
    pushVectorList(arms, [gold], 'original');
    pushVectorList(arms, [distractor], 'variant');
    pushVectorList(arms, [], 'variant'); // empty list casts no vote → not counted
    pushVectorList(arms, [distractor], 'clause');
    const lists = composeFusionLists({
      arms, keywordFusionList: [], titleFusionList: [], relationalList: [],
      includeRelational: true, ks: KS, knobs: { expansionVariantBudget: 1.0 },
    });
    expect(lists[0]).toEqual({ list: [gold], k: 60 });
    expect(lists[1]).toEqual({ list: [distractor], k: 60, weight: 0.5 });
    expect(lists[2]).toEqual({ list: [], k: 60 });
    expect(lists[3]).toEqual({ list: [distractor], k: 60, weight: 0.5 });
  });

  test('original missing (its embed or searchVector failed) → survivors are variants sharing the budget', () => {
    const arms: VectorArm[] = [];
    pushVectorList(arms, [distractor, filler(1)], 'variant');
    pushVectorList(arms, [gold, filler(2)], 'variant');
    const lists = composeFusionLists({
      arms, keywordFusionList: [], titleFusionList: [], relationalList: [],
      includeRelational: true, ks: KS, knobs: { expansionVariantBudget: 0.5 },
    });
    expect(lists.filter((l) => l.weight !== undefined).map((l) => l.weight)).toEqual([0.25, 0.25]);
    // No 'original' role anywhere → nothing fuses at weight 1 except the lexical arms.
    expect(lists.slice(0, 2).every((l) => l.k === KS.vectorK)).toBe(true);
  });
});

describe('composeFusionLists — null deep-equals the pre-role allLists mapping', () => {
  const kw = [row('notes/kw', 7)];
  const title = [row('notes/title', 8)];
  const rel = [row('notes/rel', 9)];
  const orig = [gold, filler(1)];
  const v1 = [distractor];
  const v2 = [filler(2)];
  const img = [row('img/photo', 50)];

  test('text mode: every vector list at vectorK, keyword at keywordK, title at keywordK if non-empty, relational at baseRrfK', () => {
    const arms: VectorArm[] = [];
    pushVectorList(arms, orig, 'original');
    pushVectorList(arms, v1, 'variant');
    pushVectorList(arms, v2, 'variant');
    const got = composeFusionLists({
      arms, keywordFusionList: kw, titleFusionList: title, relationalList: rel,
      includeRelational: true, ks: KS, knobs: { expansionVariantBudget: null },
    });
    // Today's mapping, verbatim (hybrid.ts pre-wave):
    //   [...vectorLists.map(list => ({ list, k: vectorK })), { list: keywordFusionList, k: keywordK }]
    //   + title (keywordK) if non-empty + relational (baseRrfK) if non-empty && modality !== 'image'
    const legacy: FusionListEntry[] = [
      ...[orig, v1, v2].map((list) => ({ list, k: KS.vectorK })),
      { list: kw, k: KS.keywordK },
      { list: title, k: KS.keywordK },
      { list: rel, k: KS.baseRrfK },
    ];
    expect(got).toEqual(legacy);
    // No `weight` key anywhere in legacy mode (byte-identical shape).
    expect(got.every((l) => !('weight' in l))).toBe(true);
  });

  test('empty title list and image modality (includeRelational=false) drop their entries, as today', () => {
    const arms: VectorArm[] = [];
    pushVectorList(arms, orig, 'original');
    const got = composeFusionLists({
      arms, keywordFusionList: kw, titleFusionList: [], relationalList: rel,
      includeRelational: false, ks: KS, knobs: { expansionVariantBudget: null },
    });
    expect(got).toEqual([{ list: orig, k: KS.vectorK }, { list: kw, k: KS.keywordK }]);
  });

  test('both mode (image arm present): text arms at textRrfK, image arm at imageRrfK', () => {
    const arms: VectorArm[] = [];
    pushVectorList(arms, orig, 'original');
    pushVectorList(arms, v1, 'variant');
    pushVectorList(arms, img, 'image');
    const got = composeFusionLists({
      arms, keywordFusionList: kw, titleFusionList: [], relationalList: [],
      includeRelational: true, ks: KS, knobs: { expansionVariantBudget: null },
    });
    expect(got).toEqual([
      { list: orig, k: KS.textRrfK },
      { list: v1, k: KS.textRrfK },
      { list: img, k: KS.imageRrfK },
      { list: kw, k: KS.keywordK },
    ]);
  });

  test('both mode keeps imageRrfK on the image arm when a budget is set (weight applies to text variants only)', () => {
    const arms: VectorArm[] = [];
    pushVectorList(arms, orig, 'original');
    pushVectorList(arms, v1, 'variant');
    pushVectorList(arms, img, 'image');
    const got = composeFusionLists({
      arms, keywordFusionList: kw, titleFusionList: [], relationalList: [],
      includeRelational: true, ks: KS, knobs: { expansionVariantBudget: 0.5 },
    });
    expect(got[2]).toEqual({ list: img, k: KS.imageRrfK });
    expect(got[1]).toEqual({ list: v1, k: KS.textRrfK, weight: 0.5 });
    expect(got[0]).toEqual({ list: orig, k: KS.textRrfK });
  });

  test('image-only mode (sole image arm): fuses at vectorK, exactly as the single-list mapping did', () => {
    const arms: VectorArm[] = [];
    pushVectorList(arms, img, 'image');
    const got = composeFusionLists({
      arms, keywordFusionList: [], titleFusionList: [], relationalList: rel,
      includeRelational: false, ks: KS, knobs: { expansionVariantBudget: null },
    });
    expect(got).toEqual([{ list: img, k: KS.vectorK }, { list: [], k: KS.keywordK }]);
  });

  test('CORRECTED corner: both mode whose image branch fell open with two text lists → no list gets imageRrfK', () => {
    // Pre-role mapping: isBothMode = modality==='both' && lists.length >= 2
    // → the LAST text (variant) list was handed imageRrfK. With roles there
    // is no image arm, so every text arm fuses at vectorK.
    const arms: VectorArm[] = [];
    pushVectorList(arms, orig, 'original');
    pushVectorList(arms, v1, 'variant');
    const got = composeFusionLists({
      arms, keywordFusionList: kw, titleFusionList: [], relationalList: [],
      includeRelational: true, ks: KS, knobs: { expansionVariantBudget: null },
    });
    expect(got.some((l) => l.k === KS.imageRrfK)).toBe(false);
    expect(got.some((l) => l.k === KS.textRrfK)).toBe(false);
    expect(got.slice(0, 2).map((l) => l.k)).toEqual([KS.vectorK, KS.vectorK]);
  });
});

describe('roles survive the salvage path (tagged objects, never index alignment)', () => {
  test('a rejected variant is simply not pushed; the original keeps its role wherever it lands', () => {
    // Simulate Promise.allSettled salvage: queries [orig, v1, v2]; v1's embed
    // rejected → only orig + v2 are pushed. With an index-aligned roles array
    // v2 would have inherited v1's slot; with tags it is unambiguous.
    const arms: VectorArm[] = [];
    const settled: Array<{ ok: boolean; list: SearchResult[] }> = [
      { ok: true, list: [gold] }, { ok: false, list: [] }, { ok: true, list: [distractor] },
    ];
    settled.forEach((s, i) => { if (s.ok) pushVectorList(arms, s.list, i === 0 ? 'original' : 'variant'); });
    expect(arms.map((a) => a.role)).toEqual(['original', 'variant']);
    const lists = composeFusionLists({
      arms, keywordFusionList: [], titleFusionList: [], relationalList: [],
      includeRelational: true, ks: KS, knobs: { expansionVariantBudget: 0.5 },
    });
    expect(lists[0].weight).toBeUndefined();
    expect(lists[1].weight).toBe(0.5); // sole voting variant takes the whole budget
  });

  test('original embed rejected → the surviving list at index 0 is a variant, not the original', () => {
    const arms: VectorArm[] = [];
    const originalOk = false;
    [[distractor], [gold]].forEach((list, i) => pushVectorList(arms, list, i === 0 && originalOk ? 'original' : 'variant'));
    expect(arms.map((a) => a.role)).toEqual(['variant', 'variant']);
  });
});

describe('textArmsNonEmpty / textVectorArmNonEmpty (role-based demotion gate)', () => {
  test('a nonempty IMAGE arm alone never counts as a healthy text arm', () => {
    const arms: VectorArm[] = [];
    pushVectorList(arms, [], 'original');
    pushVectorList(arms, [row('img/photo')], 'image');
    expect(textArmsNonEmpty(arms)).toBe(false);
    expect(textVectorArmNonEmpty(arms)).toBe(false);
  });
  test('any nonempty text arm (original, variant, or clause) counts', () => {
    const mk = (role: VectorArm['role']) => {
      const arms: VectorArm[] = [];
      pushVectorList(arms, [], 'original');
      pushVectorList(arms, [row('notes/a')], role);
      pushVectorList(arms, [], 'image');
      return arms;
    };
    expect(textArmsNonEmpty(mk('variant'))).toBe(true);
    expect(textArmsNonEmpty(mk('clause'))).toBe(true);
    expect(textArmsNonEmpty([{ list: [row('notes/a')], role: 'original' }])).toBe(true);
    expect(textArmsNonEmpty([])).toBe(false);
  });
});

describe('rrfFusionWeighted — weight is a literature-form vote multiplier', () => {
  const a = row('notes/a', 1);
  const b = row('notes/b', 2);
  const c = row('notes/c', 3);

  /** The pre-wave formula, reproduced verbatim (score = Σ 1/(k+rank), max-normalized). */
  function legacyRrf(lists: Array<{ list: SearchResult[]; k: number }>): Array<[string, number]> {
    const scores = new Map<string, number>();
    for (const { list, k } of lists) {
      list.forEach((r, rank) => scores.set(r.slug, (scores.get(r.slug) ?? 0) + 1 / (k + rank)));
    }
    const max = Math.max(...scores.values());
    return [...scores.entries()].map(([s, v]) => [s, v / max] as [string, number]).sort((x, y) => y[1] - x[1]);
  }

  test('weight omitted, or weight: 1 on every list, is byte-identical to the old formula', () => {
    const lists = [{ list: [a, b, c], k: 60 }, { list: [c, a], k: 50 }, { list: [b], k: 66 }];
    const expected = legacyRrf(lists);
    const omitted = rrfFusionWeighted(lists, false).map((r) => [r.slug, r.score]);
    const explicit = rrfFusionWeighted(lists.map((l) => ({ ...l, weight: 1 })), false).map((r) => [r.slug, r.score]);
    expect(omitted).toEqual(expected);
    expect(explicit).toEqual(expected);
  });

  test('weight 0.5 halves a list\'s contribution at EVERY rank (a k-penalty would fade at depth)', () => {
    // Single weighted list, no normalization interference: compare raw ratios
    // via a two-list fixture where the reference list anchors max score.
    const anchor = [row('notes/anchor', 9)];
    const full = rrfFusionWeighted([{ list: anchor, k: 1 }, { list: [a, b, c], k: 60, weight: 1 }], false);
    const half = rrfFusionWeighted([{ list: anchor, k: 1 }, { list: [a, b, c], k: 60, weight: 0.5 }], false);
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
      expect(scoreOf(half, slug)).toBeCloseTo(scoreOf(full, slug) / 2, 12);
    }
  });
});

describe('normalizeExpansionVariantBudget — the ONE range contract for expansion_variant_budget', () => {
  test('finite numbers in (0, 4] pass through unchanged (boundary 4 inclusive)', () => {
    expect(normalizeExpansionVariantBudget(0.5)).toBe(0.5);
    expect(normalizeExpansionVariantBudget(1)).toBe(1);
    expect(normalizeExpansionVariantBudget(2.0)).toBe(2);
    expect(normalizeExpansionVariantBudget(4)).toBe(4);
    expect(normalizeExpansionVariantBudget(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    expect(EXPANSION_VARIANT_BUDGET_MAX).toBe(4);
  });

  test('null and the literals legacy/null → null (legacy weight-1 fusion)', () => {
    expect(normalizeExpansionVariantBudget(null)).toBeNull();
    expect(normalizeExpansionVariantBudget('legacy')).toBeNull();
    expect(normalizeExpansionVariantBudget('LEGACY')).toBeNull();
    expect(normalizeExpansionVariantBudget(' legacy ')).toBeNull();
    expect(normalizeExpansionVariantBudget('null')).toBeNull();
  });

  test('numeric strings parse (config-key plane): "0.5", " 4 "; garbage does not', () => {
    expect(normalizeExpansionVariantBudget('0.5')).toBe(0.5);
    expect(normalizeExpansionVariantBudget(' 4 ')).toBe(4);
    expect(normalizeExpansionVariantBudget('')).toBeUndefined();
    expect(normalizeExpansionVariantBudget('   ')).toBeUndefined();
    expect(normalizeExpansionVariantBudget('x')).toBeUndefined();
    expect(normalizeExpansionVariantBudget('4abc')).toBeUndefined(); // strict: no parseFloat prefix salvage
    expect(normalizeExpansionVariantBudget('NaN')).toBeUndefined();
    expect(normalizeExpansionVariantBudget('Infinity')).toBeUndefined();
  });

  test('out-of-range / non-finite / wrong-typed → undefined (unset: fall through to config → bundle)', () => {
    expect(normalizeExpansionVariantBudget(0)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(-0)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(-1)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(4.5)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(4.000001)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(Number.NaN)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(undefined)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(true)).toBeUndefined();
    expect(normalizeExpansionVariantBudget(false)).toBeUndefined();
    expect(normalizeExpansionVariantBudget({})).toBeUndefined();
    expect(normalizeExpansionVariantBudget([1])).toBeUndefined();
    expect(normalizeExpansionVariantBudget(() => 1)).toBeUndefined();
  });

  test('the config-key parser IS this contract (mode.ts routes through it — one range, two seams)', () => {
    const viaConfig = (v: string) => loadOverridesFromConfig({ 'search.expansion_variant_budget': v }).expansion_variant_budget;
    for (const v of ['0.5', '4', '0', '-1', '4.5', 'NaN', '', 'x', '4abc', 'legacy', 'null', 'LEGACY']) {
      const expected = normalizeExpansionVariantBudget(v);
      if (expected === undefined) expect(loadOverridesFromConfig({ 'search.expansion_variant_budget': v })).not.toHaveProperty('expansion_variant_budget');
      else expect(viaConfig(v)).toBe(expected as number | null);
    }
  });

  test('an invalid per-call value normalized to undefined falls through to the bundle and hashes as legacy (never evb=NaN)', () => {
    const legacy = resolveSearchMode({ mode: 'tokenmax' });
    for (const bad of [Number.NaN, 0, -1, 4.5, Number.POSITIVE_INFINITY]) {
      const r = resolveSearchMode({ mode: 'tokenmax', perCall: { expansion_variant_budget: normalizeExpansionVariantBudget(bad) } });
      expect(r.expansion_variant_budget).toBeNull();
      expect(knobsHash(r)).toBe(knobsHash(legacy));
    }
    // And a bad per-call value must NOT mask a valid config override either.
    const r = resolveSearchMode({
      mode: 'tokenmax',
      overrides: { expansion_variant_budget: 0.5 },
      perCall: { expansion_variant_budget: normalizeExpansionVariantBudget(Number.NaN) },
    });
    expect(r.expansion_variant_budget).toBe(0.5);
  });
});
