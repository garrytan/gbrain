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
}));

// Import AFTER mocking.
const { runEmbed } = await import('../src/commands/embed.ts');

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
