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
 * query was encoded document-side (a document-side default) or with no
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

describe('openai-compatible recipes (local/proxy asymmetric models) — input_type reaches the wire body', () => {
  function configureLlamaServer(modelId: string, dims: number) {
    configureGateway({
      embedding_model: `llama-server:${modelId}`,
      embedding_dimensions: dims,
      env: {},
    });
  }

  test('embedQuery against a local voyage-4 sends input_type=query', async () => {
    configureLlamaServer('voyage-4', 1024);
    let capturedUrl = '';
    let capturedBody: any = null;
    fetchHandler = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1024, 1);
    };

    await embedQuery('what does foo bar do?');
    // URL untouched — llama-server's /v1/embeddings is already OpenAI-shaped.
    expect(capturedUrl).toContain('/embeddings');
    expect(capturedUrl).not.toContain('/models/embed');
    expect(capturedBody.input_type).toBe('query');
  });

  test('embed (index path) against a local voyage-4 sends input_type=document', async () => {
    configureLlamaServer('voyage-4', 1024);
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1024, 1);
    };

    await embed(['this is a document being indexed'], { inputType: 'document' });
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
    // model id, so a voyage-4 behind a LiteLLM proxy (e.g. fronting vLLM)
    // gets the same signal as llama-server.
    configureGateway({
      embedding_model: 'litellm:voyage-4',
      embedding_dimensions: 1024,
      env: { LITELLM_API_KEY: 'sk-fake' },
      base_urls: { litellm: 'http://localhost:4000' },
    });
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1024, 1);
    };

    await embedQuery('what does foo bar do?');
    expect(capturedBody.input_type).toBe('query');
  });

  test('ollama serving an asymmetric model: embedQuery sends input_type=query', async () => {
    configureGateway({
      embedding_model: 'ollama:voyage-4',
      embedding_dimensions: 1024,
      env: {},
    });
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1024, 1);
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

describe('#5543: Qwen3-Embedding on self-hosted openai-compatible — instruction reaches the wire', () => {
  const defaultPrefix = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';

  test('llama-server: embedQuery sends input_type=query AND the instruction prefix in the text', async () => {
    configureGateway({
      embedding_model: 'llama-server:qwen3-embedding-0.6b',
      embedding_dimensions: 1024,
      env: {},
    });
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1024, 1);
    };

    await embedQuery('what does foo bar do?');
    expect(capturedBody.input_type).toBe('query');
    // Native width: no `dimensions` on the wire (vLLM 400s on it).
    expect('dimensions' in capturedBody).toBe(false);
    const inputs: string[] = Array.isArray(capturedBody.input) ? capturedBody.input : [capturedBody.input];
    expect(inputs).toEqual([`${defaultPrefix}what does foo bar do?`]);
  });

  test('ollama colon-tag form: same signal, and documents go out raw', async () => {
    configureGateway({
      embedding_model: 'ollama:qwen3-embedding:0.6b',
      embedding_dimensions: 1024,
      env: {},
    });
    const bodies: any[] = [];
    fetchHandler = async (_url, init) => {
      bodies.push(JSON.parse(init.body as string));
      return openAIShapedResponse(1024, 1);
    };

    await embedQuery('where are the meeting notes?');
    await embed(['# Meeting notes\n\nraw chunk body'], { inputType: 'document' });

    expect(bodies).toHaveLength(2);
    const [q, d] = bodies;
    expect(q.input_type).toBe('query');
    const qInputs: string[] = Array.isArray(q.input) ? q.input : [q.input];
    expect(qInputs[0].startsWith(defaultPrefix)).toBe(true);
    expect(d.input_type).toBe('document');
    const dInputs: string[] = Array.isArray(d.input) ? d.input : [d.input];
    expect(dInputs).toEqual(['# Meeting notes\n\nraw chunk body']);
  });

  test('embedding_query_instruct="" disables the prefix but keeps input_type threaded', async () => {
    configureGateway({
      embedding_model: 'llama-server:qwen3-embedding-0.6b',
      embedding_dimensions: 1024,
      embedding_query_instruct: '',
      env: {},
    });
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1024, 1);
    };

    await embedQuery('what does foo bar do?');
    expect(capturedBody.input_type).toBe('query');
    const inputs: string[] = Array.isArray(capturedBody.input) ? capturedBody.input : [capturedBody.input];
    expect(inputs).toEqual(['what does foo bar do?']);
  });

  test('embedding_query_instruct overrides the task line', async () => {
    configureGateway({
      embedding_model: 'llama-server:qwen3-embedding-0.6b',
      embedding_dimensions: 1024,
      embedding_query_instruct: 'Retrieve the personal note that answers the question',
      env: {},
    });
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1024, 1);
    };

    await embedQuery('what does foo bar do?');
    const inputs: string[] = Array.isArray(capturedBody.input) ? capturedBody.input : [capturedBody.input];
    expect(inputs).toEqual(['Instruct: Retrieve the personal note that answers the question\nQuery: what does foo bar do?']);
  });

  test('non-Qwen3 local model is untouched: no prefix, no input_type', async () => {
    configureGateway({
      embedding_model: 'llama-server:bge-m3',
      embedding_dimensions: 1024,
      env: {},
    });
    let capturedBody: any = null;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return openAIShapedResponse(1024, 1);
    };

    await embedQuery('what does foo bar do?');
    expect('input_type' in capturedBody).toBe(false);
    const inputs: string[] = Array.isArray(capturedBody.input) ? capturedBody.input : [capturedBody.input];
    expect(inputs).toEqual(['what does foo bar do?']);
  });
});
