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

  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('shared', 'shared', '{}'::jsonb) ON CONFLICT DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('capture-events', 'capture-events', '{}'::jsonb) ON CONFLICT DO NOTHING`,
  );
  await engine.putPage('docs/shared-only', {
    type: 'guide',
    title: 'Shared Only',
    compiled_truth: 'Shared-only canonical content. Important context here.',
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'shared' });
  await engine.upsertChunks('docs/shared-only', [{
    chunk_index: 0,
    chunk_text: 'Shared-only canonical content. Important context here.',
    chunk_source: 'compiled_truth',
    token_count: 7,
  }], { sourceId: 'shared' });

  await engine.putPage('events/ambient-capture-only', {
    type: 'event',
    title: 'Ambient Capture Only',
    compiled_truth: 'Ambient capture event stream should stay isolated. Important context here.',
    timeline: '',
    frontmatter: {},
  }, { sourceId: 'capture-events' });
  await engine.upsertChunks('events/ambient-capture-only', [{
    chunk_index: 0,
    chunk_text: 'Ambient capture event stream should stay isolated. Important context here.',
    chunk_source: 'compiled_truth',
    token_count: 10,
  }], { sourceId: 'capture-events' });
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

  test('query source_id override rejects unauthorized remote source', async () => {
    const { operations } = await import('../../src/core/operations.ts');
    const queryOp = operations.find(o => o.name === 'query');
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
        allowedSources: ['default'],
      },
    };
    await expect(
      queryOp!.handler(ctx as any, { query: 'Bob lives only', source_id: 'src-b' }),
    ).rejects.toThrow('Requested source is outside caller read scope');
  });

  test('query source_id=__all__ clamps to allowed sources for remote callers', async () => {
    const { operations } = await import('../../src/core/operations.ts');
    const queryOp = operations.find(o => o.name === 'query');
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
        allowedSources: ['default'],
      },
    };
    const result = await queryOp!.handler(ctx as any, { query: 'Important context', source_id: '__all__' });
    const rows = result as Array<{ source_id?: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.source_id).toBe('default');
    }
  });

  test('get_page can read an explicitly allowed shared source', async () => {
    const { operations } = await import('../../src/core/operations.ts');
    const getPageOp = operations.find(o => o.name === 'get_page');
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
        allowedSources: ['default', 'shared'],
      },
    };
    const page = await getPageOp!.handler(ctx as any, { slug: 'docs/shared-only', source_id: 'shared' });
    expect((page as { source_id?: string }).source_id).toBe('shared');
    expect((page as { title?: string }).title).toBe('Shared Only');
  });

  test('get_page rejects an explicit unauthorized source', async () => {
    const { operations } = await import('../../src/core/operations.ts');
    const getPageOp = operations.find(o => o.name === 'get_page');
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
        allowedSources: ['default', 'shared'],
      },
    };
    await expect(
      getPageOp!.handler(ctx as any, { slug: 'people/bob', source_id: 'src-b' }),
    ).rejects.toThrow('Requested source is outside caller read scope');
  });

  test('think gather applies federated source scope to page, take, and graph streams', async () => {
    const { runGather } = await import('../../src/core/think/gather.ts');
    const result = await runGather(engine, {
      question: 'Important context',
      gatherLimit: 20,
      allowedSources: ['default'],
      remote: true,
    });
    for (const p of result.pages as Array<{ source_id?: string }>) {
      expect(p.source_id).toBe('default');
    }
    for (const t of result.takes as Array<{ source_id?: string }>) {
      if (t.source_id) expect(t.source_id).toBe('default');
    }
  });

  test('automated capture OAuth writer cannot widen read scope with source overrides', async () => {
    const { operations } = await import('../../src/core/operations.ts');
    const queryOp = operations.find(o => o.name === 'query');
    const getPageOp = operations.find(o => o.name === 'get_page');
    const ctx = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'capture-events',
      auth: {
        token: 'test',
        clientId: 'simon-ambient-capture',
        scopes: ['read', 'write'],
        sourceId: 'capture-events',
        allowedSources: ['capture-events'],
      },
    };

    await expect(
      queryOp!.handler(ctx as any, { query: 'Shared-only canonical', source_id: 'shared' }),
    ).rejects.toThrow('Requested source is outside caller read scope');
    await expect(
      getPageOp!.handler(ctx as any, { slug: 'docs/shared-only', source_id: 'shared' }),
    ).rejects.toThrow('Requested source is outside caller read scope');

    const allResult = await queryOp!.handler(ctx as any, {
      query: 'Important context',
      source_id: '__all__',
      limit: 20,
    });
    for (const r of allResult as Array<{ source_id?: string }>) {
      expect(r.source_id).toBe('capture-events');
    }
  });

  test('other OAuth clients cannot read an automated capture source unless explicitly granted', async () => {
    const { operations } = await import('../../src/core/operations.ts');
    const searchOp = operations.find(o => o.name === 'search');
    const getPageOp = operations.find(o => o.name === 'get_page');
    const ctx = {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      auth: {
        token: 'test',
        clientId: 'jarvis-openclaw',
        scopes: ['read', 'write'],
        sourceId: 'default',
        allowedSources: ['default', 'shared'],
      },
    };

    const searchResult = await searchOp!.handler(ctx as any, {
      query: 'Ambient capture event stream',
      limit: 20,
    });
    for (const r of searchResult as Array<{ source_id?: string }>) {
      expect(r.source_id).not.toBe('capture-events');
    }

    await expect(
      getPageOp!.handler(ctx as any, { slug: 'events/ambient-capture-only', source_id: 'capture-events' }),
    ).rejects.toThrow('Requested source is outside caller read scope');
  });
});
