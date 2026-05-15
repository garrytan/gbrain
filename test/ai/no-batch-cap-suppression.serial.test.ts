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

  test('configureGateway does not warn for any first-party recipe (every embedding recipe declares max_batch_tokens or no_batch_cap)', () => {
    warnSpy.mockClear();
    resetGateway();
    configureGateway({ env: {} });
    const messages = warnSpy.mock.calls.map(c => String(c[0] ?? ''));
    // Pre-v0.34.5 this test asserted that google STILL warned (waiting for
    // someone to cap it). google now declares max_batch_tokens, so the
    // contract flips: every native/openai-compat recipe is capped, and the
    // missing-cap warning is silent for the entire first-party set.
    const missingCapWarnings = messages.filter(m =>
      m.includes('declares an embedding touchpoint') &&
      m.includes('without max_batch_tokens'),
    );
    expect(missingCapWarnings).toHaveLength(0);
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
