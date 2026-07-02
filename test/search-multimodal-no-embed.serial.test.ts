// Regression: no-embedding-provider early-return must be multimodal-aware.
//
// On a multimodal-only install (text embedding provider ABSENT, a multimodal
// provider such as Voyage multimodal-3 PRESENT), hybridSearch's
// no-embedding-provider short-circuit used to probe ONLY the text column's
// provider. Since that provider is unreachable, search returned to the
// keyword-only path (vector_enabled:false) BEFORE the image/unified vector
// routing below ever ran — so image and unified queries silently degraded to
// keyword search even though a usable multimodal vector path existed.
//
// The fix adds a `willTryMultimodal` guard that also probes the multimodal
// provider so the early-return does not fire when multimodal vectoring is
// still possible. These tests assert that the multimodal (Voyage) embedding
// endpoint is actually reached on a text-provider-absent install.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

let engine: PGLiteEngine;
let fetchHandler: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
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
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) throw new Error('no fetch handler');
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;

  // Multimodal-only install: a text embedding model is *configured* but its
  // required auth env (OPENAI_API_KEY) is ABSENT, so the text provider is
  // unreachable. The multimodal provider (Voyage) IS reachable (VOYAGE_API_KEY
  // present). This is exactly the install shape the fix targets.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    env: { VOYAGE_API_KEY: 'test' },
  });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
  fetchHandler = null;
});

describe('multimodal-only install: no-embedding early-return is multimodal-aware', () => {
  test('image query still reaches the multimodal vector path (does not short-circuit to keyword)', async () => {
    let voyageCalled = 0;
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        voyageCalled++;
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
        }), { status: 200 });
      }
      if (url.includes('api.openai.com') && url.includes('embeddings')) {
        openaiCalled++;
      }
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    const results = await hybridSearch(engine, 'a photo of a red bicycle', {
      limit: 5,
      crossModal: 'image',
    });

    // Pre-fix: the text-provider probe failed → early-return → Voyage never
    // called. Post-fix: the image branch runs and embeds via the multimodal
    // (Voyage) provider.
    expect(voyageCalled).toBeGreaterThanOrEqual(1);
    // The unreachable text provider must never have been dialed.
    expect(openaiCalled).toBe(0);
    expect(Array.isArray(results)).toBe(true);
  });

  test('unified_multimodal routing reaches the multimodal vector path on a text-provider-absent install', async () => {
    await engine.setConfig('search.unified_multimodal', 'true');
    let voyageCalled = 0;
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        voyageCalled++;
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
        }), { status: 200 });
      }
      if (url.includes('api.openai.com') && url.includes('embeddings')) {
        openaiCalled++;
      }
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    await hybridSearch(engine, 'totally text query', { limit: 5 });

    // Unified routing forces the multimodal endpoint even for a text-shaped
    // query; pre-fix the early-return fired first and Voyage was never called.
    expect(voyageCalled).toBeGreaterThanOrEqual(1);
    expect(openaiCalled).toBe(0);
  });
});
