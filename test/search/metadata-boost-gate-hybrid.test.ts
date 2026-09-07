/**
 * Ranker wave, Phase E3 (Cat 13) — `search.metadata_boost_gate` end-to-end
 * through hybridSearch, hermetic (in-memory PGLite + the deterministic
 * `queryEmbedFn` seam; no keys, no network). Pattern:
 * test/search/concept-weights.test.ts.
 *
 * The E1 localization shape in miniature:
 *   - gold concept page: semantic match ONLY (paraphrase body, ZERO
 *     query-token overlap, NO inbound links); chunk at the query's basis dim
 *     (cosine 1.0)
 *   - hub decoy page: semantically close (cosine 0.9), ZERO query-token
 *     overlap, 12 inbound wikilinks → backlink boost 1 + 0.05·ln(13) ≈ 1.128x
 *   - superseded draft: cosine 0.85, target of a `supersedes` edge from gold
 *   - 12 linker pages: no chunks (never retrieved); they only carry the links
 *
 * Score math (one vector list; RRF → normalize → cosine blend 0.7/0.3):
 *   gold = 0.7·1       + 0.3·1.0  = 1.000
 *   hub  = 0.7·(60/61) + 0.3·0.9  ≈ 0.958  → ×1.128 backlink ≈ 1.081 > gold
 * Under `always` the hub outranks gold purely via the backlink boost (the
 * intruder class E1 counted 100/105 times). Under `lexical`, the paraphrase
 * produces no strict keyword / title / relational row, so the gate skips the
 * metadata stages and the vector order stands: gold is top-1. A query WITH a
 * strict keyword hit is byte-identical under both settings.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';

const DIM = 1536;
const QUERY_DIM = 12;
/** Paraphrase: shares NO stemmed token with any page body or title below. */
const PARAPHRASE = 'why does an early advantage keep compounding';
/** Strict AND match on the gold body (snowballing, returns, initial, wins). */
const LEXICAL = 'snowballing returns from initial wins';

const GOLD = 'concepts/durable-moat-example';
const HUB = 'companies/acme-example';
const DRAFT = 'notes/old-moat-draft';
const LINKERS = 12;

let engine: PGLiteEngine;

/** Unit vector with cosine `cos` to the query basis dim and 0 to every other fixture dim. */
function leaning(cos: number, privateDim: number): Float32Array {
  const e = new Float32Array(DIM);
  e[QUERY_DIM] = cos;
  e[privateDim] = Math.sqrt(1 - cos * cos);
  return e;
}

async function putChunkPage(slug: string, type: string, title: string, text: string, embedding: Float32Array): Promise<void> {
  await engine.putPage(slug, { type, title, compiled_truth: text, timeline: text });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: text,
    chunk_source: 'compiled_truth',
    embedding,
    token_count: 16,
  }]);
}

async function run(query: string, opts: { metadataBoostGate?: 'always' | 'lexical' } = {}) {
  let meta: HybridSearchMeta | undefined;
  const results = await hybridSearch(engine, query, {
    limit: 5,
    queryEmbedFn: () => basisEmbedding(QUERY_DIM, DIM),
    onMeta: (m) => { meta = m; },
    ...opts,
  });
  return { results, meta: meta! };
}

