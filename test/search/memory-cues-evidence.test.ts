import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch, hybridSearchCached, type HybridSearchOpts } from '../../src/core/search/hybrid.ts';
import { cueSignature, memoryCueColumn, runMemoryCueBuild, submitMemoryCueBuild } from '../../src/core/memory-cues/index.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { resultTokens } from '../../src/core/search/token-budget.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';

const SLUG = 'notes/scheduling-constraint-example';
const CHUNKS = ['I do not take calls ', 'before 10.'];
const CUE = 'Arranging an early appointment';
let dimensions: number;
let embeddingModel: string;
const vector = (axis: number) => Float32Array.from({ length: dimensions }, (_, i) => i === axis ? 1 : 0);
let engine: PGLiteEngine;

async function buildCues() {
  const receipt = await submitMemoryCueBuild(engine, { sourceIds: ['default'], pageLimit: 1, maxUsd: 1, trustedLocal: true });
  const result = await runMemoryCueBuild(engine, { buildId: receipt.buildId, providers: {
    generate: async ({ evidence }) => {
      const start = evidence.indexOf(CHUNKS[0]);
      const end = evidence.indexOf(CHUNKS[1], start);
      return { actualUsd: 0, output: start >= 0 && end >= start ? [{ family: 'horizon', relation: 'explicit_constraint_applies',
        quote: evidence.slice(start, end + CHUNKS[1].length), text: CUE }] : [] };
    },
    embed: async (texts) => texts.map(() => vector(0)),
  } });
  expect(result.status).toBe('complete');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dimensions = Number(await engine.getConfig('embedding_dimensions'));
  embeddingModel = (await engine.getConfig('embedding_model'))!;
  expect(embeddingModel).toMatch(/^[^:]+:.+$/);
  const [physical] = await engine.executeRaw<{ dimensions: number }>(`SELECT atttypmod AS dimensions FROM pg_attribute
    WHERE attrelid='content_chunks'::regclass AND attname='embedding'`);
  expect(physical).toEqual({ dimensions });
  for (const [key, value] of Object.entries({
    embedding_columns: JSON.stringify({ embedding: { provider: embeddingModel, dimensions, type: 'vector' } }),
    chat_model: 'openai:gpt-4o-mini', 'memory.cues.generation_enabled': 'true', 'memory.cues.sources': '["default"]',
    'memory.cues.read': 'on', 'memory.cues.min_similarity': '0.8',
  })) await engine.setConfig(key, value);
  expect(await memoryCueColumn(engine)).toEqual({ name: 'embedding', type: 'vector', dimensions, embeddingModel });
  await engine.setConfig('memory.cues.read_calibration_signature', cueSignature(await memoryCueColumn(engine)));
  await engine.putPage(SLUG, { title: 'Scheduling note', type: 'note', compiled_truth: CHUNKS.join('') }, { sourceId: 'default' });
  await installFixtureChunks(engine, SLUG, CHUNKS.map((chunk_text, chunk_index) => ({ chunk_text, chunk_index,
    chunk_source: 'compiled_truth', model: embeddingModel, embedding: vector(chunk_index + 1) })), { sourceId: 'default' });
  await buildCues();
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

async function search(limit: number, tokenBudget?: number, cached = false, onRerank?: () => Promise<void>, query = 'arrange an early appointment', overrides: Partial<HybridSearchOpts> = {}) {
  let meta: HybridSearchMeta | undefined;
  const results = await (cached ? hybridSearchCached : hybridSearch)(engine, query, {
    sourceId: 'default', limit, tokenBudget, expansion: false, relationalRetrieval: false, graph_signals: false,
    salience: 'off', recency: 'off', detail: 'medium', autocut: false, intentWeighting: false,
    queryEmbedFn: () => vector(0), onMeta: (m) => { meta = m; },
    reranker: { enabled: true, topNIn: 5, topNOut: null, rerankerFn: async ({ documents }) => {
      await onRerank?.();
      return documents.map((text, index) => ({ index, relevanceScore: text.includes(CUE) ? 0.99 : 0.01 }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore);
    } },
    ...overrides,
  });
  return { results, meta };
}

describe('cross-chunk cue evidence through production hybrid search', () => {
  test('limit two returns both original chunks, their individual cosines, and one admitted host', async () => {
    const found = await search(2);
    expect(found.meta?.memory_cues).toMatchObject({ candidates: 1, admitted: 1 });
    expect(found.results.map((r) => r.chunk_text)).toEqual(CHUNKS);
    expect(found.results.map((r) => r.chunk_index)).toEqual([0, 1]);
    expect(new Set(found.results.map((r) => r.chunk_id)).size).toBe(2);
    expect(found.results.every((r) => r.cosine === 0 && r.evidence === 'weak_semantic')).toBe(true);
    expect(found.results.map((r) => r.memory_cue?.role)).toEqual(['anchor', 'support']);
    expect(JSON.stringify(found)).not.toContain(CUE);
  });

  test('limit one cannot claim or return a complete cue-derived constraint', async () => {
    const found = await search(1);
    expect(found.results).toEqual([]);
    expect(found.meta?.memory_cues).toMatchObject({ admitted: 0, reason: 'evidence_budget_incomplete' });
  });

  test('an explicit hard page cap of one rejects the group while cap two admits both original chunks', async () => {
    const capped = await search(2, undefined, false, undefined, 'arrange an early appointment', { dedupOpts: { maxPerPage: 1 } });
    expect(capped.results).toEqual([]);
    expect(capped.meta?.memory_cues).toMatchObject({ admitted: 0, reason: 'evidence_page_cap' });
    const complete = await search(2, undefined, false, undefined, 'arrange an early appointment', { dedupOpts: { maxPerPage: 2 } });
    expect(complete.results.map((r) => r.chunk_text)).toEqual(CHUNKS);
    expect(complete.meta?.memory_cues?.admitted).toBe(1);
    const exact = await search(2, undefined, false, undefined, 'Scheduling note', { dedupOpts: { maxPerPage: 1 } });
    expect(exact.results).toHaveLength(1);
    expect(exact.results[0].exact_lookup).toBe('title');
    expect(exact.results[0].memory_cue).toBeUndefined();
  });

  test('independent exact-title lookup still returns its original chunk at limit one without incomplete cue attribution', async () => {
    const found = await search(1, undefined, false, undefined, 'Scheduling note');
    expect(found.results).toHaveLength(1);
    expect(found.results[0]).toMatchObject({ slug: SLUG, exact_lookup: 'title' });
    expect(CHUNKS).toContain(found.results[0].chunk_text);
    expect(found.results[0].memory_cue).toBeUndefined();
    expect(found.meta?.memory_cues?.admitted).toBe(0);
  });

  test('shadow sees the spanning cue but returns exactly the off-mode original chunks', async () => {
    try {
      await engine.setConfig('memory.cues.read', 'off');
      const off = await search(2);
      await engine.setConfig('memory.cues.read', 'shadow');
      const shadow = await search(2);
      expect(shadow.results).toEqual(off.results);
      expect(shadow.meta?.memory_cues).toMatchObject({ candidates: 1, admitted: 0 });
    } finally {
      await engine.setConfig('memory.cues.read', 'on');
    }
  });

  test('supporting chunks spend the shared budget and cannot survive partially or outside the cached wrapper cap', async () => {
    const full = await search(2);
    const cost = full.results.reduce((n, r) => n + resultTokens(r), 0);
    expect(cost).toBeGreaterThan(0);
    const exact = await search(2, cost, true);
    expect(exact.results.map((r) => r.chunk_text)).toEqual(CHUNKS);
    expect(exact.meta?.token_budget?.used).toBe(cost);
    const partial = await search(2, cost - 1, true);
    expect(partial.results).toEqual([]);
    expect(partial.meta?.memory_cues?.admitted).toBe(0);
    expect(partial.meta?.token_budget?.used).toBe(0);
  });

  test('the guaranteed relational answer survives a competing cue group at the final limit', async () => {
    for (const [slug, title, text] of [
      ['companies/widget-co', 'widget-co', 'A company operating in its sector.'],
      ['people/investor-example', 'Investor example', 'An investor with a diversified portfolio.'],
    ]) {
      await engine.putPage(slug, { title, type: slug.startsWith('companies/') ? 'company' : 'person', compiled_truth: text }, { sourceId: 'default' });
      await installFixtureChunks(engine, slug, [{ chunk_text: text, chunk_index: 0, chunk_source: 'compiled_truth', model: embeddingModel, embedding: vector(3) }], { sourceId: 'default' });
    }
    await engine.addLink('people/investor-example', 'companies/widget-co', '', 'invested_in', 'manual');
    try {
      const opts = { relationalRetrieval: true, relationalRerankPin: 0 };
      const tight = await search(2, undefined, false, undefined, 'who invested in widget-co', opts);
      expect(tight.results.some((r) => r.slug === 'people/investor-example')).toBe(true);
      expect(tight.results.some((r) => r.slug === SLUG)).toBe(false);
      expect(tight.meta?.memory_cues?.admitted).toBe(0);
      expect(tight.meta?.relational_evidence_slot?.action).toBe('promoted');
      const roomy = await search(3, undefined, false, undefined, 'who invested in widget-co', opts);
      expect(roomy.results.some((r) => r.slug === 'people/investor-example')).toBe(true);
      expect(roomy.results.filter((r) => r.slug === SLUG).map((r) => r.chunk_text)).toEqual(CHUNKS);
      expect(roomy.meta?.memory_cues?.admitted).toBe(1);
    } finally {
      await engine.deletePage('people/investor-example', { sourceId: 'default' });
      await engine.deletePage('companies/widget-co', { sourceId: 'default' });
    }
  });

  test('newly hydrated supporting chunks retain the unverified host status without inheriting extra ranking authority', async () => {
    await engine.putPage(SLUG, { title: 'Scheduling note', type: 'note', compiled_truth: CHUNKS.join(''),
      frontmatter: { provenance: 'auto-extracted', status: 'unverified' } }, { sourceId: 'default' });
    await installFixtureChunks(engine, SLUG, CHUNKS.map((chunk_text, chunk_index) => ({ chunk_text, chunk_index,
      chunk_source: 'compiled_truth', model: embeddingModel, ...(chunk_index === 0 ? { embedding: vector(1) } : {}) })), { sourceId: 'default' });
    await buildCues();
    let rankedChunks: number[] = [];
    const found = await search(2, undefined, false, async () => {
      await engine.executeRaw(`UPDATE content_chunks cc SET embedding=$1::vector FROM pages p
        WHERE cc.page_id=p.id AND p.source_id='default' AND p.slug=$2 AND cc.chunk_index=1`, [`[${Array.from(vector(2))}]`, SLUG]);
    }, 'arrange an early appointment', { dedupOpts: { maxPerPage: 2 }, onRerankPool: (pool) => { rankedChunks = pool.map((r) => r.chunk_index); } });
    expect(rankedChunks).toEqual([0]);
    expect(found.results.map((r) => r.chunk_text)).toEqual(CHUNKS);
    expect(found.results.map((r) => r.memory_cue?.role)).toEqual(['anchor', 'support']);
    expect(found.results.map((r) => ({ unverified: r.unverified, status: r.status }))).toEqual([
      { unverified: true, status: 'unverified' }, { unverified: true, status: 'unverified' },
    ]);
    expect(found.results[1].score).toBe(0);
    expect(found.results.every((r) => r.cosine === 0 && r.evidence === 'weak_semantic')).toBe(true);
  });

  test('an edit to a supporting chunk during reranking invalidates the whole original evidence group', async () => {
    const found = await search(2, undefined, false, async () => {
      await installFixtureChunks(engine, SLUG, [CHUNKS[0], 'The restriction was withdrawn.'].map((chunk_text, chunk_index) => ({ chunk_text,
        chunk_index, chunk_source: 'compiled_truth', model: embeddingModel, embedding: vector(chunk_index + 1) })), { sourceId: 'default' });
    });
    expect(found.results).toEqual([]);
    expect(found.meta?.memory_cues).toMatchObject({ admitted: 0, reason: 'candidates_invalidated' });
  });
});
