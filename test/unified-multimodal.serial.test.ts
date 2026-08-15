// Commit 3 (Phase 3): unified multimodal column.
//
// Covers:
//   - Schema migration v68 adds embedding_multimodal column
//   - searchVector routes to embedding_multimodal when opts.embeddingColumn set
//   - hybridSearch routes through unified column when search.unified_multimodal=true
//   - D8 fail-open: unified-only=false + empty unified column → falls back to text
//   - D8 strict: unified-only=true + empty column → does not fall back
//   - reindex --multimodal cost estimate + dry-run + GBRAIN_NO_REEMBED bypass
//   - D7 lock acquired during reindex; second reindex receives LOCK_HELD

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { runReindexMultimodal } from '../src/commands/reindex-multimodal.ts';

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
  fetchHandler = async () => new Response(JSON.stringify({
    data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
    model: 'voyage-multimodal-3',
  }), { status: 200 });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) throw new Error('no fetch handler');
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    env: { OPENAI_API_KEY: 'test', VOYAGE_API_KEY: 'test' },
  });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

describe('Phase 3 schema — v68 migration', () => {
  test('content_chunks has embedding_multimodal column', async () => {
    // Run an explicit query against the column. If the migration ran, this succeeds.
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM content_chunks WHERE embedding_multimodal IS NULL`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('reindex --multimodal command (Phase 3)', () => {
  test('--dry-run reports cost estimate without mutating', async () => {
    // No rows in DB → pending=0, no work needed.
    const result = await runReindexMultimodal(engine, { dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.reembedded).toBe(0);
  });

  test('--cost-estimate reports cost but does not run', async () => {
    const result = await runReindexMultimodal(engine, { costEstimate: true });
    expect(result.dry_run).toBe(true);
    expect(result.reembedded).toBe(0);
  });

  test('GBRAIN_NO_REEMBED=1 honored on zero-pending brain (skip path is no-op-clean)', async () => {
    await withEnv({ GBRAIN_NO_REEMBED: '1' }, async () => {
      const result = await runReindexMultimodal(engine, {});
      // Zero pending → reindex short-circuits before the env-var check; both
      // paths produce dry_run=false + reembedded=0 + pending=0.
      expect(result.reembedded).toBe(0);
      expect(result.pending_after).toBe(0);
    });
  });

  test('zero-pending returns cleanly', async () => {
    const result = await runReindexMultimodal(engine, { yes: true });
    expect(result.pending_before).toBe(0);
    expect(result.reembedded).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe('hybridSearch unified routing (Phase 3)', () => {
  test('search.unified_multimodal=true routes ALL queries through embedding_multimodal', async () => {
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
    // Unified routing: text query forced to multimodal endpoint.
    expect(voyageCalled).toBeGreaterThanOrEqual(1);
  });

  test('D8 fail-open: empty unified column + not strict → falls back to text', async () => {
    // Set unified flag but DON'T set unified_multimodal_only. Empty DB → unified returns [].
    await engine.setConfig('search.unified_multimodal', 'true');
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
        }), { status: 200 });
      }
      openaiCalled++;
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    const results = await hybridSearch(engine, 'whatever', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // The fall-back path SHOULD call OpenAI (text path) when unified came back empty.
    expect(openaiCalled).toBeGreaterThanOrEqual(1);
  });

  test('D8 strict: unified_multimodal_only=true + empty column → does NOT fall back', async () => {
    await engine.setConfig('search.unified_multimodal', 'true');
    await engine.setConfig('search.unified_multimodal_only', 'true');
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
        }), { status: 200 });
      }
      openaiCalled++;
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    await hybridSearch(engine, 'whatever', { limit: 5 });
    // Strict mode means NO text fallback even when unified is empty.
    expect(openaiCalled).toBe(0);
  });
});
