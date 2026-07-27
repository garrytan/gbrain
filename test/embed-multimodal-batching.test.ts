// Commit 0 (D4 + D22-2): batching + partial-failure for multimodal embed,
// plus query-side helpers (embedQueryMultimodal, embedQueryMultimodalImage).
//
// Covers:
//   - Voyage text variant (mixed text+image content arrays)
//   - inputType: 'query' threaded through to Voyage wire format
//   - embedMultimodalSafe binary-search retry on transient failure
//   - embedMultimodalSafe surfaces failed_indices when individual inputs fail
//   - embedMultimodalSafe stops on AIConfigError (permanent misconfig)
//   - embedQueryMultimodal returns 1024-dim vector
//   - embedQueryMultimodalImage returns 1024-dim vector

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  embedMultimodal,
  embedMultimodalSafe,
  embedQueryMultimodal,
  embedQueryMultimodalImage,
  resetGateway,
} from '../src/core/ai/gateway.ts';

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
const origFetch = globalThis.fetch;

beforeEach(() => {
  fetchHandler = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) throw new Error('fetch called but no handler installed');
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

function configureVoyage(env: Record<string, string | undefined> = {}) {
  configureGateway({
    embedding_model: 'voyage:voyage-multimodal-3',
    embedding_dimensions: 1024,
    env: { VOYAGE_API_KEY: 'test-key', ...env },
  });
}

function fakeResponse(count: number, dims = 1024): Response {
  const data = Array.from({ length: count }, (_, i) => ({
    embedding: Array.from({ length: dims }, () => 0.1 * (i + 1)),
    index: i,
  }));
  return new Response(JSON.stringify({ data, model: 'voyage-multimodal-3' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeImg() {
  return {
    kind: 'image_base64' as const,
    data: Buffer.from('fake').toString('base64'),
    mime: 'image/jpeg',
  };
}

describe('Voyage multimodal — text variant + inputType discipline', () => {
  test('text input variant sends correct Voyage content shape', async () => {
    configureVoyage();
    let capturedBody: any;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return fakeResponse(1);
    };
    const vecs = await embedMultimodal([{ kind: 'text', text: 'hello world' }]);
    expect(vecs.length).toBe(1);
    expect(vecs[0]).toBeInstanceOf(Float32Array);
    expect(capturedBody.inputs[0].content[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  test('opts.inputType="query" threads through to Voyage wire body', async () => {
    configureVoyage();
    let capturedBody: any;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return fakeResponse(1);
    };
    await embedMultimodal([{ kind: 'text', text: 'q' }], { inputType: 'query' });
    expect(capturedBody.input_type).toBe('query');
  });

  test('default inputType is "document" (preserves pre-v0.36 ingest behavior)', async () => {
    configureVoyage();
    let capturedBody: any;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return fakeResponse(1);
    };
    await embedMultimodal([makeImg()]);
    expect(capturedBody.input_type).toBe('document');
  });

  test('mixed text + image inputs in one batch — each gets correct content type', async () => {
    configureVoyage();
    let capturedBody: any;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return fakeResponse(2);
    };
    await embedMultimodal([
      { kind: 'text', text: 'hello' },
      makeImg(),
    ]);
    expect(capturedBody.inputs[0].content[0].type).toBe('text');
    expect(capturedBody.inputs[1].content[0].type).toBe('image_base64');
  });
});

describe('embedQueryMultimodal — text query path', () => {
  test('returns 1024-dim Float32Array via Voyage query embed', async () => {
    configureVoyage();
    fetchHandler = async () => fakeResponse(1, 1024);
    const v = await embedQueryMultimodal('hackathon photos');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(1024);
  });

  test('threads inputType="query" to the wire', async () => {
    configureVoyage();
    let capturedBody: any;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return fakeResponse(1);
    };
    await embedQueryMultimodal('q');
    expect(capturedBody.input_type).toBe('query');
    expect(capturedBody.inputs[0].content[0]).toEqual({ type: 'text', text: 'q' });
  });
});

describe('embedQueryMultimodalImage — image query path', () => {
  test('returns 1024-dim Float32Array via Voyage image-query embed', async () => {
    configureVoyage();
    fetchHandler = async () => fakeResponse(1, 1024);
    const v = await embedQueryMultimodalImage({
      data: Buffer.from('fake').toString('base64'),
      mime: 'image/png',
    });
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(1024);
  });

  test('threads inputType="query" + image_base64 shape to the wire', async () => {
    configureVoyage();
    let capturedBody: any;
    fetchHandler = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return fakeResponse(1);
    };
    await embedQueryMultimodalImage({
      data: Buffer.from('xyz').toString('base64'),
      mime: 'image/webp',
    });
    expect(capturedBody.input_type).toBe('query');
    expect(capturedBody.inputs[0].content[0].type).toBe('image_base64');
    expect(capturedBody.inputs[0].content[0].image_base64).toContain('data:image/webp;base64,');
  });
});

describe('embedMultimodalSafe — partial-failure surfacing', () => {
  test('happy path returns full embeddings array, no failed indices', async () => {
    configureVoyage();
    fetchHandler = async () => fakeResponse(3);
    const result = await embedMultimodalSafe([makeImg(), makeImg(), makeImg()]);
    expect(result.failedIndices).toEqual([]);
    expect(result.embeddings.length).toBe(3);
    expect(result.embeddings.every(v => v instanceof Float32Array)).toBe(true);
  });

  test('empty input array returns empty result without HTTP call', async () => {
    configureVoyage();
    fetchHandler = async () => {
      throw new Error('should not be called');
    };
    const result = await embedMultimodalSafe([]);
    expect(result.failedIndices).toEqual([]);
    expect(result.embeddings).toEqual([]);
  });

  test('all-fail batch records every input as failed', async () => {
    configureVoyage();
    let callCount = 0;
    fetchHandler = async () => {
      callCount++;
      return new Response('rate limited', { status: 429 });
    };
    const result = await embedMultimodalSafe([makeImg(), makeImg()]);
    expect(result.failedIndices).toEqual([0, 1]);
    expect(result.embeddings).toEqual([undefined, undefined]);
    expect(result.lastError).toBeDefined();
    // Binary-search retry: tries [0,1] then [0] then [1] = 3 calls
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test('mid-batch failure: binary-search retry recovers good inputs', async () => {
    configureVoyage();
    // Strategy: track which inputs were sent in each batch by hashing the
    // request body. Input index 2 always fails when sent solo; other splits succeed.
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string);
      const requestSize = body.inputs.length;
      // Any batch containing TARGET2 fails transiently — forces the binary-search
      // split until input 2 is isolated, at which point single-input fail is recorded.
      const containsTarget = body.inputs.some((inp: any) =>
        inp.content?.[0]?.image_base64?.includes('VEFSR0VUMg'),
      );
      if (containsTarget) {
        return new Response('contains-target-fail', { status: 503 });
      }
      return fakeResponse(requestSize);
    };
    const inputs = [
      makeImg(),
      makeImg(),
      { kind: 'image_base64' as const, data: Buffer.from('TARGET2').toString('base64'), mime: 'image/jpeg' },
    ];
    const result = await embedMultimodalSafe(inputs);
    // Inputs 0,1 should succeed via the binary-search split; input 2 fails permanently
    expect(result.failedIndices).toEqual([2]);
    expect(result.embeddings[0]).toBeInstanceOf(Float32Array);
    expect(result.embeddings[1]).toBeInstanceOf(Float32Array);
    expect(result.embeddings[2]).toBeUndefined();
  });

  test('AIConfigError (permanent) fails fast without binary-search retry', async () => {
    configureVoyage();
    let callCount = 0;
    fetchHandler = async () => {
      callCount++;
      return new Response('unauthorized', { status: 401 });
    };
    const result = await embedMultimodalSafe([makeImg(), makeImg(), makeImg(), makeImg()]);
    // AIConfigError (401) is permanent — no point in binary-search retry.
    // All 4 inputs should be reported as failed after the single call.
    expect(result.failedIndices).toEqual([0, 1, 2, 3]);
    expect(callCount).toBe(1);
    expect(result.lastError?.message).toContain('401');
  });
});
