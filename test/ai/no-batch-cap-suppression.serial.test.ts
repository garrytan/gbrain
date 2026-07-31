/**
 * #779 + #121 adjacent fixes (Commit 9 of v0.32 wave).
 *
 * Coverage:
 *  - Recipes with `embedding.no_batch_cap: true` suppress the
 *    missing-max_batch_tokens startup warning (#779)
 *  - Real-provider recipes without the flag still warn (regression guard)
 *  - listRecipes returns expected dynamic-cap recipes (ollama, litellm,
 *    llama-server) all flagged
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { capBatchItems, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { listRecipes, getRecipe, __setTestRecipesForTests } from '../../src/core/ai/recipes/index.ts';
import type { Recipe } from '../../src/core/ai/types.ts';

/**
 * A recipe that declares an embedding touchpoint but omits every batch cap
 * (no max_batch_tokens, no no_batch_cap, no max_batch_items). This is the
 * exact shape a future provider PR might forget — the case the startup
 * warning exists to catch. Kept synthetic because every shipped recipe now
 * declares a cap, so no real recipe can play this role anymore.
 */
const CAPLESS_RECIPE: Recipe = {
  id: 'synthetic-capless',
  name: 'Synthetic cap-less (test fixture)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  touchpoints: {
    embedding: {
      models: ['synthetic-embed-1'],
      default_dims: 768,
    },
  },
};

describe('v0.32 #779: no_batch_cap suppresses the missing-max_batch_tokens warning', () => {
  let warnSpy: ReturnType<typeof mock>;
  let realWarn: typeof console.warn;

  beforeAll(() => {
    realWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as any;
  });

  afterAll(() => {
    console.warn = realWarn;
    resetGateway();
  });

  test('Ollama, LiteLLM declare no_batch_cap: true', () => {
    for (const id of ['ollama', 'litellm']) {
      const r = getRecipe(id);
      expect(r, `${id} not registered`).toBeDefined();
      expect(
        r!.touchpoints.embedding?.no_batch_cap,
        `${id} should declare no_batch_cap: true`,
      ).toBe(true);
    }
  });

  test('llama-server declares a hard item-count cap (max_batch_items: 32)', () => {
    // llama.cpp enforces a request-COUNT cap equal to its launch --batch-size
    // (default 32); declaring max_batch_items both bounds batches AND suppresses
    // the missing-max_batch_tokens warning. Replaces the prior no_batch_cap flag.
    const r = getRecipe('llama-server');
    expect(r, 'llama-server not registered').toBeDefined();
    expect(r!.touchpoints.embedding?.max_batch_items).toBe(32);
    expect(r!.touchpoints.embedding?.no_batch_cap).toBeUndefined();
  });

  test('dashscope declares the documented 10-item embedding cap (max_batch_items: 10)', () => {
    // DashScope's OpenAI-compat /embeddings endpoint rejects >10-item batches
    // (documented Model Studio cap; concept from community PRs #2643/#2405).
    // max_batch_tokens stays as the aggregate token-size guard.
    const r = getRecipe('dashscope');
    expect(r, 'dashscope not registered').toBeDefined();
    expect(r!.touchpoints.embedding?.max_batch_items).toBe(10);
    expect(r!.touchpoints.embedding?.max_batch_tokens).toBe(8192);
    // 25 items pre-split into DashScope-sized groups of at most 10.
    const texts = Array.from({ length: 25 }, (_, i) => `t${i}`);
    expect(capBatchItems(texts, 10).map(b => b.length)).toEqual([10, 10, 5]);
  });

  test('configureGateway does NOT warn for ollama/litellm/llama-server', () => {
    warnSpy.mockClear();
    resetGateway();
    configureGateway({ env: {} });
    const messages = warnSpy.mock.calls.map(c => String(c[0] ?? ''));
    for (const id of ['ollama', 'litellm', 'llama-server']) {
      expect(
        messages.some(m => m.includes(`"${id}"`)),
        `should NOT warn for ${id}`,
      ).toBe(false);
    }
  });

  test('google no longer warns — it now declares max_batch_tokens', () => {
    // google's gemini-embedding endpoint ships a declared batch-token budget,
    // so configuring it must NOT trip the missing-cap warning.
    const r = getRecipe('google');
    expect(r?.touchpoints.embedding?.max_batch_tokens).toBeGreaterThan(0);

    warnSpy.mockClear();
    resetGateway();
    configureGateway({ env: {} });
    let messages = warnSpy.mock.calls.map(c => String(c[0] ?? ''));
    expect(
      messages.some(m => m.includes('"google"') && m.includes('without max_batch_tokens')),
      'google should not warn while OpenAI default is configured',
    ).toBe(false);

    warnSpy.mockClear();
    resetGateway();
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' },
    });
    messages = warnSpy.mock.calls.map(c => String(c[0] ?? ''));
    expect(
      messages.some(m => m.includes('"google"') && m.includes('without max_batch_tokens')),
      'google now declares a cap and must stay quiet even when configured',
    ).toBe(false);
  });

  test('a configured recipe that omits every batch cap still warns', () => {
    // Regression guard the google fixture used to provide. Every shipped
    // embedding recipe now declares a cap, so the warn-fires path is exercised
    // with a synthetic cap-less recipe injected into the registry.
    __setTestRecipesForTests([CAPLESS_RECIPE]);
    try {
      warnSpy.mockClear();
      resetGateway();
      configureGateway({
        embedding_model: 'synthetic-capless:synthetic-embed-1',
        embedding_dimensions: 768,
        env: {},
      });
      const messages = warnSpy.mock.calls.map(c => String(c[0] ?? ''));
      expect(
        messages.some(
          m => m.includes('"synthetic-capless"') && m.includes('without max_batch_tokens'),
        ),
        'a configured recipe missing every batch cap must warn',
      ).toBe(true);
    } finally {
      __setTestRecipesForTests([]);
    }
  });

  test('every recipe with empty models[] declares user_provided_models OR has openai-fast-path', () => {
    // Cross-cutting invariant: contracts should not silently disagree.
    for (const r of listRecipes()) {
      const e = r.touchpoints.embedding;
      if (!e) continue;
      if (e.models.length === 0) {
        expect(
          e.user_provided_models === true || r.id === 'litellm',
          `${r.id} has empty models[] — must declare user_provided_models: true`,
        ).toBe(true);
      }
    }
  });
});
