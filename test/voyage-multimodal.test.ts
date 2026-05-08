// Phase 6 (D1-D3) + Eng-3A: voyage-multimodal-3 recipe + gateway.embedMultimodal.
//
// Verifies recipe registration, gateway happy-path with mocked fetch,
// 401 / 429 / dim-mismatch error paths, and the off-by-one batch math
// (n=0, n=1, n=32, n=33, n=64) flagged by Eng-3A.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, embedMultimodal, resetGateway } from '../src/core/ai/gateway.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { AIConfigError, AITransientError } from '../src/core/ai/errors.ts';

// Capture all fetch calls. Each test installs a fresh handler and asserts
// the request shape AND returns a plausible Voyage payload.
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

function configureVoyageMultimodal(env: Record<string, string | undefined> = {}) {
  configureGateway({
    embedding_model: 'voyage:voyage-multimodal-3',
    embedding_dimensions: 1024,
    env: { VOYAGE_API_KEY: 'test-key', ...env },
  });
}

function makeImage(mimeOverride?: string) {
  return {
    kind: 'image_base64' as const,
    data: Buffer.from('fake-image-bytes').toString('base64'),
    mime: mimeOverride ?? 'image/jpeg',
  };
}

function fakeVoyageResponse(count: number, dims = 1024): Response {
  const data = Array.from({ length: count }, (_, i) => ({
    embedding: Array.from({ length: dims }, () => 0.1 * (i + 1)),
    index: i,
  }));
  return new Response(JSON.stringify({ data, model: 'voyage-multimodal-3' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('voyage recipe — multimodal registration', () => {
  test('voyage-multimodal-3 is in the recipe model list', () => {
    const voyage = getRecipe('voyage');
    expect(voyage).toBeDefined();
    expect(voyage!.touchpoints.embedding!.models).toContain('voyage-multimodal-3');
  });

  test('voyage embedding touchpoint declares supports_multimodal: true', () => {
    const voyage = getRecipe('voyage');
    expect(voyage!.touchpoints.embedding!.supports_multimodal).toBe(true);
  });

  test('voyage default_dims is 1024 (parity with multimodal output dim)', () => {
    const voyage = getRecipe('voyage');
    expect(voyage!.touchpoints.embedding!.default_dims).toBe(1024);
  });
});

describe('gateway.embedMultimodal — happy path', () => {
  test('single image produces a 1024-dim Float32Array', async () => {
    configureVoyageMultimodal();
    fetchHandler = async (url, init) => {
      expect(url).toContain('/multimodalembeddings');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('voyage-multimodal-3');
      expect(body.inputs.length).toBe(1);
      expect(body.inputs[0].content[0].type).toBe('image_base64');
      expect(body.inputs[0].content[0].image_base64).toContain('data:image/jpeg;base64,');
      return fakeVoyageResponse(1);
    };
    const out = await embedMultimodal([makeImage()]);
    expect(out.length).toBe(1);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0].length).toBe(1024);
  });

  test('Authorization header is set with bearer token', async () => {
    configureVoyageMultimodal();
    let captured: Record<string, string> = {};
    fetchHandler = async (_url, init) => {
      captured = init.headers as Record<string, string>;
      return fakeVoyageResponse(1);
    };
    await embedMultimodal([makeImage()]);
    expect(captured.Authorization).toBe('Bearer test-key');
    expect(captured['Content-Type']).toBe('application/json');
  });
});

describe('gateway.embedMultimodal — Eng-3A batch boundary tests', () => {
  test('n=0 short-circuits: returns [] without calling fetch', async () => {
    configureVoyageMultimodal();
    let called = false;
    fetchHandler = async () => {
      called = true;
      return fakeVoyageResponse(0);
    };
    const out = await embedMultimodal([]);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test('n=1: single batch, single embedding back', async () => {
    configureVoyageMultimodal();
    let calls = 0;
    fetchHandler = async () => {
      calls++;
      return fakeVoyageResponse(1);
    };
    const out = await embedMultimodal([makeImage()]);
    expect(out.length).toBe(1);
    expect(calls).toBe(1);
  });

  test('n=32 (exact batch): one HTTP call', async () => {
    configureVoyageMultimodal();
    let calls = 0;
    fetchHandler = async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body as string);
      expect(body.inputs.length).toBe(32);
      return fakeVoyageResponse(body.inputs.length);
    };
    const out = await embedMultimodal(Array.from({ length: 32 }, () => makeImage()));
    expect(out.length).toBe(32);
    expect(calls).toBe(1);
  });

  test('n=33 (off-by-one): two HTTP calls, sizes 32 + 1', async () => {
    configureVoyageMultimodal();
    const seenSizes: number[] = [];
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string);
      seenSizes.push(body.inputs.length);
      return fakeVoyageResponse(body.inputs.length);
    };
    const out = await embedMultimodal(Array.from({ length: 33 }, () => makeImage()));
    expect(out.length).toBe(33);
    expect(seenSizes).toEqual([32, 1]);
  });

  test('n=64 (clean two batches): two calls of 32', async () => {
    configureVoyageMultimodal();
    const seenSizes: number[] = [];
    fetchHandler = async (_url, init) => {
      const body = JSON.parse(init.body as string);
      seenSizes.push(body.inputs.length);
      return fakeVoyageResponse(body.inputs.length);
    };
    const out = await embedMultimodal(Array.from({ length: 64 }, () => makeImage()));
    expect(out.length).toBe(64);
    expect(seenSizes).toEqual([32, 32]);
  });
});

