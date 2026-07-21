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
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { listRecipes, getRecipe } from '../../src/core/ai/recipes/index.ts';

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

  test('Ollama, LiteLLM, llama-server all declare no_batch_cap: true', () => {
    for (const id of ['ollama', 'litellm', 'llama-server']) {
      const r = getRecipe(id);
      expect(r, `${id} not registered`).toBeDefined();
      expect(
        r!.touchpoints.embedding?.no_batch_cap,
        `${id} should declare no_batch_cap: true`,
      ).toBe(true);
    }
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

  test('configureGateway does NOT warn for google now that it declares batch caps (#970)', () => {
    warnSpy.mockClear();
    resetGateway();
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake' },
    });
    const messages = warnSpy.mock.calls.map(c => String(c[0] ?? ''));
    expect(
      messages.some(m => m.includes('"google"') && m.includes('without max_batch_tokens')),
      'google declares max_batch_tokens/max_batch_count since #970 — no warning',
    ).toBe(false);
  });

  test('google recipe declares its derived batch caps (#970)', () => {
    const e = getRecipe('google')!.touchpoints.embedding!;
    // Count cap is the REAL Gemini limit (batchEmbedContents: 100 inputs);
    // the token budget is derived (100 × 2048 per-input tokens), NOT the
    // 2048 per-input limit — copying that verbatim would over-split 50×.
    expect(e.max_batch_count).toBe(100);
    expect(e.max_batch_tokens).toBe(204_800);
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
