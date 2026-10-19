/**
 * Authoring gate: free migration authorization must not read corpus text;
 * paid/unpriced targets and reranker switches retain the request census.
 * Removing the price shortcut fails the zero-read assertions. Settlement
 * coverage exercises paid dispatch, but does not bound free preview reads.
 * The existing engine interface is the only seam; no provider is called.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { EmbeddingMigrationPlan } from '../src/core/embedding-migration.ts';
import { planMigrationWorstCase } from '../src/core/embedding-migration-worst-case.ts';

const plan = (model: string): EmbeddingMigrationPlan => ({
  from_model: 'synthetic:legacy', from_dims: 1024, column_dims: null,
  to_model: model, to_dims: 1024, dim_change: true, chunks_to_embed: 1,
  chunks_to_restamp: 0, total_chars: 0, null_signature_chunks: 1,
  false_stamped_chunks: 0, est_cost_usd: 0, price_known: false,
  resuming: false, reranker_warning: null, signature_census: [], synopsis_tier_pages: 0,
});

function fixture(overrides?: Record<string, unknown>) {
  const executeRaw = mock(async (sql: string) => {
    if (sql.includes('information_schema.columns')) return [{ exists: false }];
    if (sql.includes('SELECT cc.page_id, cc.chunk_index, cc.chunk_text')) return [{
      page_id: 1, chunk_index: 0, chunk_text: 'Synthetic chunk text.',
      chunk_source: 'compiled_truth', title: null, contextual_retrieval_mode: null, stale: true,
    }];
    if (sql.includes('FROM pages p JOIN sources')) return [];
    if (sql.includes('FROM facts f')) return [{ id: '1', source_id: 'default', fact: 'Synthetic fact text.' }];
    throw new Error(`Unexpected census query: ${sql}`);
  });
  const getConfig = mock(async (key: string) => {
    if (key !== 'pricing.overrides') throw new Error(`Unexpected config read: ${key}`);
    return overrides ? JSON.stringify(overrides) : null;
  });
  return { engine: { executeRaw, getConfig } as unknown as BrainEngine, executeRaw, getConfig };
}

describe('embedding migration worst-case price shortcut', () => {
  test.each([
    { model: 'ollama:bge-m3' },
    { model: 'llama-server:synthetic-embed' },
    { model: 'lmstudio:synthetic-embed' },
    { model: 'openai:text-embedding-3-small', overrides: { 'openai:text-embedding-3-small': 0 } },
    { model: 'litellm:synthetic-embed', overrides: { 'litellm:synthetic-embed': { input: 0, output: 0 } } },
    { model: 'ollama:bge-m3', reranker: 'llama-server-reranker:synthetic-rerank' },
    { model: 'ollama:bge-m3', reranker: 'voyage:rerank-3', overrides: { 'voyage:rerank-3': 0 } },
  ])('zero-priced $model with reranker $reranker skips every corpus query', async ({ model, overrides, reranker }) => {
    const { engine, executeRaw, getConfig } = fixture(overrides);
    const result = await planMigrationWorstCase(engine, plan(model), { rerankerModel: reranker });
    expect(result).toEqual({ requests: 0, input_tokens: 0, usd: 0, unpriced_models: [], counts_skipped: 'zero_price' });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(getConfig.mock.calls).toEqual([['pricing.overrides']]);
  });

  test.each([
    { model: 'openai:text-embedding-3-small', usd: 'positive', unpriced: [] },
    { model: 'litellm:synthetic-embed', usd: 'unknown', unpriced: ['litellm:synthetic-embed'] },
    { model: 'ollama:bge-m3', overrides: { 'ollama:bge-m3': 0.1 }, usd: 'positive', unpriced: [] },
    { model: 'openai:text-embedding-3-small', overrides: { 'openai:text-embedding-3-small': 1e-20 }, usd: 'positive', unpriced: [] },
    { model: 'openai:text-embedding-3-small', overrides: { 'openai:*': 0 }, usd: 'positive', unpriced: [] },
    { model: 'openai:text-embedding-3-small', overrides: { 'openai:text-embedding-3-small': -1 }, usd: 'positive', unpriced: [] },
    { model: 'ollama:bge-m3', reranker: 'voyage:rerank-3', usd: 'positive', unpriced: [] },
    { model: 'ollama:bge-m3', reranker: 'synthetic:unpriced-rerank', usd: 'zero', unpriced: ['synthetic:unpriced-rerank'] },
  ])('$model with reranker $reranker retains the full priced/unpriced census', async ({ model, overrides, reranker, usd, unpriced }) => {
    const { engine, executeRaw } = fixture(overrides);
    const result = await planMigrationWorstCase(engine, plan(model), { rerankerModel: reranker });
    expect(executeRaw).toHaveBeenCalledTimes(4);
    expect(executeRaw.mock.calls.some(([sql]) => sql.includes('cc.chunk_text'))).toBe(true);
    expect(executeRaw.mock.calls.some(([sql]) => sql.includes('FROM pages p JOIN sources'))).toBe(true);
    expect(executeRaw.mock.calls.some(([sql]) => sql.includes('FROM facts f'))).toBe(true);
    expect(result.requests).toBe(8 + (reranker ? 1 : 0));
    expect(result.input_tokens).toBeGreaterThan(6000);
    expect(result.unpriced_models).toEqual([...unpriced]);
    if (usd === 'positive') expect(result.usd).toBeGreaterThan(0);
    else expect(result.usd).toBe(usd === 'unknown' ? null : 0);
    expect(result).not.toHaveProperty('counts_skipped');
  });

  test('a traversed plan still prices operator overrides after the census', async () => {
    const model = 'litellm:synthetic-embed';
    const overrides: Record<string, unknown> = { [model]: 1 };
    const { engine, executeRaw } = fixture(overrides);
    const read = executeRaw.getMockImplementation()!;
    executeRaw.mockImplementation(async sql => {
      delete overrides[model];
      return read(sql);
    });
    const result = await planMigrationWorstCase(engine, plan(model));
    expect(executeRaw).toHaveBeenCalledTimes(4);
    expect(result.usd).toBeNull();
    expect(result.unpriced_models).toEqual([model]);
  });
});
