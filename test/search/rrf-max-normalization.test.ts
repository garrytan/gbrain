/**
 * Bit-identity pins for the rrf max-normalization linear-time rewrite.
 *
 * The three normalization sites (rrfFusionWeighted, rrfFusion, cosineReScore)
 * replaced `Math.max(...rows.map(r => r.score))` with a single-pass
 * `Math.max` fold:
 *
 *   let m = -Infinity;
 *   for (const r of rows) m = Math.max(m, r.score);
 *
 * The fold is provably identical to the spread form for every input
 * (empty -> -Infinity, NaN propagates, +/-Infinity, -0/+0 all match by the
 * Math.max spec applied pairwise), minus the temp array and minus the
 * spread's RangeError on huge lists. These tests pin that claim:
 *
 * 1. max-pin: the fold is `toBe`-equal to the spread form over seeded
 *    arrays of every relevant size plus hostile edge values.
 * 2. fusion-pin: full rrfFusionWeighted / rrfFusion outputs are bit-identical
 *    to a FROZEN pre-rewrite reference (spread form) on a seeded corpus that
 *    exercises accumulation, weights, the compiled-truth boost path, the
 *    unverified-stub exclusion, and keyword_hit OR-propagation.
 */
import { describe, expect, test } from 'bun:test';
import {
  rrfFusion,
  rrfFusionWeighted,
  compiledTruthBoost,
} from '../../src/core/search/hybrid.ts';
import type { FusionListEntry } from '../../src/core/search/fusion-lists.ts';
import type { SearchResult } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// 1. The fold under test, written in the exact shape used at the call sites.
// ---------------------------------------------------------------------------
function maxFold(scores: number[]): number {
  let m = -Infinity;
  for (const s of scores) m = Math.max(m, s);
  return m;
}
function maxSpread(scores: number[]): number {
  return Math.max(...scores);
}

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('rrf max fold is bit-identical to the spread form', () => {
  const EDGES = [
    -0, 0, 1e-300, -1e-300, 1e300, -1e300,
    Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON,
    Infinity, -Infinity, NaN,
  ];
  for (const n of [0, 1, 2, 3, 7, 50, 200, 600, 1500]) {
    test(`n=${n}, seeded finite scores`, () => {
      const rand = mulberry(1000 + n);
      const xs = Array.from({ length: n }, () => rand());
      expect(maxFold(xs)).toBe(maxSpread(xs));
    });
    test(`n=${n}, seeded scores with hostile edges spliced in`, () => {
      const rand = mulberry(2000 + n);
      const xs = Array.from({ length: n }, () => rand());
      for (let i = 0; i < EDGES.length && i < xs.length; i++) xs[i * 7 % xs.length] = EDGES[i];
      expect(maxFold(xs)).toBe(maxSpread(xs));
    });
  }
  test('all-NaN and all-negative-infinity arrays', () => {
    expect(maxFold([NaN, NaN])).toBe(maxSpread([NaN, NaN]));
    expect(maxFold([-Infinity, -Infinity])).toBe(maxSpread([-Infinity, -Infinity]));
    expect(maxFold([-0])).toBe(maxSpread([-0]));
  });
});

// ---------------------------------------------------------------------------
// 2. Frozen pre-rewrite references (spread form). Do not touch: they are the
//    equivalence baseline. `compiledTruthBoost` is shared from prod because it
//    is unchanged by the rewrite.
// ---------------------------------------------------------------------------
function frozenRrfKey(r: SearchResult): string {
  const source = r.source_id ?? 'default';
  return `${source}:${r.slug}:${r.chunk_id ?? r.chunk_text.slice(0, 50)}`;
}

function frozenRrfFusionWeighted(lists: FusionListEntry[], applyBoost = true): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number; keywordHit: boolean }>();
  for (const { list, k, weight } of lists) {
    const w = weight ?? 1;
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = frozenRrfKey(r);
      const existing = scores.get(key);
      const rrfScore = w / (k + rank);
      if (existing) {
        existing.score += rrfScore;
        if (r.keyword_hit === true) existing.keywordHit = true;
      } else {
        scores.set(key, { result: r, score: rrfScore, keywordHit: r.keyword_hit === true });
      }
    }
  }
  const entries = Array.from(scores.values());
  if (entries.length === 0) return [];
  const maxScore = Math.max(...entries.map(e => e.score)); // <- the old spread form
  if (maxScore > 0) {
    for (const e of entries) {
      e.score = e.score / maxScore;
      e.score *= compiledTruthBoost(e.result, applyBoost);
    }
  }
  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score, keywordHit }) =>
      keywordHit && result.keyword_hit !== true
        ? { ...result, score, keyword_hit: true }
        : { ...result, score });
}

function frozenRrfFusion(lists: SearchResult[][], k: number, applyBoost = true): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number; keywordHit: boolean }>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = frozenRrfKey(r);
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);
      if (existing) {
        existing.score += rrfScore;
        if (r.keyword_hit === true) existing.keywordHit = true;
      } else {
        scores.set(key, { result: r, score: rrfScore, keywordHit: r.keyword_hit === true });
      }
    }
  }
  const entries = Array.from(scores.values());
  if (entries.length === 0) return [];
  const maxScore = Math.max(...entries.map(e => e.score)); // <- the old spread form
  if (maxScore > 0) {
    for (const e of entries) {
      e.score = e.score / maxScore;
      e.score *= compiledTruthBoost(e.result, applyBoost);
    }
  }
  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score, keywordHit }) =>
      keywordHit && result.keyword_hit !== true
        ? { ...result, score, keyword_hit: true }
        : { ...result, score });
}

