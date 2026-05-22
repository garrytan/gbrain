// Commit 4 integration: hybridSearch escalation gate fires only when
// (config flag on) + (regex returned 'text') + (isAmbiguousModalityQuery true).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

let engine: PGLiteEngine;
const origFetch = globalThis.fetch;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('multimodalembeddings')) {
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    }
    // Default OpenAI text embed response.
    return new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
    }), { status: 200 });
  }) as typeof fetch;
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    env: { OPENAI_API_KEY: 'test', VOYAGE_API_KEY: 'test', ANTHROPIC_API_KEY: 'test' },
  });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
  __setChatTransportForTests(null);
});

describe('hybridSearch LLM intent escalation gate (Commit 4)', () => {
  test('flag OFF + ambiguous query → no LLM call (default behavior)', async () => {
    let chatCalled = 0;
    __setChatTransportForTests(async () => {
      chatCalled++;
      return { text: 'image', blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'x', providerId: 'x' };
    });
    // Flag NOT set → default false.
    await hybridSearch(engine, 'the chart', { limit: 5 });
    expect(chatCalled).toBe(0);
  });

  test('flag ON + ambiguous query → ONE LLM call', async () => {
    await engine.setConfig('search.cross_modal.llm_intent', 'true');
    let chatCalled = 0;
    __setChatTransportForTests(async () => {
      chatCalled++;
      return { text: 'image', blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'x', providerId: 'x' };
    });
    await hybridSearch(engine, 'the chart', { limit: 5 });
    expect(chatCalled).toBe(1);
  });

  test('flag ON + unambiguous text query → no LLM call', async () => {
    await engine.setConfig('search.cross_modal.llm_intent', 'true');
    let chatCalled = 0;
    __setChatTransportForTests(async () => {
      chatCalled++;
      return { text: 'image', blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'x', providerId: 'x' };
    });
    await hybridSearch(engine, 'what is founder mode', { limit: 5 });
    expect(chatCalled).toBe(0);
  });

  test('flag ON + regex-confident image query → no LLM call (regex already classified)', async () => {
    await engine.setConfig('search.cross_modal.llm_intent', 'true');
    let chatCalled = 0;
    __setChatTransportForTests(async () => {
      chatCalled++;
      return { text: 'image', blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'x', providerId: 'x' };
    });
    // Strong regex match: "show me photos from X" → already image.
    await hybridSearch(engine, 'show me photos from the hackathon', { limit: 5 });
    // No tie-break needed when regex is already confident.
    expect(chatCalled).toBe(0);
  });

  test('flag ON + explicit crossModal opt → no LLM call (per-call opt wins)', async () => {
    await engine.setConfig('search.cross_modal.llm_intent', 'true');
    let chatCalled = 0;
    __setChatTransportForTests(async () => {
      chatCalled++;
      return { text: 'image', blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'x', providerId: 'x' };
    });
    // Caller passed explicit crossModal — no need to tie-break.
    await hybridSearch(engine, 'the chart', { crossModal: 'text', limit: 5 });
    expect(chatCalled).toBe(0);
  });

  test('flag ON + ambiguous + LLM throws → falls back to regex result (text)', async () => {
    await engine.setConfig('search.cross_modal.llm_intent', 'true');
    __setChatTransportForTests(async () => {
      throw new Error('LLM unavailable');
    });
    // Should not throw — fail-open to regex result.
    const results = await hybridSearch(engine, 'the chart', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });
});
