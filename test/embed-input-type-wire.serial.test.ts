/**
 * #1400 — asymmetric `input_type` must survive the AI SDK boundary and
 * reach the WIRE BODY.
 *
 * test/asymmetric-encoding-contract.test.ts pins that embedQuery() threads
 * `input_type: 'query'` into the transport's providerOptions. This file
 * pins the layer BELOW that contract: the AI SDK's openai-compatible
 * adapter validates providerOptions against a fixed schema and silently
 * drops `input_type` before building the HTTP body. Without the
 * `__embedInputTypeStore` recovery in the per-recipe fetch shims, every
 * query was encoded document-side (ZE shim's hard default) or with no
 * input_type at all (Voyage, llama-server) — asymmetric retrieval silently
 * collapsed while the providerOptions-level test stayed green.
 *
 * These tests run the REAL SDK transport with a mocked global fetch and
 * assert on the outbound request body — the only place the regression is
 * observable.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, embed, embedQuery, resetGateway } from '../src/core/ai/gateway.ts';

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
const origFetch = globalThis.fetch;

beforeEach(() => {
  fetchHandler = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) {
      throw new Error('fetch called but no handler installed');
    }
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

/** OpenAI-shaped /v1/embeddings response (llama-server is already OpenAI-shaped). */
function openAIShapedResponse(dims: number, count: number): Response {
  const vec = Array.from({ length: dims }, () => 0.1);
  return new Response(
    JSON.stringify({
      data: Array.from({ length: count }, (_, i) => ({ object: 'embedding', index: i, embedding: vec })),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** ZE-shaped /v1/models/embed response (zeroEntropyCompatFetch rewrites results→data). */
function zeShapedResponse(dims: number, count: number): Response {
  const vec = Array.from({ length: dims }, () => 0.1);
  return new Response(
    JSON.stringify({
      results: Array.from({ length: count }, () => ({ embedding: vec })),
      usage: { total_bytes: 12, total_tokens: 3 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Voyage-shaped response: base64 Float32 LE embeddings (rewriter decodes). */
function voyageShapedResponse(dims: number, count: number): Response {
  const b64 = Buffer.from(new Float32Array(dims).fill(0.1).buffer).toString('base64');
  return new Response(
    JSON.stringify({
      data: Array.from({ length: count }, (_, i) => ({ object: 'embedding', index: i, embedding: b64 })),
      usage: { total_tokens: 3 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('ZeroEntropy hosted — input_type reaches the wire body', () => {
  function configureZE() {
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ZEROENTROPY_API_KEY: 'sk-fake' },
    });
  }

  test('embedQuery sends input_type=query (not the document default)', async () => {
    configureZE();
    let capturedUrl = '';
    let capturedBody: any = null;
    fetchHandler = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return zeShapedResponse(1280, 1);
    };

    await embedQuery('what does foo bar do?');
    // Sanity: the ZE shim ran (URL path rewritten).
    expect(capturedUrl).toContain('/models/embed');
    expect(capturedBody.input_type).toBe('query');
  });

  test('embed (index path) sends input_type=document', async () => {
    configureZE();
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return zeShapedResponse(1280, 1);
    };

    await embed(['this is a document being indexed']);
    expect(capturedBody.input_type).toBe('document');
  });
});

describe('openai-compatible recipes (local/proxy asymmetric models) — input_type reaches the wire body', () => {
  function configureLlamaServer(modelId: string, dims: number) {
    configureGateway({
      embedding_model: `llama-server:${modelId}`,
      embedding_dimensions: dims,
      env: {},
    });
  }

  test('embedQuery against a local zembed-1 sends input_type=query', async () => {
    configureLlamaServer('zembed-1', 1280);
    let capturedUrl = '';
    let capturedBody: any = null;
    fetchHandler = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1280, 1);
    };

    await embedQuery('what does foo bar do?');
    // URL untouched — llama-server's /v1/embeddings is already OpenAI-shaped.
    expect(capturedUrl).toContain('/embeddings');
    expect(capturedUrl).not.toContain('/models/embed');
    expect(capturedBody.input_type).toBe('query');
  });

  test('embed (index path) against a local zembed-1 sends input_type=document', async () => {
    configureLlamaServer('zembed-1', 1280);
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1280, 1);
    };

    await embed(['this is a document being indexed']);
    expect(capturedBody.input_type).toBe('document');
  });

  test('non-asymmetric model: wire body carries NO input_type (strict pass-through)', async () => {
    // dims.ts only threads input_type for recognized asymmetric models;
    // for anything else the shim must leave the body untouched so vanilla
    // llama-server deployments see zero wire change.
    configureLlamaServer('my-gguf', 768);
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(768, 1);
    };

    await embedQuery('hello');
    expect(capturedBody).not.toBeNull();
    expect('input_type' in capturedBody).toBe(false);
  });

  test('litellm proxying an asymmetric model: embedQuery sends input_type=query', async () => {
    // The shim is the fallthrough default for every openai-compatible
    // recipe without its own compat fetch — dims.ts threads input_type by
    // model id, so a zembed-1 behind a LiteLLM proxy (e.g. fronting vLLM)
    // gets the same signal as llama-server.
    configureGateway({
      embedding_model: 'litellm:zembed-1',
      embedding_dimensions: 1280,
      env: { LITELLM_API_KEY: 'sk-fake' },
      base_urls: { litellm: 'http://localhost:4000' },
    });
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1280, 1);
    };

    await embedQuery('what does foo bar do?');
    expect(capturedBody.input_type).toBe('query');
  });

  test('ollama serving an asymmetric model: embedQuery sends input_type=query', async () => {
    configureGateway({
      embedding_model: 'ollama:zembed-1',
      embedding_dimensions: 1280,
      env: {},
    });
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1280, 1);
    };

    await embedQuery('what does foo bar do?');
    expect(capturedBody.input_type).toBe('query');
  });
});

describe('Voyage hosted — input_type reaches the wire body (opt-in preserved)', () => {
  function configureVoyage() {
    configureGateway({
      embedding_model: 'voyage:voyage-3-large',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: 'sk-fake' },
    });
  }

  test('embedQuery sends input_type=query', async () => {
    configureVoyage();
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return voyageShapedResponse(1024, 1);
    };

    await embedQuery('what does foo bar do?');
    expect(capturedBody.input_type).toBe('query');
    // Existing voyage translation still applies on the same body.
    expect(capturedBody.output_dimension).toBe(1024);
    expect(capturedBody.encoding_format).toBe('base64');
  });

  test('embed (index path) keeps input_type OFF the wire (pre-v0.35.0.0 opt-in shape)', async () => {
    // dims.ts deliberately emits no input_type for Voyage unless threaded
    // (`...(inputType ? { input_type: inputType } : {})`); the shim must
    // not invent a default for it.
    configureVoyage();
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return voyageShapedResponse(1024, 1);
    };

    await embed(['this is a document being indexed']);
    expect(capturedBody).not.toBeNull();
    expect('input_type' in capturedBody).toBe(false);
  });
});
