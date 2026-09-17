/** Native Jev gateway through hybrid retrieval; hermetic score-policy regressions, not calibration. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { gradeRetrievalConfidence } from '../../src/core/search/crag.ts';
import { readRecentRerankFailures } from '../../src/core/rerank-audit.ts';
import { configureGateway, resetGateway, __setRerankTransportForTests } from '../../src/core/ai/gateway.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { withEnv } from '../helpers/with-env.ts';
import { RELATIONAL_QUESTIONS, probeEmbeddingDim, relationalBasisEmbedding, seedRelationalCorpus } from '../fixtures/retrieval-quality/relational/corpus.ts';

const MODEL = 'typesafe:jev-1.13.0';
const QUERY = 'alpha keyword evidence';
let engine: PGLiteEngine;
let home: string;
let vector: Float32Array;
let calls = 0;
let scores = [2.85, 2.7, 0.6, 0.45, 0.3];
let failed = false;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-jev-search-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedRelationalCorpus(engine);
  const dim = await probeEmbeddingDim(engine);
  vector = new Float32Array(dim);
  const companies = [...new Set(RELATIONAL_QUESTIONS.filter(q => q.kind === 'who_rel').map(q => q.seed!))];
  companies.forEach((slug, i) => {
    const basis = relationalBasisEmbedding(slug, dim);
    for (let j = 0; j < dim; j++) vector[j] += (1 + i * 0.05) * basis[j]!;
  });
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', ['jev-score-examples']);
  for (let i = 0; i < 5; i++) {
    const slug = `notes/score-example-${i}`;
    const text = `${QUERY} candidate-${i}`;
    await engine.putPage(slug, { type: 'note', title: `Example note ${i}`, compiled_truth: text }, { sourceId: 'jev-score-examples' });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }], { sourceId: 'jev-score-examples' });
  }
  await engine.setConfig('search.reranker.model', MODEL);
  await engine.setConfig('search.reranker.enabled', 'true');
}, 120_000);

beforeEach(() => {
  calls = 0;
  failed = false;
  scores = [2.85, 2.7, 0.6, 0.45, 0.3];
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: vector.length,
    reranker_model: MODEL, env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setRerankTransportForTests(async (url, init) => {
    calls++;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(String(init.body));
    expect(body.state.query).toBeDefined();
    if (failed) return new Response('private-source-marker', { status: 503 });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, value]) => {
      const doc = (value as { instructions: { candidate: string } }).instructions.candidate;
      const candidate = doc.match(/candidate-(\d)/)?.[1];
      // Deliberately invert relational evidence: the existing pin must still protect edge answers.
      const score = candidate !== undefined ? scores[Number(candidate)]!
        : doc.includes('privately held company') ? 3 : doc.includes('venture fund') ? 1.8 : 0.6;
      return [id, { type: 'score', score }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100 } }));
  });
});

afterAll(async () => {
  __setRerankTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

async function run(query = QUERY, overrides: { autocut?: boolean; relationalRerankPin?: number } = {}) {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearch(engine, query, { sourceId: query === QUERY ? 'jev-score-examples' : 'default', limit: 10,
      queryEmbedFn: () => vector, onMeta: value => { meta = value; }, autocut: false, ...overrides });
    return { results, meta };
  });
}

describe('optional Jev through existing hybrid search', () => {
  test('configuration selects the native adapter and stamps normalized scores', async () => {
    const { results, meta } = await run();
    expect(calls).toBe(1);
    const notes = results.filter(row => row.slug.startsWith('notes/score-example'));
    expect(notes).toHaveLength(5);
    expect(notes[0]!.slug).toBe('notes/score-example-0');
    expect(notes[0]!.rerank_score).toBeCloseTo(0.95);
    expect(meta?.degraded?.some(row => row.stage === 'reranker_skipped' || row.stage === 'rerank_passthrough')).toBe(false);
  });

  test('existing autocut consumes the native normalized cliff and respects its override', async () => {
    const full = await run();
    const cut = await run(QUERY, { autocut: true });
    expect(cut.results.length).toBe(2);
    expect(cut.results.map(row => row.rerank_score)).toEqual([2.85 / 3, 2.7 / 3]);
    expect(full.results.length).toBeGreaterThan(cut.results.length);
  });

  test('flat native judgments keep the full set when autocut is explicitly enabled', async () => {
    scores = [2.7, 2.64, 2.58, 2.52, 2.46];
    const full = await run();
    const cut = await run(QUERY, { autocut: true });
    expect(cut.results.map(row => row.slug)).toEqual(full.results.map(row => row.slug));
  });

  test('CRAG grades the actual retrieved native score with the existing floor', async () => {
    const strong = await run();
    expect(gradeRetrievalConfidence(strong.results)).toMatchObject({ level: 'strong', reason: 'rerank_top', top_rerank_score: 2.85 / 3 });
    scores = [0.36, 0.3, 0.24, 0.18, 0.12];
    const weak = await run();
    expect(gradeRetrievalConfidence(weak.results)).toMatchObject({ level: 'weak', reason: 'rerank_top_below_floor', top_rerank_score: 0.36 / 3 });
    expect(weak.results.length).toBeGreaterThan(0);
  });

  test('native failure preserves fused order and writes the existing private audit', async () => {
    await engine.setConfig('search.reranker.enabled', 'false');
    const baseline = await run();
    await engine.setConfig('search.reranker.enabled', 'true');
    failed = true;
    const fallback = await run(QUERY, { autocut: true });
    expect(fallback.results.map(row => row.slug)).toEqual(baseline.results.map(row => row.slug));
    expect(fallback.results.some(row => row.rerank_score !== undefined)).toBe(false);
    const events = await withEnv({ GBRAIN_HOME: home }, () => readRecentRerankFailures());
    expect(events.some(row => row.model === MODEL && row.reason === 'network')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private-source-marker');
  });

  test('existing relational pin protects typed-edge evidence with the Jev adapter', async () => {
    const query = 'who invested in widget-co';
    const gold = RELATIONAL_QUESTIONS.find(row => row.query === query)!.relevant!;
    const on = await run(query, { relationalRerankPin: 3, autocut: true });
    const off = await run(query, { relationalRerankPin: 0, autocut: true });
    expect(calls).toBe(2);
    expect(gold).toContain(on.results[0]!.slug);
    expect(on.results.slice(0, Math.min(3, gold.length)).every(row => gold.includes(row.slug))).toBe(true);
    expect(gold).not.toContain(off.results[0]!.slug);
    expect(on.meta?.relational_rerank_pin).toBeDefined();
  });
});