describe('gateway.embedMultimodal — error paths', () => {
  test('401 → AIConfigError with auth fix hint', async () => {
    configureVoyageMultimodal();
    fetchHandler = async () => new Response('{"error":"unauthorized"}', { status: 401 });
    let err: unknown;
    try {
      await embedMultimodal([makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as AIConfigError).message).toContain('401');
  });

  test('429 → AITransientError', async () => {
    configureVoyageMultimodal();
    fetchHandler = async () => new Response('rate limited', { status: 429 });
    let err: unknown;
    try {
      await embedMultimodal([makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AITransientError);
  });

  test('5xx → AITransientError', async () => {
    configureVoyageMultimodal();
    fetchHandler = async () => new Response('server error', { status: 503 });
    let err: unknown;
    try {
      await embedMultimodal([makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AITransientError);
  });

  test('dim mismatch → AIConfigError', async () => {
    configureVoyageMultimodal();
    fetchHandler = async () => fakeVoyageResponse(1, 768); // wrong dim
    let err: unknown;
    try {
      await embedMultimodal([makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as AIConfigError).message).toContain('1024');
  });

  test('malformed JSON → AITransientError', async () => {
    configureVoyageMultimodal();
    fetchHandler = async () =>
      new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } });
    let err: unknown;
    try {
      await embedMultimodal([makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AITransientError);
  });

  test('embedding count mismatch → AITransientError', async () => {
    configureVoyageMultimodal();
    fetchHandler = async () => fakeVoyageResponse(1); // returns 1, sent 2
    let err: unknown;
    try {
      await embedMultimodal([makeImage(), makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AITransientError);
  });

  test('missing API key → AIConfigError', async () => {
    configureGateway({
      embedding_model: 'voyage:voyage-multimodal-3',
      embedding_dimensions: 1024,
      env: {}, // no VOYAGE_API_KEY
    });
    fetchHandler = async () => fakeVoyageResponse(1); // never called
    let err: unknown;
    try {
      await embedMultimodal([makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as AIConfigError).message).toContain('VOYAGE_API_KEY');
  });

  test('non-multimodal recipe → AIConfigError', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    let err: unknown;
    try {
      await embedMultimodal([makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as AIConfigError).message).toMatch(/does not support multimodal|not implemented/i);
  });
});

// v0.28.11 (PR #719): embedding_multimodal_model override + model-level
// validation. Confirms the gateway's two-layer multimodal gate:
//   1. recipe.touchpoints.embedding.supports_multimodal (recipe scope)
//   2. recipe.touchpoints.embedding.multimodal_models[] (model scope)
describe('gateway.embedMultimodal — multimodal_model override + model-level validation', () => {
  test('prefers embedding_multimodal_model over embedding_model when both set', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      embedding_multimodal_model: 'voyage:voyage-multimodal-3',
      env: { VOYAGE_API_KEY: 'voyage-key', OPENAI_API_KEY: 'sk-test' },
    });
    let capturedUrl = '';
    let capturedBody: { model?: string } = {};
    fetchHandler = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return fakeVoyageResponse(1);
    };
    const out = await embedMultimodal([makeImage()]);
    expect(out.length).toBe(1);
    expect(capturedUrl).toContain('/multimodalembeddings');
    expect(capturedBody.model).toBe('voyage-multimodal-3');
  });

  test('falls back to embedding_model when embedding_multimodal_model is unset', async () => {
    // Regression guard for the existing single-model setup.
    configureVoyageMultimodal();
    fetchHandler = async () => fakeVoyageResponse(1);
    const out = await embedMultimodal([makeImage()]);
    expect(out.length).toBe(1);
  });

  test('embedding_multimodal_model pointing at non-multimodal recipe → AIConfigError', async () => {
    configureGateway({
      embedding_model: 'voyage:voyage-multimodal-3', // would normally work
      embedding_multimodal_model: 'openai:text-embedding-3-large', // override breaks it
      embedding_dimensions: 1536,
      env: { VOYAGE_API_KEY: 'voyage-key', OPENAI_API_KEY: 'sk-test' },
    });
    let err: unknown;
    try {
      await embedMultimodal([makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as AIConfigError).message).toMatch(/does not support multimodal/i);
  });

  test('embedding_multimodal_model pointing at Voyage text-only model → AIConfigError (D4 / Codex F1)', async () => {
    // Voyage shares supports_multimodal: true across all 12 models in the
    // recipe. Without the model-level multimodal_models gate, voyage-3-large
    // would pass validation locally and fail at /multimodalembeddings with
    // HTTP 400 — which gateway.ts:626 misclassifies as transient. Change 3
    // closes this gap.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      embedding_multimodal_model: 'voyage:voyage-3-large', // text-only Voyage
      env: { VOYAGE_API_KEY: 'voyage-key', OPENAI_API_KEY: 'sk-test' },
    });
    let err: unknown;
    try {
      await embedMultimodal([makeImage()]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIConfigError);
    expect((err as AIConfigError).message).toMatch(/voyage-3-large.*not.*multimodal/i);
    expect((err as AIConfigError).fix ?? '').toMatch(/voyage:voyage-multimodal-3/);
  });
});