const slugs = (rs: SearchResult[]) => rs.map((r) => r.slug);

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await putChunkPage(GOLD, 'concept', 'Durable Moat Example',
    'a moat that grows stronger the longer it persists, snowballing returns from initial wins',
    basisEmbedding(QUERY_DIM, DIM));
  await putChunkPage(HUB, 'company', 'Acme Example',
    'acme-example is a household-brand widget maker; notes on the founders and the seed round',
    leaning(0.9, 700));
  await putChunkPage(DRAFT, 'note', 'Old Moat Draft',
    'stale draft: a moat that widens as it ages, returns pile up from first wins',
    leaning(0.85, 701));

  const links: Array<{ from_slug: string; to_slug: string; link_type: string }> = [];
  for (let i = 0; i < LINKERS; i++) {
    const slug = `people/linker-${String(i).padStart(2, '0')}`;
    await engine.putPage(slug, { type: 'person', title: `Linker ${i}`, compiled_truth: `linker ${i}` });
    links.push({ from_slug: slug, to_slug: HUB, link_type: 'works_at' });
  }
  links.push({ from_slug: GOLD, to_slug: DRAFT, link_type: 'supersedes' });
  await engine.addLinksBatch(links);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('metadata_boost_gate — hermetic hybridSearch (Cat 13 E3)', () => {
  test('fixture: the paraphrase has no lexical vote; the lexical query has a strict keyword hit', async () => {
    expect((await engine.searchKeyword(PARAPHRASE, { limit: 10 })).filter((r) => !r.keyword_relaxed)).toEqual([]);
    expect(await engine.searchTitles(PARAPHRASE, { limit: 10 })).toEqual([]);
    expect(slugs(await engine.searchKeyword(LEXICAL, { limit: 10 }))).toContain(GOLD);
  });

  test('always (pre-wave pipeline, per-call): the hub decoy outranks the gold concept page via the backlink boost; meta reports a vector-only voter', async () => {
    const { results, meta } = await run(PARAPHRASE, { metadataBoostGate: 'always' });
    expect(slugs(results).slice(0, 2)).toEqual([HUB, GOLD]);
    const hub = results.find((r) => r.slug === HUB)!;
    expect(hub.backlink_boost).toBeGreaterThan(1.1);
    expect(results.find((r) => r.slug === GOLD)!.backlink_boost).toBeUndefined();
    expect(meta.metadata_boost_gate).toEqual({
      gate: 'always', lexical_voted: false, boosts_applied: true, reason: 'gate_always',
    });
  });

  test('lexical (per-call): no lexical vote → metadata boosts skipped, the vector order holds, gold is top-1; supersede downrank still runs', async () => {
    const { results, meta } = await run(PARAPHRASE, { metadataBoostGate: 'lexical' });
    expect(slugs(results).slice(0, 2)).toEqual([GOLD, HUB]);
    const hub = results.find((r) => r.slug === HUB)!;
    expect(hub.backlink_boost).toBeUndefined();
    expect(hub.base_score).toBeDefined(); // the stage wrapper still ran
    const draft = results.find((r) => r.slug === DRAFT);
    expect(draft?.superseded).toBe(true);
    expect(draft?.superseded_by).toBe(GOLD);
    expect(meta.metadata_boost_gate).toEqual({
      gate: 'lexical', lexical_voted: false, boosts_applied: false, reason: 'vector_only_voter',
    });
  });

  test('bundle default is lexical: no pins → gold is top-1 and meta reports the vector-only voter', async () => {
    const { results, meta } = await run(PARAPHRASE);
    expect(slugs(results).slice(0, 2)).toEqual([GOLD, HUB]);
    expect(meta.metadata_boost_gate).toEqual({
      gate: 'lexical', lexical_voted: false, boosts_applied: false, reason: 'vector_only_voter',
    });
  });

  test('always (config key `search.metadata_boost_gate`): the pre-wave pipeline through the config plane; per-call wins over config', async () => {
    await engine.setConfig('search.metadata_boost_gate', 'always');
    try {
      const { results, meta } = await run(PARAPHRASE);
      expect(slugs(results)[0]).toBe(HUB);
      expect(meta.metadata_boost_gate?.gate).toBe('always');
      expect(meta.metadata_boost_gate?.boosts_applied).toBe(true);
      // Per-call wins over config.
      const { results: forced, meta: forcedMeta } = await run(PARAPHRASE, { metadataBoostGate: 'lexical' });
      expect(slugs(forced)[0]).toBe(GOLD);
      expect(forcedMeta.metadata_boost_gate?.gate).toBe('lexical');
    } finally {
      await engine.setConfig('search.metadata_boost_gate', 'lexical');
    }
    expect((await run(PARAPHRASE)).meta.metadata_boost_gate?.gate).toBe('lexical');
  });

  test('a query WITH a strict keyword hit is byte-identical under both gate values (boosts apply either way)', async () => {
    const always = await run(LEXICAL, { metadataBoostGate: 'always' });
    const lexical = await run(LEXICAL, { metadataBoostGate: 'lexical' });
    expect(lexical.results).toEqual(always.results);
    expect(slugs(always.results)[0]).toBe(GOLD);
    expect(always.meta.metadata_boost_gate).toEqual({
      gate: 'always', lexical_voted: true, boosts_applied: true, reason: 'gate_always',
    });
    expect(lexical.meta.metadata_boost_gate).toEqual({
      gate: 'lexical', lexical_voted: true, boosts_applied: true, reason: 'lexical_voted',
    });
    // The hub still earns its backlink boost when a lexical arm voted.
    expect(lexical.results.find((r) => r.slug === HUB)?.backlink_boost).toBeGreaterThan(1.1);
  });

  test('an unparseable per-call value is unset (falls through to the bundle = lexical)', async () => {
    const { results, meta } = await run(PARAPHRASE, { metadataBoostGate: 'off' as unknown as 'always' });
    expect(slugs(results)[0]).toBe(GOLD);
    expect(meta.metadata_boost_gate?.gate).toBe('lexical');
  });
});
