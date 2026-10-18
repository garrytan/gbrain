/**
 * The shipped reranker default is voyage:rerank-3-lite (gbrain-evals #148,
 * v0.10.93). It reaches only brains that never set `search.reranker.model`;
 * a brain with an explicit model keeps it. Each case runs a real PGLite
 * brain's config through loadSearchModeConfig → resolveSearchMode →
 * applyReranker → gateway.rerank and checks the model on the wire.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadSearchModeConfig, resolveSearchMode } from '../src/core/search/mode.ts';
import { applyReranker } from '../src/core/search/rerank.ts';
import { DEFAULT_RERANKER_MODEL } from '../src/core/ai/defaults.ts';
import { configureGateway, resetGateway, __setRerankTransportForTests } from '../src/core/ai/gateway.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'search.%'`);
  configureGateway({ env: { VOYAGE_API_KEY: 'pa-test-zerokey' } });
});

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

const candidates: SearchResult[] = Array.from({ length: 60 }, (_, i) => ({
  slug: `notes/n${i}`, title: `n${i}`, score: 1 - i / 100, chunk_text: `chunk ${i}`,
  type: 'note', source_id: 'default', chunk_index: 0, chunk_id: i + 1,
}) as unknown as SearchResult);

async function wireRequest(): Promise<{ model: string; documents: number }> {
  const knobs = resolveSearchMode(await loadSearchModeConfig(engine));
  let body: { model: string; documents: string[] } | null = null;
  __setRerankTransportForTests(async (_url, init) => {
    body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  await applyReranker('q', candidates, {
    enabled: knobs.reranker_enabled,
    topNIn: knobs.reranker_top_n_in,
    topNOut: knobs.reranker_top_n_out,
    model: knobs.reranker_model,
  });
  expect(body).not.toBeNull();
  return { model: body!.model, documents: body!.documents.length };
}

describe('reranker default vs an explicit search.reranker.model', () => {
  test('the shipped default is voyage:rerank-3-lite', () => {
    expect(DEFAULT_RERANKER_MODEL).toBe('voyage:rerank-3-lite');
  });

  test('a tokenmax brain that never set search.reranker.model sends rerank-3-lite, 50 candidates', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    expect(await wireRequest()).toEqual({ model: 'rerank-3-lite', documents: 50 });
  });

  test('a brain with no search config at all (balanced fallback) sends rerank-3-lite', async () => {
    expect((await wireRequest()).model).toBe('rerank-3-lite');
  });

  test('a brain that set search.reranker.model voyage:rerank-2.5 keeps rerank-2.5', async () => {
    await engine.setConfig('search.mode', 'tokenmax');
    await engine.setConfig('search.reranker.model', 'voyage:rerank-2.5');
    expect(await wireRequest()).toEqual({ model: 'rerank-2.5', documents: 50 });
  });

  test('any other explicit model is kept too', async () => {
    await engine.setConfig('search.mode', 'balanced');
    await engine.setConfig('search.reranker.model', 'voyage:rerank-3');
    expect((await wireRequest()).model).toBe('rerank-3');
  });
});