// ---------------------------------------------------------------------------
// Fixture: seeded corpus exercising every normalization input shape.
// ---------------------------------------------------------------------------
function row(slug: string, chunk_id: number, over: Partial<SearchResult> = {}): SearchResult {
  return {
    slug,
    page_id: chunk_id,
    title: slug,
    type: 'note',
    chunk_text: `${slug} body text ${chunk_id}`,
    chunk_source: 'timeline',
    chunk_id,
    chunk_index: 0,
    score: 0,
    stale: false,
    source_id: 'src1',
    ...over,
  } as SearchResult;
}

function fusionFixture(): { weighted: FusionListEntry[]; plain: SearchResult[][] } {
  const rand = mulberry(777);
  const pool: SearchResult[] = [];
  for (let i = 0; i < 240; i++) {
    const over: Partial<SearchResult> = {};
    if (i % 25 === 0) over.chunk_source = 'compiled_truth'; // boost path
    if (i % 40 === 0) over.unverified = true; // stub exclusion path
    if (i % 17 === 0) over.keyword_hit = true; // OR-propagation path
    pool.push(row(`notes/doc-${i}`, 1000 + i, over));
  }
  // shuffle into overlapping lists (rows repeat across lists -> accumulation)
  const lists: SearchResult[][] = [[], [], []];
  for (const r of pool) {
    for (let li = 0; li < 3; li++) {
      if (rand() < 0.55) lists[li].push(r);
    }
  }
  const weighted: FusionListEntry[] = [
    { list: lists[0], k: 60, weight: 1 },
    { list: lists[1], k: 50, weight: 0.5 },
    { list: lists[2], k: 75 }, // weight omitted -> 1
  ];
  return { weighted, plain: lists };
}

function assertIdenticalFusion(actual: SearchResult[], expected: SearchResult[], label: string) {
  expect(actual.length, `${label}: length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    expect(a.slug, `${label}[${i}]: slug`).toBe(e.slug);
    expect(a.chunk_id, `${label}[${i}]: chunk_id`).toBe(e.chunk_id);
    expect(a.score, `${label}[${i}]: score bit-identical`).toBe(e.score);
    expect(a.keyword_hit === true, `${label}[${i}]: keyword_hit`).toBe(e.keyword_hit === true);
  }
}

describe('rrf fusion outputs bit-identical to the pre-rewrite spread form', () => {
  const { weighted, plain } = fusionFixture();

  test('rrfFusionWeighted, boost on', () => {
    assertIdenticalFusion(
      rrfFusionWeighted(weighted, true),
      frozenRrfFusionWeighted(weighted, true),
      'rrfFusionWeighted(boost)',
    );
  });
  test('rrfFusionWeighted, boost off', () => {
    assertIdenticalFusion(
      rrfFusionWeighted(weighted, false),
      frozenRrfFusionWeighted(weighted, false),
      'rrfFusionWeighted(no-boost)',
    );
  });
  test('rrfFusion, boost on', () => {
    assertIdenticalFusion(rrfFusion(plain, 60, true), frozenRrfFusion(plain, 60, true), 'rrfFusion(boost)');
  });
  test('rrfFusion, boost off', () => {
    assertIdenticalFusion(rrfFusion(plain, 60, false), frozenRrfFusion(plain, 60, false), 'rrfFusion(no-boost)');
  });
  test('empty lists', () => {
    expect(rrfFusionWeighted([], true)).toEqual(frozenRrfFusionWeighted([], true));
    expect(rrfFusion([[], []], 60, true)).toEqual(frozenRrfFusion([[], []], 60, true));
  });
  test('single row (maxScore is the only score)', () => {
    const single: FusionListEntry[] = [{ list: [row('notes/solo', 1)], k: 60 }];
    assertIdenticalFusion(
      rrfFusionWeighted(single, true),
      frozenRrfFusionWeighted(single, true),
      'rrfFusionWeighted(single)',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. cosineReScore's max step (the DB path itself is engine-bound; the
//    normalization arithmetic is what the rewrite touched).
// ---------------------------------------------------------------------------
describe('cosineReScore max step bit-identical', () => {
  test('normRrf matches the spread form on seeded scores', () => {
    const rand = mulberry(31337);
    const scores = Array.from({ length: 400 }, () => rand() * 2);
    const maxRrfSpread = Math.max(...scores.map(s => s));
    const maxRrfFold = maxFold(scores);
    expect(maxRrfFold).toBe(maxRrfSpread);
    for (const s of scores) {
      const normSpread = maxRrfSpread > 0 ? s / maxRrfSpread : 0;
      const normFold = maxRrfFold > 0 ? s / maxRrfFold : 0;
      expect(normFold).toBe(normSpread);
      expect(0.7 * normFold + 0.3 * 0).toBe(0.7 * normSpread + 0.3 * 0);
    }
  });
  test('empty results: max is -Infinity, norm is 0 in both forms', () => {
    const maxRrfSpread = Math.max(...([] as number[]));
    const maxRrfFold = maxFold([]);
    expect(maxRrfFold).toBe(maxRrfSpread);
    expect(maxRrfFold > 0 ? 1 / maxRrfFold : 0).toBe(0);
  });
});
