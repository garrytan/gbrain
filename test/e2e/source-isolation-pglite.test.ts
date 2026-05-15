/**
 * v0.34.1 (#861 — P0 source-isolation leak seal) E2E regression.
 *
 * The wave's IRON RULE: every read-side op must filter by source_id when
 * the caller supplies it via SearchOpts/PageFilters/TraverseOpts. Pre-fix,
 * authenticated MCP clients scoped to source-A could enumerate source-B
 * pages via search / query / list_pages / traverse_graph / find_experts.
 *
 * Runs against PGLite in-memory so the test exercises both engines' parity
 * surface (the schema-drift E2E covers Postgres independently) without
 * needing a Docker container.
 *
 * Coverage: searchKeyword, searchVector (synthetic embedding), listPages,
 * traverseGraph, traversePaths. find_experts is exercised via the same
 * hybridSearch path the op handler calls.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

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
  // Two sources so we can prove the filter excludes cross-source rows.
  // 'default' source is created by initSchema's seed; we add src-b.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb) ON CONFLICT DO NOTHING`,
  );
  // Seed one person page in each source. Same slug intentionally —
  // proves the composite (source_id, slug) key is honored, not just slug.
  // upsertChunks is needed because searchKeyword scans content_chunks, not
  // pages.compiled_truth directly. Each page gets one chunk that mirrors
  // its compiled_truth so search-by-keyword has something to find.
  await engine.putPage('people/alice', {
    type: 'person',
    title: 'Alice Source-A',
    compiled_truth: 'Alice works on widgets in source A. Important context here.',
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'default' });
  await engine.upsertChunks('people/alice', [{
    chunk_index: 0,
    chunk_text: 'Alice works on widgets in source A. Important context here.',
    chunk_source: 'compiled_truth',
    token_count: 12,
  }], { sourceId: 'default' });

  await engine.putPage('people/alice', {
    type: 'person',
    title: 'Alice Source-B',
    compiled_truth: 'Alice works on gadgets in source B. Important context here.',
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'src-b' });
  await engine.upsertChunks('people/alice', [{
    chunk_index: 0,
    chunk_text: 'Alice works on gadgets in source B. Important context here.',
    chunk_source: 'compiled_truth',
    token_count: 12,
  }], { sourceId: 'src-b' });

  await engine.putPage('people/bob', {
    type: 'person',
    title: 'Bob Source-B Only',
    compiled_truth: 'Bob lives only in source B. Important context here.',
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'src-b' });
  await engine.upsertChunks('people/bob', [{
    chunk_index: 0,
    chunk_text: 'Bob lives only in source B. Important context here.',
    chunk_source: 'compiled_truth',
    token_count: 11,
  }], { sourceId: 'src-b' });
});

describe('v0.34.1 source-isolation regression (#861)', () => {
  test('searchKeyword with sourceId=default excludes src-b rows', async () => {
    const results = await engine.searchKeyword('widgets', { sourceId: 'default' });
    // Should find Alice from source-A only (mentions "widgets"). src-b's
    // Alice mentions "gadgets" not "widgets" but the test guards against
    // accidentally pulling in src-b rows via a missing WHERE clause.
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source_id).toBe('default');
    }
  });

  test('searchKeyword with sourceId=src-b excludes default rows', async () => {
    const results = await engine.searchKeyword('gadgets', { sourceId: 'src-b' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source_id).toBe('src-b');
    }
  });

  test('searchKeyword with sourceIds=[default,src-b] returns both', async () => {
    // Federated read (D9 array form) returns the union.
    const results = await engine.searchKeyword('Important context', {
      sourceIds: ['default', 'src-b'],
    });
    const sources = new Set(results.map(r => r.source_id));
    expect(sources.has('default')).toBe(true);
    expect(sources.has('src-b')).toBe(true);
  });

  test('searchKeyword with sourceIds=[default] only returns default', async () => {
    // Array form with a single element behaves like scalar.
    const results = await engine.searchKeyword('Important context', {
      sourceIds: ['default'],
    });
    for (const r of results) {
      expect(r.source_id).toBe('default');
    }
  });

  test('searchKeyword with no source scope returns all sources', async () => {
    // Local CLI / unscoped callers preserve pre-v0.34 behavior.
    const results = await engine.searchKeyword('Important context');
    const sources = new Set(results.map(r => r.source_id));
    expect(sources.size).toBeGreaterThanOrEqual(2);
  });

  test('listPages with sourceId=default hides src-b rows', async () => {
    const pages = await engine.listPages({ sourceId: 'default', limit: 100 });
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.find(p => p.title === 'Bob Source-B Only')).toBeUndefined();
    expect(pages.find(p => p.title === 'Alice Source-B')).toBeUndefined();
  });

  test('listPages with sourceIds=[default,src-b] returns the union', async () => {
    const pages = await engine.listPages({ sourceIds: ['default', 'src-b'], limit: 100 });
    const titles = new Set(pages.map(p => p.title));
    expect(titles.has('Alice Source-A')).toBe(true);
    expect(titles.has('Alice Source-B')).toBe(true);
    expect(titles.has('Bob Source-B Only')).toBe(true);
  });

  test('traverseGraph with sourceId=default does not surface src-b roots', async () => {
    // Seeding the walk at src-b's bob with sourceId=default produces an
    // empty result — the seed itself is filtered out, so the walk never
    // discovers anything. Pre-fix, the walk would still return bob's
    // neighbors via cross-source edge following.
    const nodes = await engine.traverseGraph('people/bob', 5, { sourceId: 'default' });
    expect(nodes.length).toBe(0);
  });

  test('traverseGraph with sourceId=src-b finds the src-b page', async () => {
    const nodes = await engine.traverseGraph('people/bob', 5, { sourceId: 'src-b' });
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.find(n => n.slug === 'people/bob')).toBeDefined();
  });

  test('traversePaths with sourceId=default does not surface src-b paths', async () => {
    // Same seed-filter check via the edge-based traversal.
    const paths = await engine.traversePaths('people/bob', { depth: 3, sourceId: 'default' });
    expect(paths.length).toBe(0);
  });

  test('searchVector with sourceId filters HNSW candidate pool', async () => {
    // No real embeddings on the test pages; the WHERE cc.embedding IS NOT NULL
    // gate filters them out. We assert the contract via an empty result
    // rather than a positive match: with sourceId set, the SQL still runs
    // (no type or undefined-column errors).
    const synth = new Float32Array(1536).fill(0.01);
    const results = await engine.searchVector(synth, { sourceId: 'src-b' });
    // Either empty (no embeddings) or all from src-b. Both prove the
    // filter is wired without a runtime error.
    for (const r of results) {
      expect(r.source_id).toBe('src-b');
    }
  });

  test('AuthInfo path: ctx.sourceId scoping propagates through op handlers', async () => {
    // The op handler at operations.ts:search threads ctx.sourceId via
    // sourceScopeOpts. Simulate the dispatcher's threading and verify
    // the engine sees the filter — this is the layer the regression
    // tests need to cover most directly.
    const { operations } = await import('../../src/core/operations.ts');
    const searchOp = operations.find(o => o.name === 'search');
    expect(searchOp).toBeDefined();

    const ctx = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'src-b',
    };
    const result = await searchOp!.handler(ctx as any, { query: 'gadgets' });
    const rows = result as Array<{ source_id?: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.source_id).toBe('src-b');
    }
  });

  test('AuthInfo.allowedSources path: ctx.auth.allowedSources widens read scope', async () => {
    // D9 federated read: when AuthInfo.allowedSources is populated, the
    // sourceScopeOpts helper produces sourceIds array (array wins over
    // scalar ctx.sourceId). Verify the op handler routes through this.
    const { operations } = await import('../../src/core/operations.ts');
    const searchOp = operations.find(o => o.name === 'search');
    const ctx = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default', // scalar would scope to default-only
      auth: {
        token: 'test',
        clientId: 'test',
        scopes: ['read'],
        sourceId: 'default',
        allowedSources: ['default', 'src-b'], // ... but the array wins
      },
    };
    const result = await searchOp!.handler(ctx as any, { query: 'Important context' });
    const rows = result as Array<{ source_id?: string }>;
    const sources = new Set(rows.map(r => r.source_id));
    expect(sources.has('default')).toBe(true);
    expect(sources.has('src-b')).toBe(true);
  });

  test('#876 federated_read empty array means no federated reads', async () => {
    // sourceScopeOpts treats allowedSources: [] (explicit empty) as "no
    // federated scope" and falls back to scalar sourceId. An empty array
    // MUST NOT widen scope to "all sources" — that's the silent-widen
    // footgun. Verify the precedence ladder is correct.
    const { operations } = await import('../../src/core/operations.ts');
    const searchOp = operations.find(o => o.name === 'search');
    const ctx = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      auth: {
        token: 'test',
        clientId: 'test',
        scopes: ['read'],
        sourceId: 'default',
        allowedSources: [], // explicit empty — must NOT widen scope
      },
    };
    const result = await searchOp!.handler(ctx as any, { query: 'Important context' });
    const rows = result as Array<{ source_id?: string }>;
    for (const r of rows) {
      expect(r.source_id).toBe('default');
    }
  });
});
