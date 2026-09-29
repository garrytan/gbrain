/**
 * Ollama recipe — chat touchpoint shape.
 *
 * The extract-atoms phase registers config-selected chat models through the
 * gateway's extended-model path so local/user-managed providers (Ollama) can
 * serve the phase without hosted API keys. That wiring presumes the recipe
 * DECLARES a chat touchpoint with a non-empty allowlist — assertTouchpoint
 * rejects a provider whose touchpoint is missing, and an empty models list
 * would leave no default-eligible model at all.
 */

import { afterAll, afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import {
  configureGateway,
  resetGateway,
  embed,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { withAIInvocationGuard, type AIInvocation } from '../src/core/ai/invocation-guard.ts';

// Never leave a configured gateway or a stubbed transport behind for the next file.
afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('Ollama recipe — chat touchpoint', () => {
  test('declares a chat touchpoint', () => {
    const r = getRecipe('ollama');
    expect(r).toBeDefined();
    expect(r!.touchpoints.chat).toBeDefined();
  });

  test('chat models list is non-empty and every entry is a non-empty string', () => {
    const m = getRecipe('ollama')!.touchpoints.chat!.models;
    expect(Array.isArray(m)).toBe(true);
    expect(m.length).toBeGreaterThan(0);
    for (const model of m) {
      expect(typeof model).toBe('string');
      expect(model.length).toBeGreaterThan(0);
    }
  });

  test('local chat models advertise no tool-loop capabilities but do declare structured outputs', () => {
    // Local Ollama chat serves plain completions; tool support varies by the
    // loaded model, so the gateway must not route tool-use / subagent work
    // here. Structured output is different: Ollama enforces json_schema
    // server-side (grammar-constrained decoding since 0.5, model-independent),
    // so the recipe declares it and chat()/expand() may send a schema (#4863).
    const tp = getRecipe('ollama')!.touchpoints.chat!;
    expect(tp.supports_tools).toBe(false);
    expect(tp.supports_subagent_loop).toBe(false);
    expect(tp.supports_structured_outputs).toBe(true);
  });
});

/**
 * Ollama recipe — embedding input ceiling.
 *
 * `gbrain migrate embeddings` (and any other budget-guarded embed) admits each
 * provider call through an invocation guard that requires a positive
 * `maxInputTokens`. gateway.embed derives it from the recipe's
 * `max_batch_tokens` or `max_input_tokens[model] * inputs`. The ollama recipe
 * declares `no_batch_cap`, so before it declared a per-input ceiling the guard
 * received `maxInputTokens: undefined` and refused every ollama embed, which
 * surfaced as a generic "Preflight embed ... failed".
 */
describe('Ollama recipe — embedding input ceiling', () => {
  beforeEach(() => resetGateway());
  afterEach(() => {
    __setEmbedTransportForTests(null);
  });

  test('declares a per-input token ceiling for nomic-embed-text', () => {
    const ceiling = getRecipe('ollama')!.touchpoints.embedding!.max_input_tokens?.['nomic-embed-text'];
    expect(Number.isSafeInteger(ceiling)).toBe(true);
    expect(ceiling!).toBeGreaterThan(0);
  });

  test('embed() hands the invocation guard a positive maxInputTokens for ollama:nomic-embed-text', async () => {
    configureGateway({
      embedding_model: 'ollama:nomic-embed-text',
      embedding_dimensions: 768,
      env: {},
    });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => Array.from({ length: 768 }, () => 0.1)),
    })) as any);

    const seen: AIInvocation[] = [];
    const vectors = await withAIInvocationGuard(
      async call => {
        seen.push(call);
        return { settle: async () => {} };
      },
      () => embed(['first probe', 'second probe']),
    );

    expect(vectors).toHaveLength(2);
    expect(seen).toHaveLength(1);
    // Exactly the shape the migration budget guard requires (positive safe integer).
    expect(Number.isSafeInteger(seen[0].maxInputTokens)).toBe(true);
    expect(seen[0].maxInputTokens!).toBeGreaterThan(0);
    // Per-input ceiling scales with the number of inputs in the sub-batch.
    const perInput = getRecipe('ollama')!.touchpoints.embedding!.max_input_tokens!['nomic-embed-text']!;
    expect(seen[0].maxInputTokens).toBe(perInput * 2);
  });
});
