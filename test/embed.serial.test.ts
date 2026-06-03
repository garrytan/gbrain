import { describe, test, expect, mock, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';

// Mock the embedding module BEFORE importing runEmbed, so runEmbed picks up
// the mocked embedBatch. We track max concurrent invocations via a counter
// that increments on entry and decrements when the mock resolves.
let activeEmbedCalls = 0;
let maxConcurrentEmbedCalls = 0;
let totalEmbedCalls = 0;
let embedBatchTextCalls: string[][] = [];
// D5: capture per-call opts so tests can assert maxRetries / abortSignal
// passthrough into the gateway path.
let lastEmbedBatchOpts: unknown = undefined;
// D5: pluggable behavior for tests that need to simulate 429s or aborts.
let embedBatchBehavior: ((texts: string[], opts?: unknown) => Promise<Float32Array[]>) | null = null;
const TEST_GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gbrain-embed-serial-home-'));
let originalGbrainHome: string | undefined;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[], opts?: unknown) => {
    activeEmbedCalls++;
    totalEmbedCalls++;
    embedBatchTextCalls.push([...texts]);
    lastEmbedBatchOpts = opts;
    if (activeEmbedCalls > maxConcurrentEmbedCalls) {
      maxConcurrentEmbedCalls = activeEmbedCalls;
    }
    try {
      if (embedBatchBehavior) {
        return await embedBatchBehavior(texts, opts);
      }
      // Default: simulate API latency so concurrent workers actually overlap.
      await new Promise(r => setTimeout(r, 30));
      return texts.map(() => new Float32Array(1536));
    } finally {
      activeEmbedCalls--;
    }
  },
  // v0.41.31: embedAll/embedAllStale read the current embedding signature to
  // stamp provenance. The mock returns a stable value; the mock engine's
  // setPageEmbeddingSignature / invalidateStaleSignatureEmbeddings resolve to
  // null via the Proxy default, so the signature value is inert here.
  currentEmbeddingSignature: () => 'test:model:1536',
}));

// Import AFTER mocking.
const { runEmbed } = await import('../src/commands/embed.ts');

// v0.41.6.0 D1: runEmbedCore now preflights embedding credentials. This
// test stack uses the LEGACY embedBatch mock path, not the gateway,
// so the preflight would throw before our mocks see anything. Install
// the gateway embed transport seam so diagnoseEmbedding's fast-path
// flags the preflight as ok without touching real env vars.
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as any));

// Proxy-based mock engine that matches test/import-file.test.ts pattern.
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop]) return overrides[prop];
      return track(prop);
    },
  });
  return engine;
}

beforeAll(() => {
  originalGbrainHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = TEST_GBRAIN_HOME;
});

