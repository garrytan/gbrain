import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

// Mock the embedding module BEFORE importing runEmbed, so runEmbed picks up
// the mocked embedBatch. We track max concurrent invocations via a counter
// that increments on entry and decrements when the mock resolves.
let activeEmbedCalls = 0;
let maxConcurrentEmbedCalls = 0;
let totalEmbedCalls = 0;
// D5: capture per-call opts so tests can assert maxRetries / abortSignal
// passthrough into the gateway path.
let lastEmbedBatchOpts: unknown = undefined;
// D5: pluggable behavior for tests that need to simulate 429s or aborts.
let embedBatchBehavior: ((texts: string[], opts?: unknown) => Promise<Float32Array[]>) | null = null;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[], opts?: unknown) => {
    activeEmbedCalls++;
    totalEmbedCalls++;
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
  // #3374: import-file.ts (imported by the routing test below) also pulls
  // embedMultimodal from this module; the mock must export it or the import
  // itself throws. Inert — no test here exercises the multimodal path.
  embedMultimodal: async (inputs: unknown[]) => inputs.map(() => new Float32Array(512)),
}));

// Import AFTER mocking.
const { runEmbed, runEmbedCore } = await import('../src/commands/embed.ts');

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

beforeEach(() => {
  activeEmbedCalls = 0;
  maxConcurrentEmbedCalls = 0;
  totalEmbedCalls = 0;
  lastEmbedBatchOpts = undefined;
  embedBatchBehavior = null;
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
  delete process.env.GBRAIN_EMBED_TIME_BUDGET_MS;
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

  // #1737: cooperative abort. A pre-aborted signal must stop the embed loop
  // BEFORE any embedBatch call, so a job killed by wall-clock/lock-loss frees
  // the worker (and lets the cycle's finally release gbrain_cycle_locks)
  // instead of grinding through the full 10-15 min embed phase.
  test('#1737 --all: pre-aborted signal embeds nothing (no embedBatch call)', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ slug: `page-${i}`, source_id: 'default' }));
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

    const ac = new AbortController();
    ac.abort(new Error('wall-clock'));
    const result = await runEmbedCore(engine, { all: true, signal: ac.signal });

    expect(totalEmbedCalls).toBe(0);
    expect(result.embedded).toBe(0);
  });

  test('#1737 --stale: pre-aborted signal breaks the loop before listStaleChunks', async () => {
    let listStaleCalls = 0;
    const engine = mockEngine({
      countStaleChunks: async () => 5, // non-zero so we pass the early return
      listStaleChunks: async () => { listStaleCalls++; return []; },
      invalidateStaleSignatureEmbeddings: async () => 0,
    });

    const ac = new AbortController();
    ac.abort(new Error('lock-lost'));
    const result = await runEmbedCore(engine, { stale: true, signal: ac.signal });

    // The top-of-loop abort check fires before the first listStaleChunks page load.
    expect(listStaleCalls).toBe(0);
    expect(totalEmbedCalls).toBe(0);
    expect(result.embedded).toBe(0);
  });

  test('#1737 review catch: signal aborted during chunkless-page healing stops before invalidateStaleSignatureEmbeddings', async () => {
    // Round-3 review finding: embedAllStale must check the abort signal
    // immediately after the chunkless-page healing sweep, before falling
    // through into invalidateStaleSignatureEmbeddings (a write path) —
    // otherwise a caller-cancelled run could still NULL out
    // signature-drifted embeddings and exit, leaving retrieval degraded.
    const ac = new AbortController();
    let invalidateCalled = false;
    const engine = mockEngine({
      countChunklessPagesWithContent: async () => 1,
      listChunklessPagesWithContent: async () => {
        // Simulate the caller's cancellation firing WHILE the healing sweep
        // is mid-flight (e.g. worker timeout / lock loss / SIGTERM).
        ac.abort(new Error('lock-lost'));
        return [];
      },
      invalidateStaleSignatureEmbeddings: async () => { invalidateCalled = true; return 0; },
      countStaleChunks: async () => 0,
    });

    await runEmbedCore(engine, { stale: true, signal: ac.signal });

    expect(invalidateCalled).toBe(false);
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

  test('dry-run --stale emits no page progress, since it processes no pages', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const stale = [
      { slug: 'a', chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 1 },
      { slug: 'b', chunk_index: 0, chunk_text: 'b', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 2 },
      { slug: 'c', chunk_index: 0, chunk_text: 'c', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 3 },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => stale.length,
      listStaleChunks: async () => stale,
      listPages: async () => [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }],
      getChunks: async () => [],
    });

    const calls: Array<[number, number]> = [];
    const result = await runEmbedCore(engine, {
      stale: true,
      dryRun: true,
      onProgress: (done, total) => { calls.push([done, total]); },
    });

    // The CLI latches its `embed.pages` total from the first callback, so a
    // synthetic (1, 1) here made the progress stream announce one page while
    // the summary named every stale chunk. Consistent with pages_processed
    // above: a dry run enumerates no pages, so it reports no page progress.
    // docs/progress-events.md permits omitting a total that is not known up
    // front; it does not permit asserting a wrong one.
    expect(calls).toEqual([]);
    expect(result.pages_processed).toBe(0);
    expect(result.would_embed).toBe(3);
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

  test('case 4: non-retriable error rethrows immediately without retry', async () => {
    const { embedBatchWithBackoff } = await import('../src/commands/embed.ts');
    let calls = 0;
    embedBatchBehavior = async () => {
      calls++;
      throw new Error('500 internal server error');
    };
    await expect(embedBatchWithBackoff(['x'])).rejects.toThrow('500 internal server error');
    // Single attempt — no retries on non-gateway 5xx (#3966 keeps 500 fatal).
    expect(calls).toBe(1);
  });

  test('case 4b: 502 Bad Gateway retries then succeeds (#3966)', async () => {
    const { embedBatchWithBackoff, detectGatewayErrorFromCause } = await import('../src/commands/embed.ts');
    expect(detectGatewayErrorFromCause({ cause: { status: 502 } })).toBe(true);
    expect(detectGatewayErrorFromCause({ cause: { status: 503 } })).toBe(true);
    expect(detectGatewayErrorFromCause({ cause: { status: 504 } })).toBe(true);
    expect(detectGatewayErrorFromCause({ cause: { status: 500 } })).toBe(false);

    let calls = 0;
    embedBatchBehavior = async () => {
      calls++;
      if (calls === 1) {
        // NIM-style wrap: status on cause; parseable delay keeps the test fast.
        const err = new Error('[embed(nvidia:nvidia/nv-embed-v1)] Bad Gateway — try again in 10ms');
        (err as any).cause = { status: 502 };
        throw err;
      }
      return [new Float32Array(1536)];
    };
    const result = await embedBatchWithBackoff(['x']);
    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
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
    const { embedBatchWithBackoff, detect429FromCause, detectGatewayErrorFromCause } = await import('../src/commands/embed.ts');

    // Pure helper checks first.
    expect(detect429FromCause({ cause: { status: 429 } })).toBe(true);
    expect(detect429FromCause({ cause: { statusCode: 429 } })).toBe(true);
    expect(detect429FromCause({ cause: { status: 500 } })).toBe(false);
    expect(detect429FromCause({ status: 500 })).toBe(false);
    expect(detect429FromCause(undefined)).toBe(false);
    expect(detect429FromCause(null)).toBe(false);
    expect(detectGatewayErrorFromCause({ cause: { cause: { status: 502 } } })).toBe(true);
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
// #3374: transient network retry branch (timeout / conn-reset)
// beside the 429 path, plain bounded backoff, never caller aborts.
// ────────────────────────────────────────────────────────────────

describe('#3374 — transient network retry branch', () => {
  test('classifier: structured codes, TimeoutError name, message fallback', async () => {
    const { isTransientNetworkEmbedError } = await import('../src/commands/embed.ts');
    // Structured code on the error itself and through the cause chain.
    const reset = new Error('request failed');
    (reset as any).code = 'ECONNRESET';
    expect(isTransientNetworkEmbedError(reset)).toBe(true);
    expect(isTransientNetworkEmbedError({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).toBe(true);
    expect(isTransientNetworkEmbedError({ cause: { cause: { code: 'ETIMEDOUT' } } })).toBe(true);
    expect(isTransientNetworkEmbedError({ name: 'TimeoutError' })).toBe(true);
    // Message fallback for wrappers that strip the code.
    expect(isTransientNetworkEmbedError(new Error('socket hang up'))).toBe(true);
    expect(isTransientNetworkEmbedError(new Error('fetch failed'))).toBe(true);
    expect(isTransientNetworkEmbedError(new Error('request timed out'))).toBe(true);
    // NOT transient: plain 500, permanent 4xx, caller aborts.
    expect(isTransientNetworkEmbedError(new Error('500 internal server error'))).toBe(false);
    expect(isTransientNetworkEmbedError(new Error('400 invalid input'))).toBe(false);
    expect(isTransientNetworkEmbedError(new Error('The operation was aborted.'))).toBe(false);
    expect(isTransientNetworkEmbedError(new Error('embed budget aborted'))).toBe(false);
  });

  test('backoff: plain bounded exponential with jitter, capped', async () => {
    const { transientBackoffMs, TRANSIENT_NET_BASE_MS, TRANSIENT_NET_MAX_MS, RATE_LIMIT_JITTER } =
      await import('../src/commands/embed.ts');
    const mid = () => 0.5; // jitter multiplier = 1.0
    expect(transientBackoffMs(0, mid)).toBe(TRANSIENT_NET_BASE_MS);
    expect(transientBackoffMs(1, mid)).toBe(TRANSIENT_NET_BASE_MS * 2);
    expect(transientBackoffMs(2, mid)).toBe(TRANSIENT_NET_BASE_MS * 4);
    // Cap: attempt 10 would be 1024s uncapped.
    expect(transientBackoffMs(10, mid)).toBe(TRANSIENT_NET_MAX_MS);
    // Jitter bounds at the cap.
    expect(transientBackoffMs(10, () => 0)).toBe(Math.floor(TRANSIENT_NET_MAX_MS * (1 - RATE_LIMIT_JITTER)));
    expect(transientBackoffMs(10, () => 1)).toBe(Math.floor(TRANSIENT_NET_MAX_MS * (1 + RATE_LIMIT_JITTER)));
  });

  test('conn-reset retries then succeeds (no retry-after to parse)', async () => {
    const { embedBatchWithBackoff } = await import('../src/commands/embed.ts');
    let calls = 0;
    embedBatchBehavior = async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('socket hang up');
        (err as any).code = 'ECONNRESET';
        throw err;
      }
      return [new Float32Array(1536)];
    };
    const result = await embedBatchWithBackoff(['x']);
    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
  }, 10_000);

  test('caller-initiated abort during the transient sleep bubbles out (never retried)', async () => {
    const { embedBatchWithBackoff } = await import('../src/commands/embed.ts');
    const controller = new AbortController();
    let calls = 0;
    embedBatchBehavior = async () => {
      calls++;
      const err = new Error('connect timeout');
      (err as any).code = 'UND_ERR_CONNECT_TIMEOUT';
      throw err;
    };
    setTimeout(() => controller.abort(), 50);
    const t0 = Date.now();
    await expect(embedBatchWithBackoff(['x'], { abortSignal: controller.signal })).rejects.toThrow();
    // One attempt, abort wakes the ~1s backoff sleep early, loop exits.
    expect(calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(600);
  });

  test('import-file path (#3374): a one-off conn reset no longer aborts the import', async () => {
    const { importFromContent } = await import('../src/core/import-file.ts');
    let calls = 0;
    embedBatchBehavior = async (texts) => {
      calls++;
      if (calls === 1) {
        const err = new Error('read ECONNRESET');
        (err as any).code = 'ECONNRESET';
        throw err;
      }
      return texts.map(() => new Float32Array(1536));
    };
    // Minimal working-DB mock: tx.putPage lands in a store the read-back
    // guard can see; everything else resolves null via the Proxy default.
    const pageStore = new Map<string, any>();
    const tx = new Proxy({} as any, {
      get(_, prop: string) {
        if (prop === 'putPage') {
          return async (slug: string, page: any) => { pageStore.set(slug, page); };
        }
        return () => Promise.resolve(null);
      },
    });
    const engine = mockEngine({
      getPage: async (slug: string) =>
        pageStore.has(slug) ? { slug, ...pageStore.get(slug) } : null,
      transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    });
    const res = await importFromContent(
      engine,
      'notes/transient-net-test',
      '# Transient\n\nSome body text long enough to produce a chunk for embedding.',
      {},
    );
    // Pre-fix: bare embedBatch → the first ECONNRESET propagated and the
    // import aborted. Post-fix: one retry, then the page lands.
    expect(calls).toBe(2);
    expect(pageStore.has('notes/transient-net-test')).toBe(true);
    expect(res).toBeDefined();
  }, 10_000);
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

// ────────────────────────────────────────────────────────────────
// Code metadata preservation across re-embed (regression for #769)
// ────────────────────────────────────────────────────────────────
//
// gbrain v0.30.1 and earlier silently clobbered code-chunk metadata
// (language, symbol_name, symbol_type, start_line, end_line,
// parent_symbol_path, doc_comment, symbol_name_qualified) on every
// re-embed pass. The chunker populated those columns at import time,
// but embed.ts loaded chunks via getChunks then mapped them to a
// stripped ChunkInput carrying only 5 fields. upsertChunks then
// OVERWROTE (not COALESCEd) the metadata columns from EXCLUDED, so
// re-embed wiped them to NULL. End result on a real brain: 4875 code
// pages, 47866 chunks, all with NULL language/symbol_name/symbol_type;
// code-def returned 0 hits across every indexed repo.
//
// All three runEmbed paths (--stale autopilot, --all, --slugs) must
// thread metadata through the re-upsert. Tests below assert that the
// engine.upsertChunks call carries the same metadata it loaded.

describe('runEmbed preserves code-chunk metadata across re-embed (regression for #769)', () => {
  const fullCodeChunk = {
    chunk_index: 0,
    chunk_text: '[Java] foo/Bar.java:10-20 method baz',
    chunk_source: 'compiled_truth' as const,
    embedded_at: null,
    token_count: 12,
    language: 'java',
    symbol_name: 'baz',
    symbol_type: 'function',
    start_line: 10,
    end_line: 20,
    parent_symbol_path: ['Bar'],
    doc_comment: 'does the thing',
    symbol_name_qualified: 'Bar.baz',
  };

  function metadataOf(chunk: any) {
    return {
      language: chunk.language,
      symbol_name: chunk.symbol_name,
      symbol_type: chunk.symbol_type,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      parent_symbol_path: chunk.parent_symbol_path,
      doc_comment: chunk.doc_comment,
      symbol_name_qualified: chunk.symbol_name_qualified,
    };
  }

  test('--stale (autopilot path) carries code metadata into upsertChunks', async () => {
    const stale = [{
      slug: 'code-page',
      chunk_index: 0,
      chunk_text: fullCodeChunk.chunk_text,
      chunk_source: 'compiled_truth',
      model: null,
      token_count: 12,
    }];
    let upsertChunkArgs: any[] | null = null;
    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async () => stale,
      getChunks: async () => [fullCodeChunk],
      upsertChunks: async (_slug: string, chunks: any[]) => { upsertChunkArgs = chunks; },
    });

    await runEmbed(engine, ['--stale']);

    expect(upsertChunkArgs).not.toBeNull();
    expect(upsertChunkArgs!).toHaveLength(1);
    expect(metadataOf(upsertChunkArgs![0])).toEqual(metadataOf(fullCodeChunk));
  });

  test('--all (full re-embed) carries code metadata into upsertChunks', async () => {
    let upsertChunkArgs: any[] | null = null;
    const engine = mockEngine({
      listPages: async () => [{ slug: 'code-page' }],
      getChunks: async () => [fullCodeChunk],
      upsertChunks: async (_slug: string, chunks: any[]) => { upsertChunkArgs = chunks; },
    });

    await runEmbed(engine, ['--all']);

    expect(upsertChunkArgs).not.toBeNull();
    expect(upsertChunkArgs!).toHaveLength(1);
    expect(metadataOf(upsertChunkArgs![0])).toEqual(metadataOf(fullCodeChunk));
  });

  test('--slugs (per-page embed) carries code metadata into upsertChunks', async () => {
    let upsertChunkArgs: any[] | null = null;
    const engine = mockEngine({
      getPage: async () => ({ slug: 'code-page', compiled_truth: 'x', timeline: '' }),
      getChunks: async () => [fullCodeChunk],
      upsertChunks: async (_slug: string, chunks: any[]) => { upsertChunkArgs = chunks; },
    });

    await runEmbed(engine, ['--slugs', 'code-page']);

    expect(upsertChunkArgs).not.toBeNull();
    expect(upsertChunkArgs!).toHaveLength(1);
    expect(metadataOf(upsertChunkArgs![0])).toEqual(metadataOf(fullCodeChunk));
  });
});

// ────────────────────────────────────────────────────────────────
// #3507 — `embed --stale` must reproduce the page's STORED
// contextual-retrieval wrapping convention instead of embedding raw
// chunk_text (which silently stripped contextual prefixes on every
// re-embed, including the normal post-model-migration path).
// ────────────────────────────────────────────────────────────────

describe('embed --stale contextual-retrieval wrapping (#3507)', () => {
  const wrapChunks = [
    { chunk_index: 0, chunk_text: 'prose chunk', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
    { chunk_index: 1, chunk_text: 'const x = 1;', chunk_source: 'fenced_code', embedded_at: null, token_count: 1 },
  ];
  const wrapStale = [
    { slug: 'wrapped', chunk_index: 0, chunk_text: 'prose chunk', chunk_source: 'compiled_truth' as const, model: null, token_count: 1, source_id: 'default', page_id: 1 },
    { slug: 'wrapped', chunk_index: 1, chunk_text: 'const x = 1;', chunk_source: 'fenced_code' as any, model: null, token_count: 1, source_id: 'default', page_id: 1 },
  ];

  function wrappingHarness(mode: string | null) {
    const seen: string[] = [];
    const restamps: any[][] = [];
    embedBatchBehavior = async (texts: string[]) => {
      seen.push(...texts);
      return texts.map(() => new Float32Array(1536));
    };
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => wrapStale,
      getPage: async () => ({
        slug: 'wrapped',
        title: 'Widget Notes',
        source_id: 'default',
        compiled_truth: 'x',
        timeline: '',
        contextual_retrieval_mode: mode,
      }),
      getChunks: async () => wrapChunks,
      upsertChunks: async () => {},
      updatePageContextualRetrievalState: async (...args: any[]) => { restamps.push(args); },
    });
    return { engine, seen, restamps };
  }

  test('title-mode page: stale re-embed wraps prose with the title prefix; fenced_code stays raw', async () => {
    const { engine, seen, restamps } = wrappingHarness('title');
    const result = await runEmbedCore(engine, { stale: true });
    expect(result.embedded).toBe(2);
    expect(seen).toContain('<context>Widget Notes\n</context>\nprose chunk');
    expect(seen).toContain('const x = 1;');
    expect(restamps).toHaveLength(0); // title tier: stamp already honest
  });

  test('per_chunk_synopsis page: fully re-embedded page restamps to the title tier', async () => {
    const { engine, seen, restamps } = wrappingHarness('per_chunk_synopsis');
    const result = await runEmbedCore(engine, { stale: true });
    expect(result.embedded).toBe(2);
    expect(seen).toContain('<context>Widget Notes\n</context>\nprose chunk');
    expect(restamps).toHaveLength(1);
    const [slug, sourceId, newMode] = restamps[0];
    expect(slug).toBe('wrapped');
    expect(sourceId).toBe('default');
    expect(newMode).toBe('title');
  });

  test('page with no stored CR mode embeds raw chunk_text (convention preserved)', async () => {
    const { engine, seen, restamps } = wrappingHarness(null);
    const result = await runEmbedCore(engine, { stale: true });
    expect(result.embedded).toBe(2);
    expect(seen).toContain('prose chunk');
    expect(seen.some((t) => t.startsWith('<context>'))).toBe(false);
    expect(restamps).toHaveLength(0);
  });
});

describe('#3796 — attempt-scaled 429 wait floors (rolling TPM window)', () => {
  const mid = () => 0.5; // jitterFactor = 1 → deterministic

  test('tiny provider hints get floored, and the floor escalates per attempt', async () => {
    const { rateLimitDelayMs, RATE_LIMIT_ATTEMPT_FLOOR_MS } = await import('../src/commands/embed.ts');
    // 'try again in 100ms' → hint = 600ms at mid jitter; every attempt floors above it.
    const waits = [0, 1, 2, 3, 4].map((attempt) => rateLimitDelayMs('try again in 100ms', attempt, mid));
    expect(waits).toEqual([...RATE_LIMIT_ATTEMPT_FLOOR_MS]);
    // Strictly escalating ladder.
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThan(waits[i - 1]);
  });

  test('a larger provider hint wins over the floor (Retry-After must be honored)', async () => {
    const { rateLimitDelayMs, RATE_LIMIT_PAD_MS } = await import('../src/commands/embed.ts');
    const hinted = 240_000 + RATE_LIMIT_PAD_MS;
    for (const attempt of [0, 2, 4]) {
      expect(rateLimitDelayMs('try again in 240s', attempt, mid)).toBe(hinted);
    }
  });

  test('cumulative floored wait spans the rolling TPM minute even at worst-case jitter', async () => {
    const { rateLimitDelayMs } = await import('../src/commands/embed.ts');
    const low = () => 0; // jitterFactor = 1 - RATE_LIMIT_JITTER (worst case)
    let total = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      total += rateLimitDelayMs('try again in 132ms', attempt, low);
    }
    // Pre-fix: 5 × ~442ms ≈ 2.2s — every retry burned inside the same TPM
    // minute. Post-fix the ladder must span it.
    expect(total).toBeGreaterThan(60_000);
  });

  test('attempts past the ladder clamp to the last floor', async () => {
    const { rateLimitDelayMs, RATE_LIMIT_ATTEMPT_FLOOR_MS } = await import('../src/commands/embed.ts');
    const last = RATE_LIMIT_ATTEMPT_FLOOR_MS[RATE_LIMIT_ATTEMPT_FLOOR_MS.length - 1];
    expect(rateLimitDelayMs('429 slow down', 10, mid)).toBe(Math.max(last, rateLimitDelayMs('429 slow down', 4, mid)));
    // Negative attempt (defensive) clamps to the first rung.
    expect(rateLimitDelayMs('try again in 1ms', -1, mid)).toBe(RATE_LIMIT_ATTEMPT_FLOOR_MS[0]);
  });
});
