/**
 * Transport-level header sweep (v0.37.2.0).
 *
 * Codex correctly noted that the IRON RULE contract tests only prove the
 * return shape of `applyResolveAuth` — they DO NOT prove that the AI SDK
 * (createOpenAICompatible) actually applies our default_headers on outgoing
 * requests. This file closes that gap by injecting a custom fetch wrapper
 * via `resolveOpenAICompatConfig` and asserting every assembled header
 * (Authorization + default_headers) reaches the wire.
 *
 * Three cases:
 *   1. embed   — SDK textEmbeddingModel path through createOpenAICompatible
 *   2. chat    — SDK languageModel path through createOpenAICompatible
 *   3. rerank  — manual HTTP path (no SDK adapter) — uses __setRerankTransportForTests
 *
 * Synthetic recipes are registered in RECIPES at beforeAll, removed at
 * afterAll — same Map-mutation pattern any future recipe-shape test can reuse.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  chat,
  rerank,
  __setRerankTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { RECIPES } from '../../src/core/ai/recipes/index.ts';
import type { Recipe } from '../../src/core/ai/types.ts';

// --- Synthetic embed recipe ---------------------------------------------------
// Bearer auth + default_headers (HTTP-Referer + X-OpenRouter-Title + X-Title).
// resolveOpenAICompatConfig injects a fetch wrapper that captures the outgoing
// request's headers + body for assertions.

let lastEmbedRequest: { url: string; headers: Record<string, string>; body: string | null } | null = null;
const fakeEmbedFetch: (input: any, init?: any) => Promise<Response> = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : (input as URL).toString();
  const headers: Record<string, string> = {};
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const body = init?.body
    ? (typeof init.body === 'string' ? init.body : null)
    : (input instanceof Request ? await input.text() : null);
  lastEmbedRequest = { url, headers, body };
  // OpenAI-compatible /embeddings response shape — one embedding for "hello".
  const json = {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 8 }, () => 0.1) }],
    model: 'fake-embed-model',
    usage: { prompt_tokens: 1, total_tokens: 1 },
  };
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const SYNTHETIC_EMBED_RECIPE: Recipe = {
  id: 'syntethic-embed-headers',
  name: 'Synthetic Embed Headers',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://synthetic.test/v1',
  auth_env: { required: ['SYNTHETIC_EMBED_KEY'] },
  touchpoints: {
    embedding: {
      models: ['fake-embed-model'],
      default_dims: 8,
      max_batch_tokens: 8192,
    },
  },
  default_headers: {
    'HTTP-Referer': 'https://gbrain.ai',
    'X-OpenRouter-Title': 'gbrain',
    'X-Title': 'gbrain',
  },
  resolveOpenAICompatConfig() {
    return {
      baseURL: 'https://synthetic.test/v1',
      fetch: fakeEmbedFetch as unknown as typeof fetch,
    };
  },
};

// --- Synthetic chat recipe ---------------------------------------------------

let lastChatRequest: { url: string; headers: Record<string, string>; body: string | null } | null = null;
const fakeChatFetch: (input: any, init?: any) => Promise<Response> = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : (input as URL).toString();
  const headers: Record<string, string> = {};
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const body = init?.body
    ? (typeof init.body === 'string' ? init.body : null)
    : (input instanceof Request ? await input.text() : null);
  lastChatRequest = { url, headers, body };
  // OpenAI-compatible /chat/completions response shape — one assistant message.
  const json = {
    id: 'fake-chat-1',
    object: 'chat.completion',
    created: 0,
    model: 'fake-chat-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const SYNTHETIC_CHAT_RECIPE: Recipe = {
  id: 'syntethic-chat-headers',
  name: 'Synthetic Chat Headers',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://synthetic.test/v1',
  auth_env: { required: ['SYNTHETIC_CHAT_KEY'] },
  touchpoints: {
    chat: {
      models: ['fake-chat-model'],
      supports_tools: false,
      supports_subagent_loop: false,
    },
  },
  default_headers: {
    'HTTP-Referer': 'https://gbrain.ai',
    'X-OpenRouter-Title': 'gbrain',
    'X-Title': 'gbrain',
  },
  resolveOpenAICompatConfig() {
    return {
      baseURL: 'https://synthetic.test/v1',
      fetch: fakeChatFetch as unknown as typeof fetch,
    };
  },
};

// --- Synthetic reranker recipe -----------------------------------------------

const SYNTHETIC_RERANK_RECIPE: Recipe = {
  id: 'syntethic-rerank-headers',
  name: 'Synthetic Rerank Headers',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://synthetic.test/v1',
  auth_env: { required: ['SYNTHETIC_RERANK_KEY'] },
  touchpoints: {
    reranker: {
      models: ['fake-rerank-model'],
      default_model: 'fake-rerank-model',
      max_payload_bytes: 5_000_000,
    },
  },
  default_headers: {
    'HTTP-Referer': 'https://gbrain.ai',
    'X-OpenRouter-Title': 'gbrain',
    'X-Title': 'gbrain',
  },
};

beforeAll(() => {
  // Register synthetic recipes for the lifetime of this test file. RECIPES is
  // a Map; .set/.delete is the natural test seam. No production-code changes
  // are required to enable test-only recipe registration.
  RECIPES.set(SYNTHETIC_EMBED_RECIPE.id, SYNTHETIC_EMBED_RECIPE);
  RECIPES.set(SYNTHETIC_CHAT_RECIPE.id, SYNTHETIC_CHAT_RECIPE);
  RECIPES.set(SYNTHETIC_RERANK_RECIPE.id, SYNTHETIC_RERANK_RECIPE);
});

afterAll(() => {
  RECIPES.delete(SYNTHETIC_EMBED_RECIPE.id);
  RECIPES.delete(SYNTHETIC_CHAT_RECIPE.id);
  RECIPES.delete(SYNTHETIC_RERANK_RECIPE.id);
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('transport-level header sweep (v0.37.2.0)', () => {
  test('1. embed — SDK applies Authorization + default_headers on every request', async () => {
    lastEmbedRequest = null;
    configureGateway({
      embedding_model: `${SYNTHETIC_EMBED_RECIPE.id}:fake-embed-model`,
      embedding_dimensions: 8,
      env: { SYNTHETIC_EMBED_KEY: 'sk-embed-fake' },
    });

    const result = await embed(['hello']);
    expect(result.length).toBe(1);
    expect(lastEmbedRequest, 'fakeEmbedFetch should have been invoked').not.toBeNull();

    const h = lastEmbedRequest!.headers;
    expect(h['authorization'], 'Authorization Bearer must be present').toBe('Bearer sk-embed-fake');
    expect(h['http-referer'], 'HTTP-Referer must reach the wire').toBe('https://gbrain.ai');
    expect(h['x-openrouter-title'], 'X-OpenRouter-Title must reach the wire').toBe('gbrain');
    expect(h['x-title'], 'X-Title (back-compat) must reach the wire').toBe('gbrain');
  });

  test('2. chat — SDK applies Authorization + default_headers on every request', async () => {
    lastChatRequest = null;
    configureGateway({
      chat_model: `${SYNTHETIC_CHAT_RECIPE.id}:fake-chat-model`,
      env: { SYNTHETIC_CHAT_KEY: 'sk-chat-fake' },
    });

    const result = await chat({
      model: `${SYNTHETIC_CHAT_RECIPE.id}:fake-chat-model`,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.text).toBe('ok');
    expect(lastChatRequest, 'fakeChatFetch should have been invoked').not.toBeNull();

    const h = lastChatRequest!.headers;
    expect(h['authorization']).toBe('Bearer sk-chat-fake');
    expect(h['http-referer']).toBe('https://gbrain.ai');
    expect(h['x-openrouter-title']).toBe('gbrain');
    expect(h['x-title']).toBe('gbrain');
  });

  test('3. rerank — manual HTTP path applies Authorization + default_headers', async () => {
    let capturedHeaders: Record<string, string> | null = null;
    __setRerankTransportForTests(async (_url, init) => {
      const hdrs: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
      capturedHeaders = hdrs;
      return new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.7 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    configureGateway({
      reranker_model: `${SYNTHETIC_RERANK_RECIPE.id}:fake-rerank-model`,
      env: { SYNTHETIC_RERANK_KEY: 'sk-rerank-fake' },
    });

    const results = await rerank({
      query: 'find relevant docs',
      documents: ['doc a', 'doc b'],
      model: `${SYNTHETIC_RERANK_RECIPE.id}:fake-rerank-model`,
    });
    expect(results.length).toBe(2);
    expect(capturedHeaders, 'rerank transport stub should have been invoked').not.toBeNull();

    const h = capturedHeaders!;
    expect(h['authorization'], 'rerank: Authorization Bearer must be present').toBe('Bearer sk-rerank-fake');
    expect(h['http-referer'], 'rerank: HTTP-Referer must reach the wire').toBe('https://gbrain.ai');
    expect(h['x-openrouter-title']).toBe('gbrain');
    expect(h['x-title']).toBe('gbrain');
    expect(h['content-type']).toBe('application/json');
  });
});
