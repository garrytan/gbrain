/**
 * Ranker wave, Phase E2 (Cat 13) — `search.keyword_arm_confidence_floor`
 * end-to-end through hybridSearch (pattern: test/search/concept-weights.test.ts).
 *
 * Discriminating corpus (hermetic: in-memory PGLite + deterministic
 * basisEmbedding; no keys, no network):
 *
 *   - concept page: semantic match ONLY (paraphrase body, zero query-token
 *     overlap; chunk embedded at the query's basis dim → the vector arm ranks
 *     it first)
 *   - two lexical decoys: query tokens in title + chunk text, IDENTICAL chunk
 *     text (so their ts_rank ties → keyword-arm margin ratio exactly 0.5), NO
 *     embedding (NULL → the vector arm never sees them)
 *
 * Floor off: keyword + title votes for the decoy (2 lists) outvote the
 * concept's single vector vote → the decoy wins top-1 (the Cat 13 shape).
 * Floor 0.6 (> 0.5): both lexical lists fuse at weight 0.5 → the concept page
 * wins. A query with a strong keyword margin (single strict hit) is
 * byte-identical with the floor on vs off. The meta stamp
 * `keyword_arm_confidence` carries the margin per probe even with the floor
 * off — the calibration surface the sibling Cat 13 runner reads.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';

const DIM = 1536;
const QUERY = 'what is the compounding advantage idea';
const STRONG_QUERY = 'snowballing returns';
const NO_LEXICAL_QUERY = 'zzqx plorf vantablack';
const QUERY_DIM = 12;
const CONCEPT = 'concepts/durable-moat-example';
const DECOY_A = 'notes/compounding-advantage-idea-a';
const DECOY_B = 'notes/compounding-advantage-idea-b';
const DECOY_TEXT = 'the compounding advantage idea came up: compounding advantage idea';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Concept page: pure-paraphrase body (ZERO query-token overlap), embedded
  // at the query's dim. Title tokens disjoint from the query.
  const conceptText = 'a moat that grows stronger the longer it persists, snowballing returns from early wins';
  await engine.putPage(CONCEPT, {
    type: 'concept',
    title: 'Durable Moat Example',
    compiled_truth: conceptText,
    timeline: conceptText,
  });
  await engine.upsertChunks(CONCEPT, [{
    chunk_index: 0,
    chunk_text: conceptText,
    chunk_source: 'compiled_truth',
    embedding: basisEmbedding(QUERY_DIM, DIM),
    token_count: 16,
  }]);

  // Two lexical decoys with IDENTICAL chunk text (tied ts_rank → margin 0.5)
  // and NO embedding (the vector arm cannot vote them).
  for (const slug of [DECOY_A, DECOY_B]) {
    await engine.putPage(slug, {
      type: 'note',
      title: 'compounding advantage idea',
      compiled_truth: DECOY_TEXT,
      timeline: DECOY_TEXT,
    });
    await engine.upsertChunks(slug, [{
      chunk_index: 0,
      chunk_text: DECOY_TEXT,
      chunk_source: 'compiled_truth',
      token_count: 12,
    }]);
  }
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

type Run = { results: Awaited<ReturnType<typeof hybridSearch>>; meta: HybridSearchMeta | undefined };

async function run(
  query: string,
  perCall: { keywordArmConfidenceFloor?: number | null } = {},
  extra: Record<string, unknown> = {},
): Promise<Run> {
  let meta: HybridSearchMeta | undefined;
  const results = await hybridSearch(engine, query, {
    limit: 5,
    intentWeighting: false,
    queryEmbedFn: () => basisEmbedding(QUERY_DIM, DIM),
    onMeta: (m) => { meta = m; },
    ...perCall,
    ...extra,
  });
  return { results, meta };
}

const FLOOR_KEY = 'search.keyword_arm_confidence_floor';

describe('fixture sanity', () => {
  test('the keyword arm returns the two decoys with tied scores (margin exactly 0.5); the vector arm sees only the concept page', async () => {
    const kw = await engine.searchKeyword(QUERY, { limit: 10 });
    expect(kw.map((r) => r.slug).sort()).toEqual([DECOY_A, DECOY_B]);
    expect(kw[0].score).toBeGreaterThan(0);
    expect(kw[0].score).toBeCloseTo(kw[1].score, 10);
    const vec = await engine.searchVector(basisEmbedding(QUERY_DIM, DIM), { limit: 10 });
    expect(vec.map((r) => r.slug)).toEqual([CONCEPT]);
  });
});

describe('search.keyword_arm_confidence_floor through hybridSearch (hermetic)', () => {
  test('floor off (bundle null): the lexical decoy wins top-1; meta stamps margin 0.5 / downweighted false', async () => {
    const off = await run(QUERY);
    expect(off.results[0].slug).toMatch(/^notes\/compounding-advantage-idea-/);
    expect(off.results.map((r) => r.slug)).toContain(CONCEPT);
    expect(off.meta?.vector_enabled).toBe(true);
    expect(off.meta?.keyword_arm_confidence).toBeDefined();
    expect(off.meta?.keyword_arm_confidence?.margin_ratio).toBeCloseTo(0.5, 10);
    expect(off.meta?.keyword_arm_confidence?.top_score).toBeGreaterThan(0);
    expect(off.meta?.keyword_arm_confidence?.downweighted).toBe(false);
  });

  test('floor 0.6 per-call (weak margin 0.5 < 0.6): the concept page wins top-1; meta downweighted true', async () => {
    const on = await run(QUERY, { keywordArmConfidenceFloor: 0.6 });
    expect(on.results[0].slug).toBe(CONCEPT);
    expect(on.meta?.keyword_arm_confidence).toEqual({
      margin_ratio: on.meta!.keyword_arm_confidence!.margin_ratio,
      top_score: on.meta!.keyword_arm_confidence!.top_score,
      downweighted: true,
    });
    expect(on.meta?.keyword_arm_confidence?.margin_ratio).toBeCloseTo(0.5, 10);
    // The decoys are demoted, not dropped.
    expect(on.results.map((r) => r.slug)).toContain(DECOY_A);
  });

  test('the floor is real: 0.4 per-call (margin 0.5 is NOT below it) leaves the decoy on top', async () => {
    const r = await run(QUERY, { keywordArmConfidenceFloor: 0.4 });
    expect(r.results[0].slug).toMatch(/^notes\/compounding-advantage-idea-/);
    expect(r.meta?.keyword_arm_confidence?.downweighted).toBe(false);
    expect(r.results).toEqual((await run(QUERY)).results);
  });

  test('via the config key: 0.6 flips top-1 to the concept page; the literal off restores the decoy exactly', async () => {
    const off = await run(QUERY);
    try {
      await engine.setConfig(FLOOR_KEY, '0.6');
      const on = await run(QUERY);
      expect(on.results[0].slug).toBe(CONCEPT);
      expect(on.meta?.keyword_arm_confidence?.downweighted).toBe(true);
      await engine.setConfig(FLOOR_KEY, 'off');
      const back = await run(QUERY);
      expect(back.results).toEqual(off.results);
      expect(back.meta?.keyword_arm_confidence?.downweighted).toBe(false);
    } finally {
      await engine.setConfig(FLOOR_KEY, 'off');
    }
  });

  test('per-call wins over config: null per-call under a 0.6 config reproduces the off ranking', async () => {
    const off = await run(QUERY);
    try {
      await engine.setConfig(FLOOR_KEY, '0.6');
      const pinnedOff = await run(QUERY, { keywordArmConfidenceFloor: null });
      expect(pinnedOff.results).toEqual(off.results);
      expect(pinnedOff.meta?.keyword_arm_confidence?.downweighted).toBe(false);
      // An invalid per-call value is unset → the config floor still applies.
      expect((await run(QUERY, { keywordArmConfidenceFloor: Number.NaN })).results[0].slug).toBe(CONCEPT);
    } finally {
      await engine.setConfig(FLOOR_KEY, 'off');
    }
  });

  test('strong keyword margin (single strict hit → margin 1): byte-identical results with the floor on vs off', async () => {
    const off = await run(STRONG_QUERY);
    const on = await run(STRONG_QUERY, { keywordArmConfidenceFloor: 0.6 });
    expect(off.results.length).toBeGreaterThan(0);
    expect(on.results).toEqual(off.results);
    expect(off.meta?.keyword_arm_confidence).toEqual({ margin_ratio: 1, top_score: off.meta!.keyword_arm_confidence!.top_score, downweighted: false });
    expect(off.meta?.keyword_arm_confidence?.top_score).toBeGreaterThan(0);
    expect(on.meta?.keyword_arm_confidence?.downweighted).toBe(false);
    // Even a floor of 1 (the maximum) never demotes an uncontested arm.
    expect((await run(STRONG_QUERY, { keywordArmConfidenceFloor: 1 })).results).toEqual(off.results);
  });

  test('empty keyword arm (no lexical match at all): margin 0, never down-weighted, results identical', async () => {
    const off = await run(NO_LEXICAL_QUERY);
    const on = await run(NO_LEXICAL_QUERY, { keywordArmConfidenceFloor: 0.6 });
    expect(on.results).toEqual(off.results);
    expect(off.meta?.keyword_arm_confidence).toEqual({ margin_ratio: 0, top_score: 0, downweighted: false });
    expect(on.meta?.keyword_arm_confidence?.downweighted).toBe(false);
  });

  test('keyword-only fallback (every query embed rejected → vectorArms empty): no decision is made, no stamp, results identical', async () => {
    // Async rejection: the salvage fan-out settles it as a failed embed and
    // routes to the keyword-only fallback (a SYNC throw would escape
    // Promise.resolve() before any catch and abort the search instead).
    const throwing = { queryEmbedFn: async (): Promise<Float32Array> => { throw new Error('embed provider down'); } };
    const off = await run(QUERY, {}, throwing);
    const on = await run(QUERY, { keywordArmConfidenceFloor: 0.6 }, throwing);
    expect(off.meta?.vector_enabled).toBe(false);
    expect(off.meta?.keyword_arm_confidence).toBeUndefined();
    expect(on.meta?.keyword_arm_confidence).toBeUndefined();
    expect(on.results).toEqual(off.results);
    expect(off.results[0].slug).toMatch(/^notes\/compounding-advantage-idea-/);
  });
});
