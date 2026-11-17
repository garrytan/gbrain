/**
 * OpenRouter reranker allowlist — NVIDIA Nemotron 3.5 Rerank 8B (free).
 *
 * The reranker path enforces the recipe's `models` allowlist strictly (no
 * openai-compat bypass), so a model OpenRouter serves but the recipe omits is
 * reported "not a known reranker" and never called. The retired
 * `nvidia/llama-nemotron-rerank-vl-1b-v2:free` entry returned "No endpoints
 * found" from OpenRouter (both the `:free` and bare ids), so it is replaced by
 * `nvidia/nemotron-3.5-rerank-8b:free`, which answers with cost 0.
 *
 * The free variant is the only one that resolves: the bare id has no endpoint.
 */

import { describe, test, expect } from 'bun:test';
import { rerankerReadiness } from '../src/core/ai/reranker-readiness.ts';

const env = { OPENROUTER_API_KEY: 'test-key' };

describe('openrouter reranker allowlist', () => {
  test('accepts nvidia/nemotron-3.5-rerank-8b:free', () => {
    const r = rerankerReadiness('openrouter:nvidia/nemotron-3.5-rerank-8b:free', env);
    expect(r.recipeKnown).toBe(true);
    expect(r.hasTouchpoint).toBe(true);
    expect(r.modelListed).toBe(true);
    expect(r.ready).toBe(true);
  });

  test('drops the retired Nemotron VL free entry', () => {
    const r = rerankerReadiness('openrouter:nvidia/llama-nemotron-rerank-vl-1b-v2:free', env);
    expect(r.modelListed).toBe(false);
    expect(r.ready).toBe(false);
  });

  test('still accepts the Cohere rerankers', () => {
    for (const m of ['cohere/rerank-v3.5', 'cohere/rerank-4-fast', 'cohere/rerank-4-pro']) {
      expect(rerankerReadiness(`openrouter:${m}`, env).ready).toBe(true);
    }
  });
});
