/**
 * Search must never show a replaced page as current without saying so.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Protects: (a) when the check for "a newer page supersedes this one" fails (a statement
 *     timeout, a dropped connection), search/query meta carries the degraded stage
 *     `supersede_check_failed` and the CLI renders the degraded-recall notice, instead of
 *     ranking the outdated page first with no flag and no marker; (b) a `supersedes` link added
 *     while the process keeps serving takes effect on the very next search.
 *  2. Regression: `readSupersededBy`'s silent catch (the failure became an empty map) and the
 *     5-minute memo of a negative "no supersedes edge exists" probe.
 *  3. Existing coverage misses it: supersede-downrank.test.ts pins the memo (an edge minted inside
 *     the TTL "is skipped") and fail-open without a marker; no test reads the failure from
 *     meta.degraded or runs add-link between two searches in one process.
 *     (c) the exact-lookup tier (a slug-shaped query puts the page at rank 1) says the same when ITS supersession
 *     read fails, instead of letting the outdated page win the identity slot with no marker.
 *  4. Seam: engine.supersedingPageSlugs is patched to throw SQLSTATE 57014, as
 *     keyword-arm-timeout-cli-7171.test.ts does for the keyword arm. Real PGLite brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { applyCliOpNotices, captureRetrievalNotices } from '../../src/cli/op-notices.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { hybridSearch, _resetSupersedeProbeForTests } from '../../src/core/search/hybrid.ts';
import { _resetWarnOnceForTests } from '../../src/core/utils.ts';
import { structuralExactLookup } from '../../src/core/search/exact-lookup.ts';

const DIM = 1536;
const statementTimeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

describe('supersession check currency (PGLite)', () => {
  let engine: PGLiteEngine;
  let meta: Record<string, unknown> | null = null;
  const ctx = {
    get engine() { return engine; }, remote: false, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} }, emitNotice() {},
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') meta = value as Record<string, unknown>; },
  } as unknown as OperationContext;
  const realSupersedingPageSlugs = PGLiteEngine.prototype.supersedingPageSlugs;
  const realHasSupersedeEdges = PGLiteEngine.prototype.hasSupersedeEdges;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { if (engine) await engine.disconnect(); });

  beforeEach(async () => {
    _resetSupersedeProbeForTests();
    engine.supersedingPageSlugs = realSupersedingPageSlugs;
    engine.hasSupersedeEdges = realHasSupersedeEdges;
    for (const slug of ['notes/pricing-v1', 'notes/pricing-v2']) await engine.deletePage(slug).catch(() => undefined);
    await importFromContent(engine, 'notes/pricing-v1', '# Pricing v1\n\nThe tapirword fee is 10.');
    await importFromContent(engine, 'notes/pricing-v2', '# Pricing v2\n\nThe tapirword fee is 20 now.');
  });

  const slugs = (rows: Array<{ slug: string }>) => rows.map(r => r.slug);

  test('a healthy search flags the outdated page and ranks it below (control)', async () => {
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    const rows = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(slugs(rows)[0]).toBe('notes/pricing-v2');
    expect(rows.find(r => r.slug === 'notes/pricing-v1')).toMatchObject({ superseded: true, superseded_by: 'notes/pricing-v2' });
  });

  test('a failed supersession check reports supersede_check_failed (timeout) in hybridSearch meta', async () => {
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    engine.supersedingPageSlugs = async () => { throw statementTimeout(); };
    let degraded: Array<{ stage: string; reason?: string }> = [];
    const rows = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
    expect(rows.length).toBe(2);
    expect(degraded).toContainEqual({ stage: 'supersede_check_failed', reason: 'timeout' });
  });

  test('the marker only adds information: a failed check returns the same rows as a healthy search without the marker', async () => {
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    const healthy = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    engine.supersedingPageSlugs = async () => { throw statementTimeout(); };
    const failed = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(slugs(failed).sort()).toEqual(slugs(healthy).sort());
    expect(failed.some(r => r.superseded === true)).toBe(false);
  });

  test('any other read error reports reason provider_error, and no raw error text reaches the marker', async () => {
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    engine.supersedingPageSlugs = async () => { throw new Error('connection terminated postgresql://db.example/brain?app=VALUECANARY'); };
    let degraded: Array<{ stage: string; reason?: string }> = [];
    await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
    expect(degraded).toContainEqual({ stage: 'supersede_check_failed', reason: 'provider_error' });
    expect(JSON.stringify(degraded)).not.toContain('VALUECANARY');
    expect(JSON.stringify(degraded)).not.toContain('://');
  });

  test('the supersession warning names only the failure class, never the raw error text or its code', async () => {
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    engine.supersedingPageSlugs = async () => {
      throw Object.assign(new Error('connection terminated postgresql://db.example/brain?app=VALUECANARY'), { code: '57P01' });
    };
    _resetWarnOnceForTests();
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    try {
      await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    } finally {
      console.warn = original;
      _resetWarnOnceForTests();
    }
    const line = warned.find(w => w.includes('supersession check failed'));
    expect(line).toBeDefined();
    expect(line).toContain('provider_error');
    expect(line).not.toContain('57P01');
    expect(line).not.toContain('VALUECANARY');
    expect(line).not.toContain('://');
  });

  test('a brain whose links table does not exist yet stays silent (no edges can exist)', async () => {
    engine.supersedingPageSlugs = async () => { throw Object.assign(new Error('relation "links" does not exist'), { code: '42P01' }); };
    let degraded: Array<{ stage: string }> = [];
    const rows = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
    expect(rows.length).toBe(2);
    expect(degraded.map(d => d.stage)).not.toContain('supersede_check_failed');
  });

  test('a healthy search with no supersedes edge reports nothing', async () => {
    let degraded: Array<{ stage: string }> = [];
    await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false, onMeta: (m) => { degraded = (m.degraded ?? []) as typeof degraded; } });
    expect(degraded.map(d => d.stage)).not.toContain('supersede_check_failed');
  });

  for (const name of ['search', 'query'] as const) {
    test(`${name}: _meta.degraded names the stage and the CLI notice says results may include outdated pages`, async () => {
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      engine.supersedingPageSlugs = async () => { throw statementTimeout(); };
      meta = null;
      const params = { query: 'tapirword', use_cache: false, ...(name === 'query' ? { expand: false } : {}) };
      const rows = await operationsByName[name].handler(ctx, params) as Array<{ slug: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(meta!.degraded).toContainEqual({ stage: 'supersede_check_failed', reason: 'timeout' });
      captureRetrievalNotices(name, rows, meta, params, ctx.config);
      const { result, stderr } = applyCliOpNotices(rows, true);
      expect(Array.isArray(result)).toBe(true);
      expect(stderr).toContain('supersede_check_failed');
      expect(stderr).toMatch(/outdated/);
    });
  }

  test('one process: search before any supersedes link, add the link, search again — the outdated page is flagged and ranks below', async () => {
    const first = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(first.every(r => r.superseded !== true)).toBe(true);
    await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
    const second = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(slugs(second)[0]).toBe('notes/pricing-v2');
    expect(second.find(r => r.slug === 'notes/pricing-v1')).toMatchObject({ superseded: true, superseded_by: 'notes/pricing-v2' });
  });

  for (const name of ['search', 'query'] as const) {
    test(`${name} (default cache): a link added between two calls reorders the second call`, async () => {
      const params = { query: 'tapirword', ...(name === 'query' ? { expand: false } : {}) };
      const before = await operationsByName[name].handler(ctx, params) as Array<{ slug: string; superseded?: boolean }>;
      expect(before.every(r => r.superseded !== true)).toBe(true);
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      const after = await operationsByName[name].handler(ctx, params) as Array<{ slug: string; superseded?: boolean }>;
      expect(slugs(after)[0]).toBe('notes/pricing-v2');
      expect(after.find(r => r.slug === 'notes/pricing-v1')?.superseded).toBe(true);
    });
  }

  test('a link written by another process (straight into the table) is seen at once, with no in-process write to invalidate', async () => {
    await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    const [from] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'notes/pricing-v2'`);
    const [to] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'notes/pricing-v1'`);
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'supersedes', 'manual')`,
      [from!.id, to!.id],
    );
    const rows = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
    expect(slugs(rows)[0]).toBe('notes/pricing-v2');
    expect(rows.find(r => r.slug === 'notes/pricing-v1')?.superseded).toBe(true);
  });

  // The probe is `engine.hasSupersedeEdges()`: one `SELECT 1 FROM links WHERE link_type = 'supersedes' LIMIT 1` (SUPERSEDE_EDGE_PROBE_SQL).
  describe('probe queries per search (the existence probe)', () => {
    let probeStatements = 0;
    beforeEach(() => {
      probeStatements = 0;
      engine.hasSupersedeEdges = async () => { probeStatements++; return realHasSupersedeEdges.call(engine); };
    });
    const searches = async (n: number) => { for (let i = 0; i < n; i++) await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false }); };

    test('a brain with a supersedes link: the first search probes once, the next searches issue no probe query (the cached yes)', async () => {
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      await searches(1);
      expect(probeStatements).toBe(1);
      await searches(5);
      expect(probeStatements).toBe(1);
    });

    test('a brain with no supersedes link probes on every search, and the first search after a link is added already sees it', async () => {
      await searches(3);
      expect(probeStatements).toBe(3);
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      const rows = await hybridSearch(engine, 'tapirword', { limit: 5, useCache: false });
      expect(probeStatements).toBe(4);
      expect(rows.find(r => r.slug === 'notes/pricing-v1')?.superseded).toBe(true);
      await searches(3);
      expect(probeStatements).toBe(4);
    });
  });

  describe('exact-lookup tier (identity slot)', () => {
    const refusal = () => Object.assign(new Error('links not served'), { code: 'engine_capability_missing' });

    test('a slug-shaped query for the outdated page: its identity-slot read fails -> the page still comes back, with the degraded marker', async () => {
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      engine.supersedingPageSlugs = async () => { throw statementTimeout(); };
      const degraded: Array<{ stage: string; reason?: string }> = [];
      const hits = await structuralExactLookup(engine, 'notes/pricing-v1', { sourceId: 'default', degraded: degraded as never });
      expect(hits.map(h => h.slug)).toEqual(['notes/pricing-v1']); // never hides a row
      expect(degraded).toEqual([{ stage: 'supersede_check_failed', reason: 'timeout' }]);
    });

    // The first supersession read (the post-fusion stage) answers; the next one, the tier's own, times out. The post-fusion
    // marker therefore cannot cover for the tier: only the tier's own report can put the marker in the response.
    function failAfterFirstRead() {
      let calls = 0;
      engine.supersedingPageSlugs = async (ids: number[], policy?: Record<string, unknown>) => {
        if (++calls > 1) throw statementTimeout();
        return realSupersedingPageSlugs.call(engine, ids, policy as never);
      };
    }

    for (const name of ['search', 'query'] as const) {
      test(`${name} for the outdated page's slug: the tier's read fails -> the page takes rank 1 and _meta.degraded names supersede_check_failed`, async () => {
        await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
        failAfterFirstRead();
        meta = null;
        const params = { query: 'notes/pricing-v1', use_cache: false, ...(name === 'query' ? { expand: false } : {}) };
        const rows = await operationsByName[name].handler(ctx, params) as Array<{ slug: string }>;
        expect(rows[0]?.slug).toBe('notes/pricing-v1'); // the outdated page holds the identity slot (the failed read cannot filter it)
        expect(meta!.degraded).toContainEqual({ stage: 'supersede_check_failed', reason: 'timeout' });
      });
    }

    test('healthy: the tier keeps the replaced page out of the identity slot and no marker is reported', async () => {
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      meta = null;
      const rows = await operationsByName.search.handler(ctx, { query: 'notes/pricing-v1', use_cache: false }) as Array<{ slug: string; exact_lookup?: string }>;
      expect(rows.some(r => r.exact_lookup === 'slug' && r.slug === 'notes/pricing-v1')).toBe(false);
      expect((meta!.degraded as Array<{ stage: string }>).map(d => d.stage)).not.toContain('supersede_check_failed');
    });

    test('healthy: the replaced page never wins the identity slot, and no marker is stamped', async () => {
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      const degraded: Array<{ stage: string }> = [];
      const hits = await structuralExactLookup(engine, 'notes/pricing-v1', { sourceId: 'default', degraded: degraded as never });
      expect(hits).toEqual([]);
      expect(degraded).toEqual([]);
    });

    test('a refused engine capability reaches the caller, not an empty identity slot', async () => {
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      const err = refusal();
      engine.supersedingPageSlugs = async () => { throw err; };
      await expect(structuralExactLookup(engine, 'notes/pricing-v1', { sourceId: 'default' })).rejects.toBe(err);
    });

    // The identity reads start before the reranker call and are awaited after it. A refusal that lands while the
    // reranker is still working has no awaiting handler yet; it must reach the caller at the later await, not exit the process.
    test('a refused capability that lands while the reranker is in flight reaches the caller and is never an unhandled rejection', async () => {
      // The reranker runs only on the vector path, so the two pages carry fixture embeddings.
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIM, env: {} });
      for (const [slug, title, text, dim] of [['notes/pricing-v1', 'Pricing v1', 'The tapirword fee is 10.', 12], ['notes/pricing-v2', 'Pricing v2', 'The tapirword fee is 20 now.', 13]] as const) {
        await engine.deletePage(slug);
        await engine.putPage(slug, { type: 'note', title, compiled_truth: text });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' as const, embedding: basisEmbedding(dim, DIM), token_count: 8 }]);
      }
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      const err = refusal();
      let calls = 0;
      engine.supersedingPageSlugs = async (ids: number[], policy?: Record<string, unknown>) => {
        if (++calls > 1) throw err;
        return realSupersedingPageSlugs.call(engine, ids, policy as never);
      };
      let reranks = 0;
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        await expect(hybridSearch(engine, 'notes/pricing-v1', {
          limit: 5, useCache: false, queryEmbedFn: () => basisEmbedding(12, DIM),
          reranker: {
            enabled: true, topNIn: 30, topNOut: null,
            rerankerFn: async (input: { documents: unknown[] }) => {
              reranks++;
              await new Promise(resolve => setTimeout(resolve, 100));
              return input.documents.map((_, index) => ({ index, relevanceScore: 1 }));
            },
          },
        })).rejects.toBe(err);
        await new Promise(resolve => setTimeout(resolve, 50));
      } finally {
        process.off('unhandledRejection', onUnhandled);
        resetGateway();
      }
      expect(reranks).toBe(1); // the refusal landed while the reranker was working
      expect(unhandled).toEqual([]);
    });

    test('the supersession read gets the page-read policy only, never the tier\'s own filters (a store that refuses unknown options must not refuse a healthy read)', async () => {
      await engine.addLink('notes/pricing-v2', 'notes/pricing-v1', '', 'supersedes', 'manual');
      let seen: Record<string, unknown> | undefined;
      const real = realSupersedingPageSlugs.bind(engine);
      engine.supersedingPageSlugs = async (ids: number[], policy?: Record<string, unknown>) => { seen = policy; return real(ids, policy as never); };
      await structuralExactLookup(engine, 'notes/pricing-v1', { sourceId: 'default', titleCandidates: [], excludeSlugs: ['x'], type: 'note', degraded: [] });
      expect(seen).toEqual({ sourceId: 'default' });
    });
  });
});
