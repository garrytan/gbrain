/**
 * v0.42.63 — frontmatter-field filter (U1), canonical PGLite coverage.
 *
 * Four layers, tightest-first:
 *   1. Op-boundary validator (parseFrontmatterFilterParam) — invalid input
 *      throws loudly, never silently degrades to unfiltered.
 *   2. Engine surface (searchKeyword / searchVector / listPages) — the
 *      shared SQL compiler filters at SQL level on PGLite. Postgres parity
 *      is pinned by test/e2e/frontmatter-filter-pg.test.ts (DATABASE_URL-
 *      gated; PGLite can't surface the postgres.js jsonb bind class).
 *   3. Cache-skip disjunction (hasCacheSkippingFilters) — per-call filters
 *      are not part of knobsHash, so their presence must skip the semantic
 *      query cache.
 *   4. Op layer — query's types[] validation against the active schema
 *      pack, and frontmatter_filter threading through search/list_pages.
 *
 * Style follows test/search-types-filter.test.ts (basis embeddings,
 * gateway pinned to 1536d so the file is hermetic in CI shards).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import {
  parseFrontmatterFilterParam,
  compileFrontmatterFilter,
} from '../src/core/search/frontmatter-filter.ts';
import { hasCacheSkippingFilters } from '../src/core/search/hybrid.ts';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

const SHARED = 'frontmatter-filter-target-xyz';

beforeAll(async () => {
  // Pin gateway dims so initSchema sizes vector(1536) — same rationale as
  // test/search-types-filter.test.ts (DEFAULT_EMBEDDING_DIMENSIONS drift).
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const seed: Array<{
    slug: string;
    title: string;
    frontmatter: Record<string, unknown>;
    embIdx: number;
  }> = [
    {
      slug: 'wiki/projects/alpha',
      title: 'Project Alpha',
      // review_by in the past relative to the lt cutoff below; numeric priority
      // pins type-sensitive eq containment.
      frontmatter: { status: 'active', priority: 1, review_by: '2026-07-01' },
      embIdx: 10,
    },
    {
      slug: 'wiki/projects/beta',
      title: 'Project Beta',
      frontmatter: { status: 'paused', review_by: '2026-12-31' },
      embIdx: 11,
    },
    {
      slug: 'wiki/decisions/d1',
      title: 'Decision One',
      frontmatter: { decided: true }, // no actual_outcome yet
      embIdx: 12,
    },
    {
      slug: 'wiki/decisions/d2',
      title: 'Decision Two',
      frontmatter: { decided: true, actual_outcome: 'worked' }, // backfilled
      embIdx: 13,
    },
  ];
  for (const s of seed) {
    await engine.putPage(s.slug, {
      type: 'note',
      title: s.title,
      compiled_truth: `${s.title} mentions ${SHARED}.`,
      frontmatter: s.frontmatter,
    });
    await engine.upsertChunks(s.slug, [
      {
        chunk_index: 0,
        chunk_text: `${s.title} mentions ${SHARED}.`,
        chunk_source: 'compiled_truth',
        embedding: basisEmbedding(s.embIdx),
        token_count: 10,
      },
    ]);
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

// ---------------------------------------------------------------------------
// 1. Op-boundary validator
// ---------------------------------------------------------------------------

describe('parseFrontmatterFilterParam — validation is loud', () => {
  test('absent / null / empty → undefined (no filter)', () => {
    expect(parseFrontmatterFilterParam(undefined)).toBeUndefined();
    expect(parseFrontmatterFilterParam(null)).toBeUndefined();
    expect(parseFrontmatterFilterParam([])).toBeUndefined();
    expect(parseFrontmatterFilterParam('')).toBeUndefined();
  });

  test('accepts the MCP array shape and the CLI JSON-string shape', () => {
    const arr = [{ key: 'status', op: 'eq', value: 'active' }];
    expect(parseFrontmatterFilterParam(arr)).toEqual([{ key: 'status', op: 'eq', value: 'active' }]);
    expect(parseFrontmatterFilterParam(JSON.stringify(arr))).toEqual([
      { key: 'status', op: 'eq', value: 'active' },
    ]);
  });

  test('SQL metacharacters in key → throws', () => {
    expect(() => parseFrontmatterFilterParam([{ key: "a'; DROP TABLE pages;--", op: 'eq', value: 1 }]))
      .toThrow(/Invalid frontmatter_filter/);
    expect(() => parseFrontmatterFilterParam([{ key: 'a b', op: 'exists' }]))
      .toThrow(/Invalid frontmatter_filter/);
    expect(() => parseFrontmatterFilterParam([{ key: '', op: 'exists' }]))
      .toThrow(/Invalid frontmatter_filter/);
  });

  test('unknown op → throws', () => {
    expect(() => parseFrontmatterFilterParam([{ key: 'status', op: 'like', value: 'a%' }]))
      .toThrow(/unknown op/);
  });

  test('non-scalar eq value → throws', () => {
    expect(() => parseFrontmatterFilterParam([{ key: 'status', op: 'eq', value: { nested: true } }]))
      .toThrow(/Invalid frontmatter_filter/);
    expect(() => parseFrontmatterFilterParam([{ key: 'status', op: 'eq', value: ['a'] }]))
      .toThrow(/Invalid frontmatter_filter/);
    expect(() => parseFrontmatterFilterParam([{ key: 'status', op: 'eq' }]))
      .toThrow(/Invalid frontmatter_filter/);
  });

  test('value supplied to exists/missing → throws; boolean value on lt → throws', () => {
    expect(() => parseFrontmatterFilterParam([{ key: 'status', op: 'exists', value: 'x' }]))
      .toThrow(/takes no value/);
    expect(() => parseFrontmatterFilterParam([{ key: 'review_by', op: 'lt', value: true }]))
      .toThrow(/Invalid frontmatter_filter/);
  });

  test('malformed JSON string / non-array JSON → throws', () => {
    expect(() => parseFrontmatterFilterParam('not json')).toThrow(/not valid JSON/);
    expect(() => parseFrontmatterFilterParam('{"key":"a"}')).toThrow(/expected an array/);
  });
});

// ---------------------------------------------------------------------------
// 2. Engine surface — searchKeyword / searchVector / listPages (PGLite)
// ---------------------------------------------------------------------------

describe('searchKeyword — frontmatter filter', () => {
  test('no filter: all four seeded pages match the shared keyword', async () => {
    const results = await engine.searchKeyword(SHARED, { limit: 10 });
    expect(results.length).toBe(4);
  });

  test('eq matches status=active, excludes others', async () => {
    const results = await engine.searchKeyword(SHARED, {
      limit: 10,
      frontmatterFilter: [{ key: 'status', op: 'eq', value: 'active' }],
    });
    expect(results.map((r) => r.slug)).toEqual(['wiki/projects/alpha']);
  });

  test('eq is type-sensitive: numeric 1 matches jsonb number, string "1" does not', async () => {
    const num = await engine.searchKeyword(SHARED, {
      limit: 10,
      frontmatterFilter: [{ key: 'priority', op: 'eq', value: 1 }],
    });
    expect(num.map((r) => r.slug)).toEqual(['wiki/projects/alpha']);
    const str = await engine.searchKeyword(SHARED, {
      limit: 10,
      frontmatterFilter: [{ key: 'priority', op: 'eq', value: '1' }],
    });
    expect(str.length).toBe(0);
  });

  test('missing finds the decision without actual_outcome; exists excludes it', async () => {
    const missing = await engine.searchKeyword(SHARED, {
      limit: 10,
      frontmatterFilter: [
        { key: 'decided', op: 'eq', value: true },
        { key: 'actual_outcome', op: 'missing' },
      ],
    });
    expect(missing.map((r) => r.slug)).toEqual(['wiki/decisions/d1']);

    const exists = await engine.searchKeyword(SHARED, {
      limit: 10,
      frontmatterFilter: [
        { key: 'decided', op: 'eq', value: true },
        { key: 'actual_outcome', op: 'exists' },
      ],
    });
    expect(exists.map((r) => r.slug)).toEqual(['wiki/decisions/d2']);
  });

  test('lt on ISO date matches past-due, excludes future and keyless pages', async () => {
    const results = await engine.searchKeyword(SHARED, {
      limit: 10,
      frontmatterFilter: [{ key: 'review_by', op: 'lt', value: '2026-07-18' }],
    });
    // beta (2026-12-31) is in the future; d1/d2 have no review_by → NULL
    // comparison excludes them.
    expect(results.map((r) => r.slug)).toEqual(['wiki/projects/alpha']);
  });

  test('combined predicates AND together', async () => {
    const both = await engine.searchKeyword(SHARED, {
      limit: 10,
      frontmatterFilter: [
        { key: 'status', op: 'eq', value: 'active' },
        { key: 'review_by', op: 'lt', value: '2026-07-18' },
      ],
    });
    expect(both.map((r) => r.slug)).toEqual(['wiki/projects/alpha']);

    const contradiction = await engine.searchKeyword(SHARED, {
      limit: 10,
      frontmatterFilter: [
        { key: 'status', op: 'eq', value: 'paused' },
        { key: 'review_by', op: 'lt', value: '2026-07-18' },
      ],
    });
    expect(contradiction.length).toBe(0);
  });
});

describe('searchVector — frontmatter filter', () => {
  test('eq excludes non-matching pages from vector results', async () => {
    const results = await engine.searchVector(basisEmbedding(10), {
      limit: 10,
      frontmatterFilter: [{ key: 'status', op: 'eq', value: 'active' }],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.slug).toBe('wiki/projects/alpha');
  });

  test('gte on ISO date keeps only the future review', async () => {
    const results = await engine.searchVector(basisEmbedding(11), {
      limit: 10,
      frontmatterFilter: [{ key: 'review_by', op: 'gte', value: '2026-07-18' }],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.slug).toBe('wiki/projects/beta');
  });
});

describe('listPages — frontmatter filter', () => {
  test('eq matches status=active only', async () => {
    const pages = await engine.listPages({
      frontmatterFilter: [{ key: 'status', op: 'eq', value: 'active' }],
    });
    expect(pages.map((p) => p.slug)).toEqual(['wiki/projects/alpha']);
  });

  test('missing + exists split the decision pages', async () => {
    const missing = await engine.listPages({
      frontmatterFilter: [
        { key: 'decided', op: 'eq', value: true },
        { key: 'actual_outcome', op: 'missing' },
      ],
    });
    expect(missing.map((p) => p.slug)).toEqual(['wiki/decisions/d1']);
    const exists = await engine.listPages({
      frontmatterFilter: [
        { key: 'decided', op: 'eq', value: true },
        { key: 'actual_outcome', op: 'exists' },
      ],
    });
    expect(exists.map((p) => p.slug)).toEqual(['wiki/decisions/d2']);
  });

  test('no filter returns all pages (absent param leaves behavior unchanged)', async () => {
    const pages = await engine.listPages({});
    expect(pages.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 3. Cache-skip disjunction
// ---------------------------------------------------------------------------

describe('hasCacheSkippingFilters — per-call filters skip the query cache', () => {
  test('frontmatterFilter present → true', () => {
    expect(hasCacheSkippingFilters({ frontmatterFilter: [{ key: 'a', op: 'exists' }] })).toBe(true);
  });
  test('non-empty types → true; empty types → false', () => {
    expect(hasCacheSkippingFilters({ types: ['person'] })).toBe(true);
    expect(hasCacheSkippingFilters({ types: [] })).toBe(false);
  });
  test('since / until / legacy aliases → true', () => {
    expect(hasCacheSkippingFilters({ since: '7d' })).toBe(true);
    expect(hasCacheSkippingFilters({ until: '2026-07-18' })).toBe(true);
    expect(hasCacheSkippingFilters({ afterDate: '2026-01-01' })).toBe(true);
    expect(hasCacheSkippingFilters({ beforeDate: '2026-01-01' })).toBe(true);
  });
  test('no filters → false (unfiltered queries keep caching)', () => {
    expect(hasCacheSkippingFilters(undefined)).toBe(false);
    expect(hasCacheSkippingFilters({})).toBe(false);
    expect(hasCacheSkippingFilters({ limit: 5, offset: 10 })).toBe(false);
  });

  test('integration: filtered hybridSearchCached reports cache disabled', async () => {
    const { hybridSearchCached } = await import('../src/core/search/hybrid.ts');
    let meta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    await hybridSearchCached(engine, SHARED, {
      limit: 5,
      useCache: true,
      frontmatterFilter: [{ key: 'status', op: 'eq', value: 'active' }],
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.cache?.status).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// 4. Op layer — query types[] validation + frontmatter_filter threading
// ---------------------------------------------------------------------------

function opCtx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as unknown as OperationContext['engine'],
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...over,
  } as unknown as OperationContext;
}

describe('query op — types[] validated against the active schema pack', () => {
  let tmpHome: string;

  beforeEach(() => {
    _resetPackCacheForTests();
    _resetPackLocatorForTests();
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-fm-filter-test-'));
  });

  afterAll(() => {
    _resetPackCacheForTests();
    _resetPackLocatorForTests();
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('unknown type → loud OperationError naming the active pack and valid types', async () => {
    const query = operationsByName['query']!;
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const err = await query.handler(opCtx(), { query: SHARED, types: ['definitely-not-a-type-xyz'] })
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OperationError);
      const msg = (err as Error).message;
      expect(msg).toContain('definitely-not-a-type-xyz');
      expect(msg).toContain('gbrain-base');
      expect(msg).toContain('person');
    });
  });

  test('declared type passes validation and filters results (array + CLI comma string)', async () => {
    const query = operationsByName['query']!;
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      // All seeded pages are type 'note' — a person-only query returns none.
      const personOnly = (await query.handler(opCtx(), {
        query: SHARED, types: ['person'], expand: false,
      })) as Array<{ slug: string }>;
      expect(personOnly.length).toBe(0);

      // 'note' is declared in gbrain-base; comma-string shape (CLI) works.
      const notes = (await query.handler(opCtx(), {
        query: SHARED, types: 'note', expand: false,
      })) as Array<{ slug: string; type: string }>;
      expect(notes.length).toBeGreaterThan(0);
      for (const r of notes) expect(r.type).toBe('note');
    });
  });

  test('non-string array entries → loud error', async () => {
    const query = operationsByName['query']!;
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const err = await query.handler(opCtx(), { query: SHARED, types: [42] })
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OperationError);
    });
  });

  test('query op honors frontmatter_filter end-to-end', async () => {
    const query = operationsByName['query']!;
    await withEnv({ GBRAIN_HOME: tmpHome, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const results = (await query.handler(opCtx(), {
        query: SHARED,
        expand: false,
        frontmatter_filter: [{ key: 'status', op: 'eq', value: 'active' }],
      })) as Array<{ slug: string }>;
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) expect(r.slug).toBe('wiki/projects/alpha');
    });
  });
});

describe('search + list_pages ops — frontmatter_filter threading', () => {
  test('search op filters via frontmatter_filter (JSON-string CLI shape)', async () => {
    const search = operationsByName['search']!;
    const results = (await search.handler(opCtx(), {
      query: SHARED,
      frontmatter_filter: JSON.stringify([{ key: 'status', op: 'eq', value: 'active' }]),
    })) as Array<{ slug: string }>;
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.slug).toBe('wiki/projects/alpha');
  });

  test('search op rejects invalid frontmatter_filter loudly', async () => {
    const search = operationsByName['search']!;
    await expect(
      search.handler(opCtx(), { query: SHARED, frontmatter_filter: [{ key: 'x', op: 'nope' }] }),
    ).rejects.toThrow(/unknown op/);
  });

  test('list_pages op filters via frontmatter_filter', async () => {
    const listPages = operationsByName['list_pages']!;
    const rows = (await listPages.handler(opCtx(), {
      frontmatter_filter: [{ key: 'actual_outcome', op: 'exists' }],
    })) as Array<{ slug: string }>;
    expect(rows.map((r) => r.slug)).toEqual(['wiki/decisions/d2']);
  });
});

// ---------------------------------------------------------------------------
// Compiler unit — params are BOUND, never interpolated
// ---------------------------------------------------------------------------

describe('compileFrontmatterFilter — binding discipline', () => {
  test('keys and values land in params; SQL references only $N placeholders', () => {
    const params: unknown[] = ['pre-existing'];
    const conds = compileFrontmatterFilter(
      [
        { key: 'status', op: 'eq', value: 'active' },
        { key: 'flag', op: 'exists' },
        { key: 'flag2', op: 'missing' },
        { key: 'review_by', op: 'lte', value: '2026-01-01' },
      ],
      params,
      'p.frontmatter',
    );
    expect(conds).toEqual([
      'p.frontmatter @> $2::text::jsonb',
      'p.frontmatter ? $3::text',
      'NOT (p.frontmatter ? $4::text)',
      '(p.frontmatter ->> $5::text) <= $6::text',
    ]);
    expect(params).toEqual([
      'pre-existing',
      JSON.stringify({ status: 'active' }),
      'flag',
      'flag2',
      'review_by',
      '2026-01-01',
    ]);
  });

  test('empty / absent predicates compile to nothing', () => {
    const params: unknown[] = [];
    expect(compileFrontmatterFilter(undefined, params, 'p.frontmatter')).toEqual([]);
    expect(compileFrontmatterFilter([], params, 'p.frontmatter')).toEqual([]);
    expect(params.length).toBe(0);
  });
});
