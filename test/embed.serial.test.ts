import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

// Mock the embedding module BEFORE importing runEmbed, so runEmbed picks up
// the mocked embedBatch. We track max concurrent invocations via a counter
// that increments on entry and decrements when the mock resolves.
let activeEmbedCalls = 0;
let maxConcurrentEmbedCalls = 0;
let totalEmbedCalls = 0;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    activeEmbedCalls++;
    totalEmbedCalls++;
    if (activeEmbedCalls > maxConcurrentEmbedCalls) {
      maxConcurrentEmbedCalls = activeEmbedCalls;
    }
    // Simulate API latency so concurrent workers actually overlap.
    await new Promise(r => setTimeout(r, 30));
    activeEmbedCalls--;
    return texts.map(() => new Float32Array(1536));
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
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
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
    const stale = [
      { slug: 'stale', chunk_index: 0, chunk_text: 'hi', chunk_source: 'compiled_truth', model: null, token_count: 1 },
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
    const stale = pages.flatMap(p => [
      { slug: p.slug, chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', model: null, token_count: 1 },
      { slug: p.slug, chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', model: null, token_count: 1 },
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
    expect(result.pages_processed).toBe(3);
  });

  test('dry-run --stale correctly identifies stale chunks (SQL-side path)', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    // SQL-side stale: only the 3 chunks where embedding IS NULL come back,
    // grouped by slug. 'fresh' page has no stale rows so it's not in the result.
    const stale = [
      { slug: 'partial', chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', model: null, token_count: 1 },
      { slug: 'all-stale', chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', model: null, token_count: 1 },
      { slug: 'all-stale', chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', model: null, token_count: 1 },
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
    expect(result.pages_processed).toBe(2); // 'partial' + 'all-stale'
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
    const stale = [
      { slug: 'a', chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', model: null, token_count: 1 },
      { slug: 'b', chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth', model: null, token_count: 1 },
      { slug: 'b', chunk_index: 1, chunk_text: 'y', chunk_source: 'compiled_truth', model: null, token_count: 1 },
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

    const stale = [
      { slug: 'page-a', chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth' as const, model: null, token_count: null },
      { slug: 'page-b', chunk_index: 1, chunk_text: 'y', chunk_source: 'compiled_truth' as const, model: null, token_count: null },
      { slug: 'page-b', chunk_index: 2, chunk_text: 'z', chunk_source: 'compiled_truth' as const, model: null, token_count: null },
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

  test('--stale dry-run: counts stale via countStaleChunks, reports via listStaleChunks, no embedBatch or upsertChunks', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const stale = [
      { slug: 'page-a', chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth' as const, model: null, token_count: null },
      { slug: 'page-b', chunk_index: 0, chunk_text: 'y', chunk_source: 'compiled_truth' as const, model: null, token_count: null },
    ];
    const upserts: string[] = [];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => stale,
      upsertChunks: async (slug: string) => { upserts.push(slug); },
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    expect(totalEmbedCalls).toBe(0);
    expect(upserts).toEqual([]);
    expect(result.would_embed).toBe(2);
    expect(result.pages_processed).toBe(2);
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
