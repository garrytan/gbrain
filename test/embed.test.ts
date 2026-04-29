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
      // listSlugsPendingEmbedding runs in parallel with countStaleChunks in the
      // staleOnly path; same slug set as bySlug for this test (no zero-chunk
      // pages, so the union is just the stale-rows slugs).
      listSlugsPendingEmbedding: async () => ['stale'],
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '5';

    await runEmbed(engine, ['--stale']);

    // Only the stale page triggers an embedBatch call.
    expect(totalEmbedCalls).toBe(1);
  });

  test('fast-path: staleOnly with no stale slugs skips listPages + getChunks entirely', async () => {
    // Regression guard for the autopilot cycle-timeout fix: on a fully-embedded
    // brain, embedAll must NOT iterate all pages via listPages+getChunks. It
    // must early-exit after one listSlugsPendingEmbedding call returning [].
    let listPagesCalls = 0;
    let getChunksCalls = 0;
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => [],
      listPages: async () => { listPagesCalls++; return []; },
      getChunks: async () => { getChunksCalls++; return []; },
      upsertChunks: async () => {},
    });

    await runEmbed(engine, ['--stale']);

    expect(totalEmbedCalls).toBe(0);
    expect(listPagesCalls).toBe(0);
    expect(getChunksCalls).toBe(0);
  });

  test('fast-path: pending_pages == 0 surfaces on the result for cycle reporting', async () => {
    // Regression guard: cycle.ts used to call listSlugsPendingEmbedding a
    // second time to populate the cycle report's pending-page count. The fix
    // threads it through EmbedResult.pending_pages instead. On a fully-embedded
    // brain (Promise.all returns [] for pendingSlugs), result.pending_pages
    // must be 0 so the cycle phase summary reads "across 0 pending page(s)".
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => [],
      listPages: async () => [],
      getChunks: async () => [],
      upsertChunks: async () => {},
    });

    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const result = await runEmbedCore(engine, { stale: true, dryRun: false });

    expect(result.pending_pages).toBe(0);
    expect(result.embedded).toBe(0);
  });

  test('zero-chunk pages: embedAll staleOnly chunks them on the fly and embeds', async () => {
    // Pages created via direct putPage() (migrate-engine, enrichment-service,
    // output/writer) have no content_chunks rows yet. listSlugsPendingEmbedding
    // surfaces them; embedOnePage must chunk them from page text and embed.
    // Stateful mock: getChunks returns whatever the last upsertChunks stored
    // so the re-read after the chunking upsert sees the new rows.
    const chunkStore = new Map<string, any[]>();
    const upserts: Array<{ slug: string; chunkCount: number }> = [];
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => ['new-page'],
      getPage: async (slug: string) =>
        slug === 'new-page'
          ? {
              slug: 'new-page',
              compiled_truth: 'Hello world. This is some content for embedding.',
              timeline: '',
            }
          : null,
      getChunks: async (slug: string) => chunkStore.get(slug) ?? [],
      upsertChunks: async (slug: string, inputs: any[]) => {
        upserts.push({ slug, chunkCount: inputs.length });
        // Store as Chunk shape: chunk_index + chunk_text + embedded_at (null
        // on first upsert so the subsequent stale-filter still catches them).
        chunkStore.set(slug, inputs.map(i => ({
          chunk_index: i.chunk_index,
          chunk_text: i.chunk_text,
          chunk_source: i.chunk_source,
          embedded_at: null,
          token_count: 5,
        })));
      },
    });

    await runEmbed(engine, ['--stale']);

    // First upsert creates the initial chunks.
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    expect(upserts[0].slug).toBe('new-page');
    expect(upserts[0].chunkCount).toBeGreaterThan(0);
    // Embedding must have run for the new chunks (second upsert writes them back).
    expect(totalEmbedCalls).toBeGreaterThan(0);
  });

  test('zero-chunk pages: one bootstrap failure does not abort the batch', async () => {
    // Regression guard: if getPage or upsertChunks throws for one zero-chunk
    // page, the worker pool must log and continue with the remaining pages,
    // not reject Promise.all and drop everything else on the floor.
    const chunkStore = new Map<string, any[]>();
    const upserts: string[] = [];
    let getPageCalls = 0;
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => ['bad-page', 'good-page'],
      getPage: async (slug: string) => {
        getPageCalls++;
        if (slug === 'bad-page') throw new Error('simulated DB blip');
        return { slug, compiled_truth: 'Good content for embedding.', timeline: '' };
      },
      getChunks: async (slug: string) => chunkStore.get(slug) ?? [],
      upsertChunks: async (slug: string, inputs: any[]) => {
        upserts.push(slug);
        chunkStore.set(slug, inputs.map(i => ({
          chunk_index: i.chunk_index,
          chunk_text: i.chunk_text,
          chunk_source: i.chunk_source,
          embedded_at: null,
          token_count: 5,
        })));
      },
    });

    // Should NOT throw - the bad page's error is caught per-page.
    await runEmbed(engine, ['--stale']);

    expect(getPageCalls).toBe(2);
    // Good page completed all the way through embed + final upsert.
    // 'bad-page' never upserted (failed at getPage). 'good-page' upserted
    // twice (initial chunk write, then embedding write-back).
    expect(upserts.filter(s => s === 'good-page').length).toBeGreaterThanOrEqual(1);
    expect(upserts.filter(s => s === 'bad-page').length).toBe(0);
    expect(totalEmbedCalls).toBeGreaterThan(0);
  });

  test('zero-chunk pages in dry-run: counts would_embed without any write or API call', async () => {
    const upserts: string[] = [];
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => ['new-page'],
      getPage: async () => ({
        slug: 'new-page',
        compiled_truth: 'short text',
        timeline: '',
      }),
      getChunks: async () => [],
      upsertChunks: async (slug: string) => { upserts.push(slug); },
    });

    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    expect(upserts).toEqual([]);
    expect(totalEmbedCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.would_embed).toBeGreaterThan(0);
    // pending_pages flows from listSlugsPendingEmbedding's return through
    // embedAllStale into the EmbedResult so cycle.ts can report it without
    // a second query.
    expect(result.pending_pages).toBe(1);
  });

  test('fast-path: staleOnly with N stale slugs skips listPages AND getPage (no hydration fan-out)', async () => {
    // Regression guard for the codex-caught bug: the stale-path must iterate
    // slugs directly, NOT hydrate them via Promise.all(staleSlugs.map(getPage)).
    // That fan-out would fire ahead of the GBRAIN_EMBED_CONCURRENCY throttle
    // on a large-stale-brain and reintroduce the pool exhaustion this fix
    // is meant to address.
    const staleSlugs = Array.from({ length: 500 }, (_, i) => `page-${i}`);
    const chunksBySlug = new Map(
      staleSlugs.map(s => [
        s,
        [{ chunk_index: 0, chunk_text: `t ${s}`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 }],
      ]),
    );
    // Stale-rows path: every slug has exactly one chunk with embedding IS NULL,
    // so listStaleChunks returns 500 rows. embedAllStale must take the
    // merge-preserve branch (no getPage call) for each.
    const staleRows = staleSlugs.map(s => ({
      slug: s, chunk_index: 0, chunk_text: `t ${s}`, chunk_source: 'compiled_truth' as const, model: null, token_count: 1,
    }));

    let listPagesCalls = 0;
    let getPageCalls = 0;
    const engine = mockEngine({
      countStaleChunks: async () => 500,
      listStaleChunks: async () => staleRows,
      listSlugsPendingEmbedding: async () => staleSlugs,
      listPages: async () => { listPagesCalls++; return []; },
      getPage: async () => { getPageCalls++; return null; },
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '10';
    await runEmbed(engine, ['--stale']);

    // embedBatch runs for each stale slug (through the worker pool).
    expect(totalEmbedCalls).toBe(500);
    // But no pre-embed fan-out:
    expect(listPagesCalls).toBe(0);
    expect(getPageCalls).toBe(0);
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
      listSlugsPendingEmbedding: async () => pages.map(p => p.slug),
      getPage: async (slug: string) => pages.find(p => p.slug === slug) ?? null,
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
    // 3 mocked slugs in listSlugsPendingEmbedding, threaded into result.
    expect(result.pending_pages).toBe(3);
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
      // Same slug set as bySlug; no zero-chunk pages in this test.
      listSlugsPendingEmbedding: async () => ['partial', 'all-stale'],
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    expect(totalEmbedCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    // Fast path only iterates stale pages, so counts reflect those:
    // 'partial' (2 chunks: 1 stale + 1 skipped) + 'all-stale' (2 stale)
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
      // Same slug set as bySlug; no zero-chunk pages in this test.
      listSlugsPendingEmbedding: async () => ['a', 'b'],
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
      // Pre-flight runs in parallel with countStaleChunks; both must return
      // empty for the fast-exit branch.
      listSlugsPendingEmbedding: async () => [],
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
      // Same slug set as bySlug; no zero-chunk pages in this test.
      listSlugsPendingEmbedding: async () => ['page-a', 'page-b'],
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
      // Same slug set as bySlug; no zero-chunk pages in this test.
      listSlugsPendingEmbedding: async () => ['page-a', 'page-b'],
      upsertChunks: async (slug: string) => { upserts.push(slug); },
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    expect(totalEmbedCalls).toBe(0);
    expect(upserts).toEqual([]);
    expect(result.would_embed).toBe(2);
    expect(result.pages_processed).toBe(2);
    expect(result.dryRun).toBe(true);
  });

  test('zero-chunk-page-only stale: countStaleChunks=0 but listSlugsPendingEmbedding has new pages, must chunk and embed', async () => {
    // Closes the gap codex flagged: upstream's `countStaleChunks() === 0` early
    // return only counts content_chunks rows. Pages created via direct putPage
    // (migrate-engine, enrichment-service, output/writer) have no rows at all,
    // so they'd be silently skipped without listSlugsPendingEmbedding's
    // zero-chunk UNION branch.
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const chunkStore = new Map<string, any[]>();
    const upserts: Array<{ slug: string; chunkCount: number }> = [];
    const engine = mockEngine({
      countStaleChunks: async () => 0, // No stale chunk rows.
      listStaleChunks: async () => [], // Belt-and-suspenders; should not be called.
      listSlugsPendingEmbedding: async () => ['new-page'], // Zero-chunk page surfaces here.
      getPage: async (slug: string) =>
        slug === 'new-page'
          ? { slug, compiled_truth: 'Fresh content that needs chunking and embedding.', timeline: '' }
          : null,
      getChunks: async (slug: string) => chunkStore.get(slug) ?? [],
      upsertChunks: async (slug: string, inputs: any[]) => {
        upserts.push({ slug, chunkCount: inputs.length });
        chunkStore.set(slug, inputs.map(i => ({
          chunk_index: i.chunk_index,
          chunk_text: i.chunk_text,
          chunk_source: i.chunk_source,
          embedded_at: null,
          token_count: 5,
        })));
      },
    });

    const result = await runEmbedCore(engine, { stale: true });

    // The page got chunked (initial upsert) AND embedded (write-back upsert).
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    expect(upserts[0].slug).toBe('new-page');
    expect(upserts[0].chunkCount).toBeGreaterThan(0);
    expect(totalEmbedCalls).toBeGreaterThan(0);
    expect(result.embedded).toBeGreaterThan(0);
    expect(result.pages_processed).toBe(1);
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
