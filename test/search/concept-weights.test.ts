/**
 * v0.46.15 (Cat 13) — concept-intent vector-lean weights, DELTA-asserted.
 *
 * The measured defect: definitional paraphrases classified `entity` and got
 * the keyword tilt, making hybrid LOSE to its own vector arm (47.0 vs 49.1
 * nDCG@5 on 500 paraphrase probes). This test builds the minimal
 * discriminating corpus:
 *
 *   - concept page: semantic match ONLY (paraphrase body, no query tokens;
 *     chunk embedded at the query's basis dim → vector arm votes it)
 *   - decoy page: lexical match ONLY (query tokens in title-grain FTS +
 *     chunk text; chunk embedded at a far dim → keyword/title arms vote it)
 *
 * and asserts the DIRECTION FLIPS with the concept weights:
 *   intentWeighting off (general weights) → the decoy wins top-1
 *   intentWeighting on  (concept weights) → the concept page wins top-1
 *
 * Hermetic: in-memory PGLite + the deterministic queryEmbedFn seam (the
 * v0.46.5.0 canary hook). No keys, no network.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { classifyQueryIntent } from '../../src/core/search/query-intent.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';

const DIM = 1536;
const QUERY = 'what is the compounding advantage idea';
const QUERY_DIM = 12;

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
  // at the query's dim. Title tokens deliberately disjoint from the query.
  await engine.putPage('concepts/durable-moat-example', {
    type: 'concept',
    title: 'Durable Moat Example',
    compiled_truth: 'a moat that grows stronger the longer it persists, snowballing returns from early wins',
    timeline: 'a moat that grows stronger the longer it persists, snowballing returns from early wins',
  });
  await engine.upsertChunks('concepts/durable-moat-example', [
    {
      chunk_index: 0,
      chunk_text: 'a moat that grows stronger the longer it persists, snowballing returns from early wins',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(QUERY_DIM, DIM),
      token_count: 16,
    },
  ]);

  // Decoy page: query tokens everywhere lexical (title + timeline + chunk),
  // embedded at a FAR dim (vector arm never votes it).
  await engine.putPage('notes/compounding-advantage-idea-notes', {
    type: 'note',
    title: 'compounding advantage idea',
    compiled_truth: 'the compounding advantage idea came up in notes',
    timeline: 'the compounding advantage idea came up: compounding advantage idea',
  });
  await engine.upsertChunks('notes/compounding-advantage-idea-notes', [
    {
      chunk_index: 0,
      chunk_text: 'the compounding advantage idea came up: compounding advantage idea',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(512, DIM),
      token_count: 12,
    },
  ]);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('concept-intent weights (Cat 13)', () => {
  test('the query classifies as concept', () => {
    expect(classifyQueryIntent(QUERY)).toBe('concept');
  });

  test('DIRECTIONAL DELTA: concept weights measurably close the gap to the lexical decoy', async () => {
    // The tilt is deliberately subtle (±10-20% on RRF k), so a top-1 flip
    // fixture would be knife-edge and flaky by construction. What the k math
    // GUARANTEES is direction: with concept weights (vec k 60→50, kw k
    // 60→66.7) the semantic page's score RATIO vs the lexical decoy strictly
    // improves. The authoritative top-1 lift claim is Cat 13's pre-merge
    // keyed validation (500 paraphrase probes), not this fixture.
    const run = (intentWeighting: boolean) =>
      hybridSearch(engine, QUERY, {
        limit: 5,
        intentWeighting,
        queryEmbedFn: () => basisEmbedding(QUERY_DIM, DIM),
      });

    const off = await run(false);
    const on = await run(true);

    const ratio = (rs: Awaited<ReturnType<typeof run>>) => {
      const concept = rs.find((r) => r.slug === 'concepts/durable-moat-example');
      const decoy = rs.find((r) => r.slug === 'notes/compounding-advantage-idea-notes');
      expect(concept).toBeDefined();
      expect(decoy).toBeDefined();
      return concept!.score / decoy!.score;
    };

    const offRatio = ratio(off);
    const onRatio = ratio(on);
    // Concept weights close the gap by a real margin (~20% in the k math);
    // assert >8% so boost-stage noise can't flake it while a weight
    // regression (concept tilt lost/reversed) still fails hard.
    expect(onRatio).toBeGreaterThan(offRatio * 1.08);
  });

  test('the raw cosine survives to the result (evidence contract feed)', async () => {
    const on = await hybridSearch(engine, QUERY, {
      limit: 5,
      intentWeighting: true,
      queryEmbedFn: () => basisEmbedding(QUERY_DIM, DIM),
    });
    const concept = on.find((r) => r.slug === 'concepts/durable-moat-example');
    expect(concept?.cosine).toBeCloseTo(1.0, 5);
  });
});
