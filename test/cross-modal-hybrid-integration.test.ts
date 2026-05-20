// Phase 1 integration test — hybridSearch cross-modal routing.
//
// Uses real PGLite + stubbed gateway fetch. Verifies the routing decisions
// from query-intent through hybrid.ts to engine.searchVector with the
// correct embeddingColumn.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';

let engine: PGLiteEngine;

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
const origFetch = globalThis.fetch;
let fetchUrlsSeen: string[] = [];
let fetchBodiesSeen: any[] = [];

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
  fetchHandler = null;
  fetchUrlsSeen = [];
  fetchBodiesSeen = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    fetchUrlsSeen.push(u);
    if (init?.body) {
      try { fetchBodiesSeen.push(JSON.parse(init.body as string)); } catch { /* ignore */ }
    }
    if (!fetchHandler) {
      // Return a generic 1024-dim Voyage-shape response by default
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
        model: 'voyage-multimodal-3',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return fetchHandler(u, init ?? {});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

function configureBoth() {
  // Gateway needs BOTH text and multimodal models configured. Use a single
  // openai recipe stub for text — we won't hit it for image-only queries.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    env: {
      OPENAI_API_KEY: 'test-key',
      VOYAGE_API_KEY: 'voyage-test-key',
    },
  });
}

describe('hybridSearch cross-modal routing (Phase 1 integration)', () => {
  test("explicit crossModal: 'image' calls Voyage multimodal endpoint, NOT OpenAI", async () => {
    configureBoth();
    // Stub the Voyage multimodal endpoint with a deterministic 1024d vector.
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.5), index: 0 }],
          model: 'voyage-multimodal-3',
        }), { status: 200 });
      }
      // Fail OpenAI requests loudly so we catch wrong routing.
      throw new Error(`Unexpected fetch to OpenAI: ${url}`);
    };

    // hybridSearch with no rows in DB just returns []; we're testing that the
    // request hits the multimodal endpoint specifically.
    const results = await hybridSearch(engine, 'hackathon stuff', { crossModal: 'image', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // Must have called the multimodal endpoint at least once.
    expect(fetchUrlsSeen.some(u => u.includes('multimodalembeddings'))).toBe(true);
    // Must NOT have called OpenAI embeddings.
    expect(fetchUrlsSeen.some(u => u.includes('api.openai.com') && u.includes('embeddings'))).toBe(false);
  });

  test('explicit crossModal: "image" threads inputType=query in Voyage body (D22-2)', async () => {
    configureBoth();
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.5), index: 0 }],
          model: 'voyage-multimodal-3',
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await hybridSearch(engine, 'any text', { crossModal: 'image', limit: 5 });
    const voyageBody = fetchBodiesSeen.find(b => b?.inputs?.[0]?.content?.[0]?.type === 'text');
    expect(voyageBody).toBeDefined();
    expect(voyageBody.input_type).toBe('query');
  });

  test('default crossModal=text query does NOT call Voyage multimodal', async () => {
    configureBoth();
    // Allow text embed to succeed via the default OpenAI fetch handler.
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        throw new Error('Unexpected multimodal call for text-modality query');
      }
      // OpenAI text-embedding response shape: {data: [{embedding: [...]}]}
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    await hybridSearch(engine, 'what is founder mode', { limit: 5 });
    expect(fetchUrlsSeen.some(u => u.includes('multimodalembeddings'))).toBe(false);
  });

  test("'auto' literal normalizes to undefined (D22-1) — text query still routes text", async () => {
    configureBoth();
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        throw new Error('Unexpected multimodal call for auto-text-intent query');
      }
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    await hybridSearch(engine, 'what is founder mode', { crossModal: 'auto', limit: 5 });
    // Text route — multimodal never called.
    expect(fetchUrlsSeen.some(u => u.includes('multimodalembeddings'))).toBe(false);
  });

  test('"show me photos from the hackathon" auto-detects to image routing', async () => {
    configureBoth();
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.3), index: 0 }],
          model: 'voyage-multimodal-3',
        }), { status: 200 });
      }
      // Don't fail OpenAI here — auto mode might still call text in 'both' fallback.
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    await hybridSearch(engine, 'show me photos from the hackathon', { limit: 5 });
    // Auto-detection should have fired image routing.
    expect(fetchUrlsSeen.some(u => u.includes('multimodalembeddings'))).toBe(true);
  });

  test("'both' mode hits BOTH endpoints in parallel", async () => {
    configureBoth();
    let textCalled = 0;
    let voyageCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        voyageCalled++;
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.3), index: 0 }],
          model: 'voyage-multimodal-3',
        }), { status: 200 });
      }
      textCalled++;
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    await hybridSearch(engine, 'anything', { crossModal: 'both', limit: 5 });
    expect(textCalled).toBeGreaterThanOrEqual(1);
    expect(voyageCalled).toBeGreaterThanOrEqual(1);
  });

  test('fail-open: multimodal unconfigured → image-intent query falls back to text', async () => {
    configureGateway({
      // No embedding_multimodal_model set.
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'test-key' },
    });
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        throw new Error('Voyage should not be called when not configured');
      }
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
        model: 'text-embedding-3-large',
      }), { status: 200 });
    };

    // crossModal: 'image' with no multimodal model → fail-open to text.
    const results = await hybridSearch(engine, 'show me photos', { crossModal: 'image', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // Did NOT throw; fell back successfully.
  });
});