afterAll(() => {
  if (originalGbrainHome === undefined) {
    delete process.env.GBRAIN_HOME;
  } else {
    process.env.GBRAIN_HOME = originalGbrainHome;
  }
  rmSync(TEST_GBRAIN_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  activeEmbedCalls = 0;
  maxConcurrentEmbedCalls = 0;
  totalEmbedCalls = 0;
  embedBatchTextCalls = [];
  lastEmbedBatchOpts = undefined;
  embedBatchBehavior = null;
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
  delete process.env.GBRAIN_EMBED_TIME_BUDGET_MS;
  delete process.env.GBRAIN_MARKDOWN_CHUNK_MAX_CHARS;
  delete process.env.GBRAIN_EMBEDDING_BATCH_MAX_TEXTS;
});

describe('runEmbed --all (parallel)', () => {
  test('runs embedBatch calls concurrently across pages', async () => {
    const NUM_PAGES = 20;
    const pages = Array.from({ length: NUM_PAGES }, (_, i) => ({ slug: `page-${i}` }));
    // Each page has one chunk without an embedding (stale).
    const chunksBySlug = new Map(
      pages.map(p => [
        p.slug,
        [{ chunk_index: 0, chunk_text: `text for ${p.slug}`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 }],
      ]),
    );

    const engine = mockEngine({
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '10';

    await runEmbed(engine, ['--all']);

    expect(totalEmbedCalls).toBe(NUM_PAGES);
    // Concurrency actually happened.
    expect(maxConcurrentEmbedCalls).toBeGreaterThan(1);
    // And stayed within the configured limit.
    expect(maxConcurrentEmbedCalls).toBeLessThanOrEqual(10);
  });

  test('v0.41.31: stamps embedding_signature after embedding each page (--all)', async () => {
    const pages = [{ slug: 'a', source_id: 'default' }, { slug: 'b', source_id: 'default' }];
    const chunksBySlug = new Map(
      pages.map(p => [
        p.slug,
        [{ chunk_index: 0, chunk_text: `text ${p.slug}`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 }],
      ]),
    );
    const engine = mockEngine({
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    await runEmbed(engine, ['--all']);

    // The wiring gap this pins: embedAll must CALL setPageEmbeddingSignature
    // after upsertChunks, with the current signature (mocked to test:model:1536).
    const stampCalls = (engine as any)._calls.filter((c: any) => c.method === 'setPageEmbeddingSignature');
    expect(stampCalls.length).toBe(2); // one per page
    expect(stampCalls[0].args[1]).toEqual({ sourceId: 'default', signature: 'test:model:1536' });
  });

  test('respects GBRAIN_EMBED_CONCURRENCY=1 (serial)', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ slug: `page-${i}` }));
    const chunksBySlug = new Map(
      pages.map(p => [
        p.slug,
        [{ chunk_index: 0, chunk_text: `text ${p.slug}`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 }],
      ]),
    );

    const engine = mockEngine({
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '1';

    await runEmbed(engine, ['--all']);

    expect(totalEmbedCalls).toBe(5);
    expect(maxConcurrentEmbedCalls).toBe(1);
  });

  test('skips pages whose chunks are all already embedded when --stale', async () => {
    const chunksBySlug = new Map<string, any[]>([
      ['fresh', [{ chunk_index: 0, chunk_text: 'hi', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 1 }]],
      ['stale', [{ chunk_index: 0, chunk_text: 'hi', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 }]],
    ]);
    // Stale path uses countStaleChunks + listStaleChunks (SQL-side filter), not listPages.
    // D5a: source_id + page_id required on StaleChunkRow as of v0.33.3 cursor pagination.
    const stale = [
      { slug: 'stale', chunk_index: 0, chunk_text: 'hi', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 1 },
    ];

    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async () => stale,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '5';

    await runEmbed(engine, ['--stale']);

    // Only the stale page triggers an embedBatch call.
    expect(totalEmbedCalls).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// runEmbedCore dry-run mode (v0.17 regression guard)
// ────────────────────────────────────────────────────────────────

describe('runEmbedCore --dry-run never calls the embedding model', () => {
  test('dry-run --all with stale chunks: no embedBatch calls, accurate would_embed', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const pages = Array.from({ length: 3 }, (_, i) => ({ slug: `page-${i}` }));
    // All 3 pages have 2 stale chunks each (none embedded).
    const chunksBySlug = new Map<string, any[]>(
      pages.map(p => [
        p.slug,
        [
          { chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
          { chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
        ],
      ]),
    );
    // SQL-side stale path: 6 stale rows across 3 pages.
    // D5a: source_id + page_id required on StaleChunkRow.
    const stale = pages.flatMap((p, pi) => [
      { slug: p.slug, chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: pi + 1 },
      { slug: p.slug, chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: pi + 1 },
    ]);

    const upserts: string[] = [];
    const engine = mockEngine({
      countStaleChunks: async () => 6,
      listStaleChunks: async () => stale,
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async (slug: string) => { upserts.push(slug); },
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    // No OpenAI calls.
    expect(totalEmbedCalls).toBe(0);
    // No DB writes.
    expect(upserts).toEqual([]);
    // Accurate counts.
    expect(result.dryRun).toBe(true);
    expect(result.embedded).toBe(0);
    expect(result.would_embed).toBe(6); // 3 pages * 2 chunks each
    // skipped is 0 in the new SQL-side path: we never considered non-stale chunks.
    expect(result.skipped).toBe(0);
    expect(result.total_chunks).toBe(6); // only stale chunks counted in SQL-side path
    // v0.33.3 cherry-pick: dry-run skips the cursor walk and only does a
    // countStaleChunks call. pages_processed is 0 because we don't enumerate
    // pages in dry-run (cheaper pre-flight).
    expect(result.pages_processed).toBe(0);
  });

  test('dry-run --stale correctly identifies stale chunks (SQL-side path)', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    // SQL-side stale: only the 3 chunks where embedding IS NULL come back,
    // grouped by slug. 'fresh' page has no stale rows so it's not in the result.
    // D5a: source_id + page_id required on StaleChunkRow.
    const stale = [
      { slug: 'partial', chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 1 },
      { slug: 'all-stale', chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 2 },
      { slug: 'all-stale', chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 2 },
    ];

    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => stale,
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    expect(totalEmbedCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.would_embed).toBe(3); // 1 from 'partial' + 2 from 'all-stale'
    // SQL-side path does not see non-stale chunks, so skipped=0 and total_chunks=stale-count.
    // Callers wanting full coverage should call engine.getStats()/getHealth() afterward.
    expect(result.skipped).toBe(0);
    expect(result.total_chunks).toBe(3);
    // v0.33.3 cherry-pick: pages_processed=0 in dry-run because we skip
    // the cursor walk (countStaleChunks-only pre-flight).
    expect(result.pages_processed).toBe(0);
  });

  test('dry-run --slugs on a single page counts stale chunks, no API calls', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const chunks = [
      { chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      { chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      { chunk_index: 2, chunk_text: 'c', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 1 },
    ];

    const engine = mockEngine({
      getPage: async () => ({ slug: 'my-page', compiled_truth: 'text', timeline: '' }),
      getChunks: async () => chunks,
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { slugs: ['my-page'], dryRun: true });

    expect(totalEmbedCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.would_embed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.total_chunks).toBe(3);
    expect(result.pages_processed).toBe(1);
  });

  test('slug fallback chunks compiled_truth and timeline with configured max char cap', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const { withEnv } = await import('./helpers/with-env.ts');
    let getChunksCalls = 0;
    let storedChunks: any[] = [];
    const upsertCalls: Array<{ slug: string; chunks: any[] }> = [];

    const engine = mockEngine({
      getPage: async () => ({
        slug: 'my-page',
        compiled_truth: 'a'.repeat(5200),
        timeline: `- 2026-01-01: ${'b'.repeat(5200)}`,
      }),
      getChunks: async () => {
        getChunksCalls++;
        return getChunksCalls === 1 ? [] : storedChunks;
      },
      upsertChunks: async (slug: string, chunks: any[]) => {
        upsertCalls.push({ slug, chunks });
        storedChunks = chunks.map((chunk) => ({ ...chunk, embedded_at: null }));
      },
      setPageEmbeddingSignature: async () => {},
    });

    await withEnv({ GBRAIN_MARKDOWN_CHUNK_MAX_CHARS: '2400' }, async () => {
      const result = await runEmbedCore(engine, { slug: 'my-page' });
      expect(result.pages_processed).toBe(1);
    });

    expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
    const fallbackChunks = upsertCalls[0].chunks;
    const compiledTruthChunks = fallbackChunks.filter((c: any) => c.chunk_source === 'compiled_truth');
    const timelineChunks = fallbackChunks.filter((c: any) => c.chunk_source === 'timeline');
    expect(compiledTruthChunks.length).toBeGreaterThan(1);
    expect(timelineChunks.length).toBeGreaterThan(1);
    for (const chunk of [...compiledTruthChunks, ...timelineChunks]) {
      expect(chunk.chunk_text.length).toBeLessThanOrEqual(2400);
    }
  });

  test('slug path splits provider calls by configured embedding_batch_max_texts and preserves chunk order', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const { withEnv } = await import('./helpers/with-env.ts');
    const chunks = [
      { chunk_index: 0, chunk_text: 'text-0', chunk_source: 'compiled_truth', embedded_at: null, token_count: 2 },
      { chunk_index: 1, chunk_text: 'text-1', chunk_source: 'compiled_truth', embedded_at: null, token_count: 2 },
      { chunk_index: 2, chunk_text: 'text-2', chunk_source: 'compiled_truth', embedded_at: null, token_count: 2 },
    ];
    const upsertCalls: Array<{ slug: string; chunks: any[] }> = [];
    embedBatchBehavior = async (texts) => texts.map((text) => {
      const v = new Float32Array(1536);
      v[0] = Number(text.split('-')[1]);
      return v;
    });
    const engine = mockEngine({
      getPage: async () => ({
        slug: 'split-page',
        source_id: 'default',
        title: 'Split Page',
        compiled_truth: 'text',
        timeline: '',
        frontmatter: {},
      }),
      getChunks: async () => chunks,
      upsertChunks: async (slug: string, updated: any[]) => {
        upsertCalls.push({ slug, chunks: updated });
      },
      setPageEmbeddingSignature: async () => {},
    });

    await withEnv({ GBRAIN_EMBEDDING_BATCH_MAX_TEXTS: '1' }, async () => {
      const result = await runEmbedCore(engine, { slug: 'split-page' });
      expect(result.embedded).toBe(3);
    });

    expect(embedBatchTextCalls.map(call => call.map(text => text.match(/text-\d/)?.[0]))).toEqual([['text-0'], ['text-1'], ['text-2']]);
    expect(totalEmbedCalls).toBe(3);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].chunks.map((c: any) => [c.chunk_index, c.embedding?.[0]])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  test('non-dry-run path reports accurate embedded count (regression guard)', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const chunksBySlug = new Map<string, any[]>([
      ['a', [{ chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 }]],
      ['b', [
        { chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
        { chunk_index: 1, chunk_text: 'y', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      ]],
    ]);
    // D5a: source_id + page_id required on StaleChunkRow.
    const stale = [
      { slug: 'a', chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 1 },
      { slug: 'b', chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 2 },
      { slug: 'b', chunk_index: 1, chunk_text: 'y', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 2 },
    ];

    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => stale,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '2';

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.dryRun).toBe(false);
    expect(result.embedded).toBe(3); // 1 from a + 2 from b
    expect(result.would_embed).toBe(0);
    expect(result.pages_processed).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// runEmbedCore --stale egress fix: SQL-side staleness filter
// Replaces the listPages + per-page getChunks bomb with a count +
// slug-grouped SELECT. On a 100%-embedded brain, 0 listPages calls.
// ────────────────────────────────────────────────────────────────

describe('runEmbedCore --stale egress fix (SQL-side filter)', () => {
  test('zero stale chunks: countStaleChunks short-circuits, listPages never called', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    let listPagesCalled = false;
    let getChunksCalled = false;
    let listStaleCalled = false;
    const engine = mockEngine({
      countStaleChunks: async () => 0,
      listPages: async () => { listPagesCalled = true; return []; },
      getChunks: async () => { getChunksCalled = true; return []; },
      listStaleChunks: async () => { listStaleCalled = true; return []; },
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.embedded).toBe(0);
    expect(result.pages_processed).toBe(0);
    // The egress fix: NONE of these should have been called when count=0.
    expect(listPagesCalled).toBe(false);
    expect(getChunksCalled).toBe(false);
    expect(listStaleCalled).toBe(false);
    expect(totalEmbedCalls).toBe(0);
  });

  test('N stale chunks across M pages: only stale slugs re-fetched, exact stale set embedded, non-stale chunks preserved', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    let listPagesCalled = false;

    // D5a: source_id + page_id required on StaleChunkRow.
    const stale = [
      { slug: 'page-a', chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth' as const, model: null, token_count: null, source_id: 'default', page_id: 1 },
      { slug: 'page-b', chunk_index: 1, chunk_text: 'y', chunk_source: 'compiled_truth' as const, model: null, token_count: null, source_id: 'default', page_id: 2 },
      { slug: 'page-b', chunk_index: 2, chunk_text: 'z', chunk_source: 'compiled_truth' as const, model: null, token_count: null, source_id: 'default', page_id: 2 },
    ];
    // page-b has a FRESH chunk at index 0 that must be preserved through the upsert.
    const fullChunks: Record<string, any[]> = {
      'page-a': [
        { chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      ],
      'page-b': [
        { chunk_index: 0, chunk_text: 'fresh', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 5 },
        { chunk_index: 1, chunk_text: 'y', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
        { chunk_index: 2, chunk_text: 'z', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      ],
    };
    const upsertCalls: Array<{ slug: string; chunks: any[] }> = [];
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => stale,
      listPages: async () => { listPagesCalled = true; return []; },
      getChunks: async (slug: string) => fullChunks[slug] || [],
      upsertChunks: async (slug: string, chunks: any[]) => { upsertCalls.push({ slug, chunks }); },
    });

    const result = await runEmbedCore(engine, { stale: true });

    // listPages must NOT be called in the SQL-side path.
    expect(listPagesCalled).toBe(false);
    // One embedBatch call per stale slug (a, b).
    expect(totalEmbedCalls).toBe(2);
    expect(result.embedded).toBe(3);
    expect(result.pages_processed).toBe(2);

    // page-b's upsert MUST include the fresh chunk (chunk_index=0) — otherwise
    // it would be deleted by the upsertChunks != ALL filter. Critical regression check.
    const pageBUpsert = upsertCalls.find(u => u.slug === 'page-b');
    expect(pageBUpsert).toBeDefined();
    const freshChunkInUpsert = pageBUpsert!.chunks.find((c: any) => c.chunk_index === 0);
    expect(freshChunkInUpsert).toBeDefined();
    // Fresh chunk has no `embedding` field (preserved via COALESCE in upsertChunks SQL).
    expect(freshChunkInUpsert.embedding).toBeUndefined();
    // Previously-stale chunks come through WITH a new embedding.
    const staleChunkInUpsert = pageBUpsert!.chunks.find((c: any) => c.chunk_index === 1);
    expect(staleChunkInUpsert.embedding).toBeDefined();
    expect(staleChunkInUpsert.embedding).toBeInstanceOf(Float32Array);
  });

  test('--stale dry-run: counts stale via countStaleChunks (no listStaleChunks call), no embedBatch or upsertChunks', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    // v0.33.3 cherry-pick contract: dry-run path uses countStaleChunks
    // ONLY — it does not call listStaleChunks. The pre-flight count is
    // what gets reported; pages_processed stays at 0 because we
    // intentionally skip the cursor walk in dry-run.
    let listStaleCalled = false;
    const upserts: string[] = [];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => { listStaleCalled = true; return []; },
      upsertChunks: async (slug: string) => { upserts.push(slug); },
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    expect(totalEmbedCalls).toBe(0);
    expect(upserts).toEqual([]);
    expect(result.would_embed).toBe(2);
    // Cheaper dry-run: skips the cursor walk entirely.
    expect(listStaleCalled).toBe(false);
    expect(result.pages_processed).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  test('--all (non-stale) path is byte-identical: walks listPages and embeds every chunk', async () => {
    // Regression guard for the legacy --all path. Behavior must be byte-identical
    // to pre-fix: listPages + per-page getChunks + embed every chunk.
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    let countStaleCalled = false;
    let listStaleCalled = false;
    const pages = [{ slug: 'a' }, { slug: 'b' }];
    const chunksBySlug = new Map<string, any[]>([
      ['a', [{ chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 1 }]],
      ['b', [{ chunk_index: 0, chunk_text: 'b', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 }]],
    ]);

    const engine = mockEngine({
      countStaleChunks: async () => { countStaleCalled = true; return 1; },
      listStaleChunks: async () => { listStaleCalled = true; return []; },
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { all: true });

    // --all path must NOT take the new short-circuit.
    expect(countStaleCalled).toBe(false);
    expect(listStaleCalled).toBe(false);
    // Both pages get embedded, regardless of embedded_at — that's the --all contract.
    expect(totalEmbedCalls).toBe(2);
    expect(result.embedded).toBe(2);
  });
});

describe('runEmbedCore contextual retrieval state', () => {
  test('--stale embeds existing markdown chunks with title context and stamps the resolved CR mode', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const slug = 'concepts/contextual-stale';
    const stale = [
      {
        slug,
        chunk_index: 0,
        chunk_text: 'Body that was re-chunked without embedding.',
        chunk_source: 'compiled_truth' as const,
        model: null,
        token_count: null,
        source_id: 'default',
        page_id: 1,
      },
    ];
    const fullChunks = [
      {
        chunk_index: 0,
        chunk_text: 'Body that was re-chunked without embedding.',
        chunk_source: 'compiled_truth',
        embedded_at: null,
        token_count: 11,
      },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async () => stale,
      getPage: async () => ({
        slug,
        source_id: 'default',
        title: 'Contextual Stale Page',
        type: 'concept',
        compiled_truth: fullChunks[0].chunk_text,
        timeline: '',
        frontmatter: {},
        deleted_at: null,
      }),
      getChunks: async () => fullChunks,
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.embedded).toBe(1);
    expect(embedBatchTextCalls.length).toBe(1);
    expect(embedBatchTextCalls[0][0]).toContain('<context>Contextual Stale Page');
    expect(embedBatchTextCalls[0][0]).toContain('</context>');

    const crCalls = (engine as any)._calls.filter((c: any) => c.method === 'updatePageContextualRetrievalState');
    expect(crCalls).toHaveLength(1);
    expect(crCalls[0].args[0]).toBe(slug);
    expect(crCalls[0].args[1]).toBe('default');
    expect(crCalls[0].args[2]).toBe('title');
    expect(crCalls[0].args[3]).toMatch(/^[0-9a-f]{16}$/);
  });

  test('--stale fails closed when source policy lookup errors and does not stamp defaults', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const slug = 'concepts/policy-lookup-fails';
    const stale = [
      {
        slug,
        chunk_index: 0,
        chunk_text: 'Body must not be embedded under default CR policy.',
        chunk_source: 'compiled_truth' as const,
        model: null,
        token_count: null,
        source_id: 'source-db-failure',
        page_id: 1,
      },
    ];
    const fullChunks = [
      {
        chunk_index: 0,
        chunk_text: 'Body must not be embedded under default CR policy.',
        chunk_source: 'compiled_truth',
        embedded_at: null,
        token_count: 11,
      },
    ];
    const engine = mockEngine({
      getConfig: async () => null,
      countStaleChunks: async () => 1,
      listStaleChunks: async () => stale,
      executeRaw: async () => {
        throw new Error('sources lookup unavailable');
      },
      getPage: async () => ({
        slug,
        source_id: 'source-db-failure',
        title: 'Policy Lookup Fails',
        type: 'concept',
        compiled_truth: fullChunks[0].chunk_text,
        timeline: '',
        frontmatter: {},
        deleted_at: null,
      }),
      getChunks: async () => fullChunks,
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.embedded).toBe(0);
    expect(embedBatchTextCalls).toHaveLength(0);
    expect((engine as any)._calls.filter((c: any) => c.method === 'upsertChunks')).toHaveLength(0);
    expect((engine as any)._calls.filter((c: any) => c.method === 'updatePageContextualRetrievalState')).toHaveLength(0);
    expect((engine as any)._calls.filter((c: any) => c.method === 'setPageEmbeddingSignature')).toHaveLength(0);
  });

  test('embed input and stamp honor source-row CR mode and frontmatter trust policy', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const sources = new Map([
      ['mount-untrusted', { id: 'mount-untrusted', contextual_retrieval_mode: 'none', trust_frontmatter_overrides: false }],
      ['mount-trusted', { id: 'mount-trusted', contextual_retrieval_mode: 'none', trust_frontmatter_overrides: true }],
    ]);
    const pages = new Map([
      ['mount-untrusted:policy', {
        slug: 'policy',
        source_id: 'mount-untrusted',
        title: 'Untrusted Policy',
        type: 'concept',
        compiled_truth: 'untrusted body',
        timeline: '',
        frontmatter: { contextual_retrieval: 'title' },
        deleted_at: null,
      }],
      ['mount-trusted:policy', {
        slug: 'policy',
        source_id: 'mount-trusted',
        title: 'Trusted Policy',
        type: 'concept',
        compiled_truth: 'trusted body',
        timeline: '',
        frontmatter: { contextual_retrieval: 'title' },
        deleted_at: null,
      }],
    ]);
    const chunks = new Map([
      ['mount-untrusted:policy', [{ chunk_index: 0, chunk_text: 'untrusted body', chunk_source: 'compiled_truth', embedded_at: null, token_count: null }]],
      ['mount-trusted:policy', [{ chunk_index: 0, chunk_text: 'trusted body', chunk_source: 'compiled_truth', embedded_at: null, token_count: null }]],
    ]);

    const engine = mockEngine({
      getConfig: async () => null,
      executeRaw: async (_sql: string, params?: unknown[]) => {
        const source = sources.get(String(params?.[0]));
        return source ? [source] : [];
      },
      getPage: async (slug: string, opts?: { sourceId?: string }) => pages.get(`${opts?.sourceId ?? 'default'}:${slug}`),
      getChunks: async (slug: string, opts?: { sourceId?: string }) => chunks.get(`${opts?.sourceId ?? 'default'}:${slug}`) ?? [],
      upsertChunks: async () => {},
    });

    await runEmbedCore(engine, { slug: 'policy', sourceId: 'mount-untrusted' });
    await runEmbedCore(engine, { slug: 'policy', sourceId: 'mount-trusted' });

    expect(embedBatchTextCalls).toHaveLength(2);
    expect(embedBatchTextCalls[0][0]).toBe('untrusted body');
    expect(embedBatchTextCalls[1][0]).toContain('<context>Trusted Policy');
    expect(embedBatchTextCalls[1][0]).toContain('trusted body');

    const crCalls = (engine as any)._calls.filter((c: any) => c.method === 'updatePageContextualRetrievalState');
    expect(crCalls.map((c: any) => [c.args[1], c.args[2], c.args[3]])).toEqual([
      ['mount-untrusted', 'none', null],
      ['mount-trusted', 'title', expect.stringMatching(/^[0-9a-f]{16}$/)],
    ]);
  });

  test('--stale selects CR-null fully embedded markdown pages and preserves partial-stale page state', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const dimRows = await engine.executeRaw<{ dim: number }>(
        `SELECT atttypmod AS dim FROM pg_attribute
          WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`,
      );
      const colDim = Number(dimRows[0]?.dim);
      const setEmbedding = (slug: string, indexes: number[]) => engine.executeRaw(
        `UPDATE content_chunks
            SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[$1::int]), ',') || ']')::vector
          WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = 'default')
            AND chunk_index = ANY($3::int[])`,
        [colDim, slug, indexes],
      );

      const crNullSlug = 'concepts/contextual-null-pglite';
      await engine.putPage(crNullSlug, {
        type: 'concept',
        title: 'Contextual Null PGLite',
        compiled_truth: 'Existing chunks already have embeddings but no CR stamp.',
        timeline: '',
        frontmatter: {},
      });
      await engine.upsertChunks(crNullSlug, [
        {
          chunk_index: 0,
          chunk_text: 'Existing chunks already have embeddings but no CR stamp.',
          chunk_source: 'compiled_truth',
          token_count: 11,
        },
        {
          chunk_index: 1,
          chunk_text: 'Second embedded chunk also needs CR stamping.',
          chunk_source: 'compiled_truth',
          token_count: 10,
        },
      ]);
      await setEmbedding(crNullSlug, [0, 1]);
      await engine.executeRaw(
        `UPDATE pages
            SET contextual_retrieval_mode = NULL,
                corpus_generation = NULL,
                embedding_signature = 'test:model:1536'
          WHERE slug = $1 AND source_id = 'default'`,
        [crNullSlug],
      );

      const partialSlug = 'concepts/partial-stale-pglite';
      await engine.putPage(partialSlug, {
        type: 'concept',
        title: 'Partial Stale PGLite',
        compiled_truth: 'One preserved chunk and one stale chunk.',
        timeline: '',
        frontmatter: {},
      });
      await engine.upsertChunks(partialSlug, [
        { chunk_index: 0, chunk_text: 'preserved chunk', chunk_source: 'compiled_truth', token_count: 4 },
        { chunk_index: 1, chunk_text: 'stale chunk', chunk_source: 'compiled_truth', token_count: 3 },
      ]);
      await setEmbedding(partialSlug, [0]);
      await engine.executeRaw(
        `UPDATE pages
            SET contextual_retrieval_mode = 'title',
                corpus_generation = 'partial-old-generation',
                embedding_signature = 'test:model:1536'
          WHERE slug = $1 AND source_id = 'default'`,
        [partialSlug],
      );

      const freshSlug = 'concepts/fresh-pglite';
      await engine.putPage(freshSlug, {
        type: 'concept',
        title: 'Fresh PGLite',
        compiled_truth: 'Already embedded and stamped.',
        timeline: '',
        frontmatter: {},
      });
      await engine.upsertChunks(freshSlug, [
        { chunk_index: 0, chunk_text: 'fresh chunk', chunk_source: 'compiled_truth', token_count: 3 },
      ]);
      await setEmbedding(freshSlug, [0]);
      await engine.executeRaw(
        `UPDATE pages
            SET contextual_retrieval_mode = 'title',
                corpus_generation = 'fresh-generation',
                embedding_signature = 'test:model:1536'
          WHERE slug = $1 AND source_id = 'default'`,
        [freshSlug],
      );

      const result = await runEmbedCore(engine, { stale: true, batchSize: 1 });

      expect(result.embedded).toBe(3);
      expect(embedBatchTextCalls.flat()).toHaveLength(3);

      const pages = await engine.executeRaw<{ slug: string; mode: string | null; gen: string | null; sig: string | null }>(
        `SELECT slug,
                contextual_retrieval_mode AS mode,
                corpus_generation AS gen,
                embedding_signature AS sig
           FROM pages
          WHERE slug IN ($1, $2, $3) AND source_id = 'default'
          ORDER BY slug`,
        [crNullSlug, partialSlug, freshSlug],
      );
      const bySlug = new Map(pages.map(p => [p.slug, p]));
      expect(bySlug.get(crNullSlug)?.mode).toBe('title');
      expect(bySlug.get(crNullSlug)?.gen).toMatch(/^[0-9a-f]{16}$/);
      expect(bySlug.get(crNullSlug)?.sig).toBe('test:model:1536');
      expect(bySlug.get(partialSlug)?.mode).toBe('title');
      expect(bySlug.get(partialSlug)?.gen).toBe('partial-old-generation');
      expect(bySlug.get(partialSlug)?.sig).toBe('test:model:1536');
      expect(bySlug.get(freshSlug)?.gen).toBe('fresh-generation');

      const chunks = await engine.executeRaw<{ slug: string; chunk_index: number; has_embedding: boolean }>(
        `SELECT p.slug, cc.chunk_index, cc.embedding IS NOT NULL AS has_embedding
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
          WHERE p.slug IN ($1, $2, $3) AND p.source_id = 'default'
          ORDER BY p.slug, cc.chunk_index`,
        [crNullSlug, partialSlug, freshSlug],
      );
      expect(chunks.every(c => c.has_embedding)).toBe(true);
    } finally {
      await engine.disconnect();
    }
  });

  test('PGLite --stale uses source-row CR policy and expands CR-null page before stamping', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const sourceId = 'source-row-policy-pglite';
      const slug = 'concepts/source-row-policy-pglite';
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config, contextual_retrieval_mode, trust_frontmatter_overrides)
         VALUES ($1, $1, '{"federated":true}'::jsonb, 'none', FALSE)
         ON CONFLICT (id) DO UPDATE
           SET contextual_retrieval_mode = EXCLUDED.contextual_retrieval_mode,
               trust_frontmatter_overrides = EXCLUDED.trust_frontmatter_overrides`,
        [sourceId],
      );
      await engine.putPage(slug, {
        type: 'concept',
        title: 'Source Row Policy PGLite',
        compiled_truth: 'First source-row policy chunk.\n\nSecond source-row policy chunk.',
        timeline: '',
        frontmatter: { contextual_retrieval: 'title' },
      }, { sourceId });
      await engine.upsertChunks(slug, [
        {
          chunk_index: 0,
          chunk_text: 'First source-row policy chunk.',
          chunk_source: 'compiled_truth',
          token_count: 7,
        },
        {
          chunk_index: 1,
          chunk_text: 'Second source-row policy chunk.',
          chunk_source: 'compiled_truth',
          token_count: 7,
        },
      ], { sourceId });
      await engine.executeRaw(
        `UPDATE pages
            SET contextual_retrieval_mode = NULL,
                corpus_generation = NULL,
                embedding_signature = NULL
          WHERE slug = $1 AND source_id = $2`,
        [slug, sourceId],
      );

      embedBatchBehavior = async (texts) => {
        const beforeStamp = await engine.executeRaw<{ mode: string | null }>(
          `SELECT contextual_retrieval_mode AS mode FROM pages WHERE slug = $1 AND source_id = $2`,
          [slug, sourceId],
        );
        expect(beforeStamp[0]?.mode).toBeNull();
        return texts.map(() => new Float32Array(1536));
      };

      const result = await runEmbedCore(engine, { stale: true, sourceId, batchSize: 1 });

      expect(result.embedded).toBe(2);
      expect(embedBatchTextCalls).toHaveLength(1);
      expect(embedBatchTextCalls[0]).toEqual([
        'First source-row policy chunk.',
        'Second source-row policy chunk.',
      ]);

      const pages = await engine.executeRaw<{ mode: string | null; gen: string | null; sig: string | null }>(
        `SELECT contextual_retrieval_mode AS mode,
                corpus_generation AS gen,
                embedding_signature AS sig
           FROM pages
          WHERE slug = $1 AND source_id = $2`,
        [slug, sourceId],
      );
      expect(pages[0]?.mode).toBe('none');
      expect(pages[0]?.gen).toBeNull();
      expect(pages[0]?.sig).toBe('test:model:1536');

      const chunks = await engine.executeRaw<{ has_embedding: boolean }>(
        `SELECT cc.embedding IS NOT NULL AS has_embedding
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
          WHERE p.slug = $1 AND p.source_id = $2
          ORDER BY cc.chunk_index`,
        [slug, sourceId],
      );
      expect(chunks.map(c => c.has_embedding)).toEqual([true, true]);
    } finally {
      await engine.disconnect();
    }
  });

  test('--stale page-level expansion splits provider calls and stores embeddings by chunk_index', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const { withEnv } = await import('./helpers/with-env.ts');
    const slug = 'concepts/split-stale-expansion';
    const stale = [
      {
        slug,
        chunk_index: 0,
        chunk_text: 'text-0',
        chunk_source: 'compiled_truth' as const,
        model: null,
        token_count: null,
        source_id: 'default',
        page_id: 1,
        page_contextual_retrieval_mode: null,
      },
    ];
    const fullChunks = [
      { chunk_index: 0, chunk_text: 'text-0', chunk_source: 'compiled_truth', embedded_at: null, token_count: 2 },
      { chunk_index: 1, chunk_text: 'text-1', chunk_source: 'compiled_truth', embedded_at: null, token_count: 2 },
      { chunk_index: 2, chunk_text: 'text-2', chunk_source: 'compiled_truth', embedded_at: null, token_count: 2 },
    ];
    const upsertCalls: Array<{ slug: string; chunks: any[] }> = [];
    embedBatchBehavior = async (texts) => texts.map((text) => {
      const v = new Float32Array(1536);
      v[0] = Number(text.split('-')[1]);
      return v;
    });
    const engine = mockEngine({
      getConfig: async () => null,
      countStaleChunks: async () => 1,
      listStaleChunks: async () => stale,
      getPage: async () => ({
        slug,
        source_id: 'default',
        title: 'Split Stale Expansion',
        type: 'concept',
        compiled_truth: 'text',
        timeline: '',
        frontmatter: { contextual_retrieval: 'none' },
        deleted_at: null,
      }),
      getChunks: async () => fullChunks,
      upsertChunks: async (pageSlug: string, chunks: any[]) => {
        upsertCalls.push({ slug: pageSlug, chunks });
      },
    });

    await withEnv({ GBRAIN_EMBEDDING_BATCH_MAX_TEXTS: '1' }, async () => {
      const result = await runEmbedCore(engine, { stale: true });
      expect(result.embedded).toBe(3);
    });

    expect(embedBatchTextCalls.map(call => call.map(text => text.match(/text-\d/)?.[0]))).toEqual([['text-0'], ['text-1'], ['text-2']]);
    expect(totalEmbedCalls).toBe(3);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].chunks.map((c: any) => [c.chunk_index, c.embedding?.[0]])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// D5: embedBatchWithBackoff retry wrapper — 8 cases per plan
// (D2 jitter, D4 cause-unwrap, D4a maxRetries:0 passthrough,
// D8 abortSignal threading, plus the pure helpers).
// ────────────────────────────────────────────────────────────────

describe('embedBatchWithBackoff (D2/D4/D4a/D8)', () => {
  test('case 1: parses "try again in 248ms" form and retries', async () => {
    const { embedBatchWithBackoff } = await import('../src/commands/embed.ts');
    let calls = 0;
    embedBatchBehavior = async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('Rate limit reached. Please try again in 50ms.');
        (err as any).cause = { status: 429 };
        throw err;
      }
      return [new Float32Array(1536)];
    };
    const result = await embedBatchWithBackoff(['x']);
    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
  });

  test('case 2: parses "try again in 1.5s" form and retries', async () => {
    const { embedBatchWithBackoff, parseRetryDelayMs, RATE_LIMIT_JITTER, RATE_LIMIT_PAD_MS } = await import('../src/commands/embed.ts');
    let calls = 0;
    embedBatchBehavior = async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('429 — please try again in 0.05s');
        (err as any).cause = { status: 429 };
        throw err;
      }
      return [new Float32Array(1536)];
    };
    const result = await embedBatchWithBackoff(['x']);
    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
    // Pure-helper sanity check on the "s" form path while we're here.
    const delay = parseRetryDelayMs('try again in 1.5s', () => 0.5);
    // 1.5s = 1500ms + 500ms pad = 2000ms; jitter at rng=0.5 → 1.0 multiplier.
    const expected = (1500 + RATE_LIMIT_PAD_MS) * (1 + (0.5 * 2 - 1) * RATE_LIMIT_JITTER);
    expect(delay).toBe(Math.floor(expected));
  });

  test('case 3: unparseable rate-limit message uses RATE_LIMIT_FALLBACK_MS', async () => {
    const { parseRetryDelayMs, RATE_LIMIT_FALLBACK_MS, RATE_LIMIT_JITTER } = await import('../src/commands/embed.ts');
    // Min delay = fallback × (1 - jitter); max = fallback × (1 + jitter).
    const minExpected = Math.floor(RATE_LIMIT_FALLBACK_MS * (1 - RATE_LIMIT_JITTER));
    const maxExpected = Math.floor(RATE_LIMIT_FALLBACK_MS * (1 + RATE_LIMIT_JITTER));
    for (let i = 0; i < 20; i++) {
      const d = parseRetryDelayMs('429 too many requests');
      expect(d).toBeGreaterThanOrEqual(minExpected);
      expect(d).toBeLessThanOrEqual(maxExpected);
    }
  });

  test('case 4: non-rate-limit error rethrows immediately without retry', async () => {
    const { embedBatchWithBackoff } = await import('../src/commands/embed.ts');
    let calls = 0;
    embedBatchBehavior = async () => {
      calls++;
      throw new Error('500 internal server error');
    };
    await expect(embedBatchWithBackoff(['x'])).rejects.toThrow('500 internal server error');
    // Single attempt — no retries on non-429.
    expect(calls).toBe(1);
  });

  test('case 5: jitter range — same parsed delay produces non-identical sleeps across runs', async () => {
    const { parseRetryDelayMs } = await import('../src/commands/embed.ts');
    const samples = new Set<number>();
    for (let i = 0; i < 50; i++) {
      samples.add(parseRetryDelayMs('try again in 100ms'));
    }
    // 50 random samples with ±30% jitter should yield many distinct values.
    expect(samples.size).toBeGreaterThan(5);
  });

  test('case 6: wall-clock budget mid-batch wakes the retry sleep and cancels mid-fetch', async () => {
    const { embedBatchWithBackoff } = await import('../src/commands/embed.ts');
    const controller = new AbortController();
    let calls = 0;
    embedBatchBehavior = async (_texts, opts) => {
      calls++;
      // The wrapper MUST pass the abortSignal into the gateway opts.
      expect((opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal).toBe(controller.signal);
      if (calls === 1) {
        const err = new Error('Rate limit reached. Please try again in 5000ms.');
        (err as any).cause = { status: 429 };
        throw err;
      }
      return [new Float32Array(1536)];
    };
    // Fire the budget abort during the retry sleep — abortableSleep should
    // wake up early instead of waiting the full 5000ms.
    setTimeout(() => controller.abort(), 50);
    const t0 = Date.now();
    await expect(embedBatchWithBackoff(['x'], { abortSignal: controller.signal })).rejects.toThrow();
    const elapsed = Date.now() - t0;
    // Should exit within ~200ms, not the 5000ms+ the retry-after would suggest.
    expect(elapsed).toBeLessThan(500);
  });

  test('case 7: AITransientError-shaped wrap with 429 cause triggers retry; 500 cause does not', async () => {
    const { embedBatchWithBackoff, detect429FromCause } = await import('../src/commands/embed.ts');

    // Pure helper checks first.
    expect(detect429FromCause({ cause: { status: 429 } })).toBe(true);
    expect(detect429FromCause({ cause: { statusCode: 429 } })).toBe(true);
    expect(detect429FromCause({ cause: { status: 500 } })).toBe(false);
    expect(detect429FromCause({ status: 500 })).toBe(false);
    expect(detect429FromCause(undefined)).toBe(false);
    expect(detect429FromCause(null)).toBe(false);
    // Deep wrap (defensive — current normalizeAIError wraps once).
    expect(detect429FromCause({ cause: { cause: { status: 429 } } })).toBe(true);

    // End-to-end: 429 wrapped as AITransientError-like shape → retry.
    // Use a small retry-after in the wrapper message so the parsed delay
    // is fast (keeps the test under the 5s timeout). The fallback delay
    // of 60s would otherwise dominate.
    let calls = 0;
    embedBatchBehavior = async () => {
      calls++;
      if (calls === 1) {
        // Simulate normalizeAIError wrap: message has a parseable retry-after,
        // status only on cause (the structural detection path under test).
        const wrapper = new Error('try again in 10ms');
        (wrapper as any).cause = { status: 429 };
        throw wrapper;
      }
      return [new Float32Array(1536)];
    };
    const result = await embedBatchWithBackoff(['x']);
    expect(calls).toBe(2);
    expect(result).toHaveLength(1);

    // 500 wrapped → no retry, rethrow immediately.
    embedBatchBehavior = async () => {
      const wrapper = new Error('AI transient error');
      (wrapper as any).cause = { status: 500 };
      throw wrapper;
    };
    await expect(embedBatchWithBackoff(['x'])).rejects.toThrow('AI transient error');
  });

  test('case 8: wrapper passes maxRetries:0 through to embedBatch (no SDK retry stack)', async () => {
    const { embedBatchWithBackoff } = await import('../src/commands/embed.ts');
    embedBatchBehavior = async () => [new Float32Array(1536)];
    await embedBatchWithBackoff(['x']);
    expect(lastEmbedBatchOpts).toBeDefined();
    expect((lastEmbedBatchOpts as { maxRetries?: number }).maxRetries).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// D5/D7: embedAllStale sourceId threading — invariant tests
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// Gap scan: CLI flag wiring + end-to-end budget firing (beyond plan)
// ────────────────────────────────────────────────────────────────

describe('runEmbed CLI flag wiring (--stale --source)', () => {
  test('--source <id> on CLI threads sourceId into countStaleChunks', async () => {
    let receivedOpts: unknown;
    const engine = mockEngine({
      countStaleChunks: async (opts: unknown) => {
        receivedOpts = opts;
        return 0; // short-circuit so we don't hit listStaleChunks
      },
    });
    await runEmbed(engine, ['--stale', '--source', 'media-corpus']);
    expect(receivedOpts).toEqual({ sourceId: 'media-corpus' });
  });

  test('--stale without --source passes undefined opts (back-compat fast path)', async () => {
    let receivedOpts: unknown;
    const engine = mockEngine({
      countStaleChunks: async (opts: unknown) => {
        receivedOpts = opts;
        return 0;
      },
    });
    await runEmbed(engine, ['--stale']);
    expect(receivedOpts).toBeUndefined();
  });
});

describe('embedAllStale wall-clock budget end-to-end (D3 + D3a)', () => {
  test('GBRAIN_EMBED_TIME_BUDGET_MS=N cuts the outer loop short on stuck workers', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    // Tiny budget: 100ms. Each embed call sleeps 50ms; with budget + multiple
    // small batches, the second listStaleChunks call should see the abort
    // signal AND the worker loop should not claim further keys.
    process.env.GBRAIN_EMBED_TIME_BUDGET_MS = '100';
    process.env.GBRAIN_EMBED_CONCURRENCY = '1';

    let listCallCount = 0;
    let totalRowsReturned = 0;
    // Return rows in chunks of 1 so the outer while-loop ticks frequently.
    // 10 rows total across 10 "batches"; the budget should kill the loop
    // partway through.
    const allRows = Array.from({ length: 10 }, (_, i) => ({
      slug: `b-${i}`,
      chunk_index: 0,
      chunk_text: `t${i}`,
      chunk_source: 'compiled_truth' as const,
      model: null,
      token_count: 1,
      source_id: 'default',
      page_id: i + 1,
    }));

    const engine = mockEngine({
      countStaleChunks: async () => allRows.length,
      listStaleChunks: async (opts: { afterPageId?: number } = {}) => {
        listCallCount++;
        const startIdx = (opts.afterPageId ?? 0); // 0 means start
        const idx = allRows.findIndex(r => r.page_id > startIdx);
        if (idx === -1) return [];
        const row = allRows[idx];
        totalRowsReturned++;
        return [row];
      },
      getChunks: async () => [],
      upsertChunks: async () => {},
    });

    // embedBatch takes 80ms per call — budget exhausts after ~1 page.
    embedBatchBehavior = async (texts) => {
      await new Promise(r => setTimeout(r, 80));
      return texts.map(() => new Float32Array(1536));
    };

    const t0 = Date.now();
    const result = await runEmbedCore(engine, { stale: true });
    const elapsed = Date.now() - t0;

    // Should not have visited all 10 pages.
    expect(result.pages_processed).toBeLessThan(10);
    // Total wall-clock should be roughly the budget + the time for in-flight
    // workers to drain (1 worker × 80ms latency). Generous upper bound: 1500ms.
    expect(elapsed).toBeLessThan(1500);
  });

  test('--catch-up does not install an overflowing wall-clock timer', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    process.env.GBRAIN_EMBED_TIME_BUDGET_MS = '1';
    process.env.GBRAIN_EMBED_CONCURRENCY = '1';
    const allRows = Array.from({ length: 3 }, (_, i) => ({
      slug: `catch-up-${i}`,
      chunk_index: 0,
      chunk_text: `catch-up text ${i}`,
      chunk_source: 'compiled_truth' as const,
      model: null,
      token_count: 1,
      source_id: 'default',
      page_id: i + 1,
    }));

    const engine = mockEngine({
      countStaleChunks: async () => allRows.length,
      listStaleChunks: async (opts: { afterPageId?: number } = {}) => {
        const idx = allRows.findIndex(r => r.page_id > (opts.afterPageId ?? 0));
        return idx === -1 ? [] : [allRows[idx]];
      },
      getChunks: async (slug: string) => {
        const row = allRows.find(r => r.slug === slug);
        return row ? [{ chunk_index: 0, chunk_text: row.chunk_text, chunk_source: row.chunk_source, embedded_at: null, token_count: 1 }] : [];
      },
      upsertChunks: async () => {},
    });
    embedBatchBehavior = async (texts) => {
      await new Promise(r => setTimeout(r, 5));
      return texts.map(() => new Float32Array(1536));
    };

    const result = await runEmbedCore(engine, { stale: true, catchUp: true, batchSize: 1 });

    expect(result.embedded).toBe(3);
    expect(result.pages_processed).toBe(3);
    expect(totalEmbedCalls).toBe(3);
  });
});

describe('embedAllStale --source threading (D7)', () => {
  test('countStaleChunks receives the sourceId opt', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    let receivedOpts: unknown;
    const engine = mockEngine({
      countStaleChunks: async (opts: unknown) => {
        receivedOpts = opts;
        return 0; // short-circuit
      },
    });
    await runEmbedCore(engine, { stale: true, sourceId: 'media-corpus' });
    expect(receivedOpts).toEqual({ sourceId: 'media-corpus' });
  });

  test('countStaleChunks receives undefined opts when --source omitted (back-compat)', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    let receivedOpts: unknown;
    const engine = mockEngine({
      countStaleChunks: async (opts: unknown) => {
        receivedOpts = opts;
        return 0;
      },
    });
    await runEmbedCore(engine, { stale: true });
    expect(receivedOpts).toBeUndefined();
  });

  test('listStaleChunks receives the sourceId in opts when running source-scoped', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    let firstCallOpts: unknown;
    const stale = [
      { slug: 'p', chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'media-corpus', page_id: 1 },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async (opts: unknown) => {
        if (firstCallOpts === undefined) firstCallOpts = opts;
        return stale;
      },
      getChunks: async () => stale.map(s => ({ chunk_index: s.chunk_index, chunk_text: s.chunk_text, chunk_source: s.chunk_source, embedded_at: null, token_count: 1 })),
      upsertChunks: async () => {},
    });
    await runEmbedCore(engine, { stale: true, sourceId: 'media-corpus' });
    expect((firstCallOpts as { sourceId?: string }).sourceId).toBe('media-corpus');
  });
});
