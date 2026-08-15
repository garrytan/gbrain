/**
 * Autocut weak-top floor — the hybrid.ts reranker-model GATE arms the
 * committed integration tests don't pin (ship-audit gap fill):
 *
 * hybrid.ts computes `effectiveRerankerModel = rerankerOpts.model ??
 * resolvedMode.reranker_model` and disables the [0,1] floor for raw-logit
 * rerankers. The committed test covers only the PER-CALL raw-logit override.
 * Here:
 *  - CONFIG-level raw-logit reranker model (per-call opts carry no model →
 *    the `?? resolvedMode.reranker_model` arm) disables the floor;
 *  - a per-call CLOUD model override WINS over a config raw-logit default
 *    (the `??` ordering in the other direction — floor stays active);
 *  - `search.autocut_min_top_score` config threads end-to-end into the
 *    applyAutocut call (0 disables; a lowered floor admits a weak top).
 *
 * Serial: mutates gateway global state (configureGateway +
 * __setEmbedTransportForTests) and DB-plane search.* config keys.
 * No API keys; embedding + reranker stubbed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { PageInput, SearchOpts } from '../../src/core/types.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));

// The exact live-brain weak-top shape that collapsed 32→1 (top 0.317 < 0.5
// floor; normalized rank1→rank2 gap 0.38 clears jumpRatio 0.20).
const WEAK_TOP_CLIFF = [0.317, 0.197, 0.131, 0.118, 0.1];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const pages: Array<[string, PageInput, string]> = [
    ['notes/a', { type: 'note', title: 'A', compiled_truth: 'alpha keyword one' }, 'alpha keyword one chunk'],
    ['notes/b', { type: 'note', title: 'B', compiled_truth: 'alpha keyword two' }, 'alpha keyword two chunk'],
    ['notes/c', { type: 'note', title: 'C', compiled_truth: 'alpha keyword three' }, 'alpha keyword three chunk'],
    ['notes/d', { type: 'note', title: 'D', compiled_truth: 'alpha keyword four' }, 'alpha keyword four chunk'],
    ['notes/e', { type: 'note', title: 'E', compiled_truth: 'alpha keyword five' }, 'alpha keyword five chunk'],
  ];
  for (const [slug, page, chunkText] of pages) {
    await engine.putPage(slug, page);
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: chunkText, chunk_source: 'compiled_truth' },
    ]);
  }

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => FAKE_EMB),
  }) as any);
}, 60_000); // PGLite full-migration-chain init needs breathing room (house pattern, see extract-db.test.ts)

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

afterEach(async () => {
  // Every test's DB-plane override must not leak into the next.
  await engine.unsetConfig('search.reranker.model');
  await engine.unsetConfig('search.autocut_min_top_score');
});

function rerankerWithScores(scores: number[]) {
  return async (input: RerankInput): Promise<RerankResult[]> =>
    input.documents.map((_, i) => ({ index: i, relevanceScore: scores[i] ?? 0.01 }));
}

// Per-call reranker stub WITHOUT a model — rerankerOpts.model stays
// undefined, so the gate falls through to resolvedMode.reranker_model.
function modellessRerankerOpts(scores: number[]): SearchOpts['reranker'] {
  return {
    enabled: true,
    topNIn: 30,
    topNOut: null,
    rerankerFn: rerankerWithScores(scores),
  };
}

describe('weak-top floor gate — resolvedMode.reranker_model arm (config default)', () => {
  test('config-level RAW-LOGIT reranker model → floor disabled, weak-top cliff trims', async () => {
    // The committed test pins the per-call override arm; this pins the
    // `?? resolvedMode.reranker_model` fallback: the operator configured a
    // local raw-logit reranker and the caller passes no per-call model.
    await engine.setConfig('search.reranker.model', 'llama-server-reranker:Qwen3-Reranker-4B');
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: modellessRerankerOpts(WEAK_TOP_CLIFF),
    });
    expect(out.length).toBe(1); // floor off on the unbounded scale → cliff trusted
  });

  test('per-call CLOUD model override beats config raw-logit default → floor stays active', async () => {
    // The `??` ordering in the opposite direction: config says raw-logit,
    // but THIS call routes through a normalized cloud reranker. The [0,1]
    // floor must apply → weak 0.317 top → no trim.
    await engine.setConfig('search.reranker.model', 'llama-server-reranker:Qwen3-Reranker-4B');
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: {
        enabled: true,
        topNIn: 30,
        topNOut: null,
        model: 'zeroentropyai:zerank-2',
        rerankerFn: rerankerWithScores(WEAK_TOP_CLIFF),
      },
    });
    expect(out.length).toBe(baseline.length);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

describe('weak-top floor — search.autocut_min_top_score config threads end-to-end', () => {
  test('config floor 0 disables → weak-top cliff trims (explicit pre-fix behavior via config)', async () => {
    await engine.setConfig('search.autocut_min_top_score', '0');
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: modellessRerankerOpts(WEAK_TOP_CLIFF),
    });
    expect(out.length).toBe(1);
  });

  test('config floor 0.2 admits the 0.317 top → cliff trusted again', async () => {
    // Proves the numeric VALUE threads (not just the 0/off toggle): the same
    // weak-top shape that no-ops at the default 0.5 floor cuts at 0.2.
    await engine.setConfig('search.autocut_min_top_score', '0.2');
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: modellessRerankerOpts(WEAK_TOP_CLIFF),
    });
    expect(out.length).toBe(1);
  });
});
