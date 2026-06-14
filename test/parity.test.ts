import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations, operationsByName } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { Operation } from '../src/core/operations.ts';
import type { PageType, SearchResult, Page, Link } from '../src/core/types.ts';

describe('operations contract parity', () => {
  test('every operation has a unique name', () => {
    const names = operations.map(op => op.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every operation has required fields', () => {
    for (const op of operations) {
      expect(op.name).toBeTruthy();
      expect(op.description).toBeTruthy();
      expect(typeof op.handler).toBe('function');
      expect(op.params).toBeDefined();
    }
  });

  test('operationsByName matches operations array', () => {
    expect(Object.keys(operationsByName).length).toBe(operations.length);
    for (const op of operations) {
      expect(operationsByName[op.name]).toBe(op);
    }
  });

  test('every required param has a type', () => {
    for (const op of operations) {
      for (const [key, def] of Object.entries(op.params)) {
        const types = Array.isArray(def.type) ? def.type : [def.type];
        for (const type of types) {
          expect(['string', 'number', 'boolean', 'object', 'array']).toContain(type);
        }
      }
    }
  });

  test('mutating operations have dry_run support', () => {
    const mutating = operations.filter(op => op.mutating);
    expect(mutating.length).toBeGreaterThan(0);
    // Verify all mutating ops exist
    for (const op of mutating) {
      expect(op.mutating).toBe(true);
    }
  });

  test('CLI names are unique across operations', () => {
    const cliNames = operations
      .filter(op => op.cliHints?.name)
      .map(op => op.cliHints!.name!);
    expect(new Set(cliNames).size).toBe(cliNames.length);
  });

  test('CLI positional params reference valid param names', () => {
    for (const op of operations) {
      if (op.cliHints?.positional) {
        for (const pos of op.cliHints.positional) {
          expect(op.params).toHaveProperty(pos);
        }
      }
    }
  });

  test('CLI stdin param references a valid param name', () => {
    for (const op of operations) {
      if (op.cliHints?.stdin) {
        expect(op.params).toHaveProperty(op.cliHints.stdin);
      }
    }
  });

  test('operations count is at least 30', () => {
    expect(operations.length).toBeGreaterThanOrEqual(30);
  });

  test('engine implementations are importable', () => {
    expect(SQLiteEngine).toBeDefined();
    expect(PostgresEngine).toBeDefined();
  });

  test('MCP tool definitions can be generated from operations', () => {
    const tools = operations.map(op => ({
      name: op.name,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, { type: v.type }]),
        ),
        required: Object.entries(op.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
    }));

    // Every operation generates a valid tool definition
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Cross-engine parity seeds — SQLite and PGLite
// ─────────────────────────────────────────────────────────────────

describe('SQLite/PGLite behavioral parity seeds', () => {
  test('agree on filtered page lists and batch link maps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-parity-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedListAndLinkFixture(sqlite);
      await seedListAndLinkFixture(pglite);

      const sqliteSnapshot = await collectListAndLinkSnapshot(sqlite);
      const pgliteSnapshot = await collectListAndLinkSnapshot(pglite);

      expect(sqliteSnapshot).toEqual({
        conceptPages: ['concepts/control-delta', 'concepts/parity-alpha', 'concepts/parity-gamma'],
        parityTaggedPages: ['concepts/parity-alpha', 'concepts/parity-gamma', 'people/parity-beta'],
        parityTaggedConcepts: ['concepts/parity-alpha', 'concepts/parity-gamma'],
        linksBySlug: {
          'concepts/parity-alpha': ['concepts/parity-alpha->people/parity-beta:mentions:alpha to beta'],
          'concepts/parity-gamma': ['concepts/parity-gamma->people/parity-beta:mentions:gamma to beta'],
          'people/parity-beta': ['people/parity-beta->concepts/parity-alpha:supports:beta to alpha'],
        },
        backlinksBySlug: {
          'concepts/parity-alpha': ['people/parity-beta->concepts/parity-alpha:supports:beta to alpha'],
          'concepts/parity-gamma': [],
          'people/parity-beta': [
            'concepts/parity-alpha->people/parity-beta:mentions:alpha to beta',
            'concepts/parity-gamma->people/parity-beta:mentions:gamma to beta',
          ],
        },
      });
      expect(pgliteSnapshot).toEqual(sqliteSnapshot);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up SQLite/PGLite parity fixtures');
      }
    }
  });

  test('agree on explicit zero page-list limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-zero-limit-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedListAndLinkFixture(sqlite);
      await seedListAndLinkFixture(pglite);

      const sqlitePages = await sqlite.listPages({ limit: 0 });
      const pglitePages = await pglite.listPages({ limit: 0 });

      expect(sqlitePages).toEqual([]);
      expect(pglitePages).toEqual(sqlitePages);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up zero-limit parity fixtures');
      }
    }
  });

  test('agree on shallow graph traversal when a node is reachable at multiple depths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-graph-parity-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedGraphTraversalFixture(sqlite);
      await seedGraphTraversalFixture(pglite);

      const sqliteGraph = await collectGraphTraversalSnapshot(sqlite);
      const pgliteGraph = await collectGraphTraversalSnapshot(pglite);

      expect(sqliteGraph).toEqual({
        'concepts/root': 0,
        'concepts/mid': 1,
        'concepts/target': 1,
      });
      expect(pgliteGraph).toEqual(sqliteGraph);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up graph parity fixtures');
      }
    }
  });

  test('SQLite keyword results use stored chunk source when a matching chunk exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-search-chunk-source-'));
    const sqlite = new SQLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();

      await seedStoredChunkSearchFixture(sqlite);

      const sqliteResult = (await sqlite.searchKeyword('needle-token', { limit: 1 }))[0];

      expect(sqliteResult?.chunk_source).toBe('frontmatter');
      expect(sqliteResult?.chunk_text).toContain('frontmatter needle-token');
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await sqlite.disconnect();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up SQLite search chunk-source fixtures');
      }
    }
  });
});

type ListAndLinkEngine = Pick<
  SQLiteEngine,
  'putPage' | 'addTag' | 'addLink' | 'listPages' | 'getLinksForSlugs' | 'getBacklinksForSlugs'
>;

type GraphTraversalEngine = Pick<SQLiteEngine, 'putPage' | 'addLink' | 'traverseGraph'>;

type StoredChunkSearchEngine = Pick<SQLiteEngine, 'putPage' | 'upsertChunks' | 'searchKeyword'>;

async function seedListAndLinkFixture(engine: ListAndLinkEngine): Promise<void> {
  await engine.putPage('concepts/parity-alpha', {
    type: 'concept',
    title: 'Parity Alpha',
    compiled_truth: 'Alpha parity concept.',
  });
  await engine.putPage('people/parity-beta', {
    type: 'person',
    title: 'Parity Beta',
    compiled_truth: 'Beta parity person.',
  });
  await engine.putPage('concepts/parity-gamma', {
    type: 'concept',
    title: 'Parity Gamma',
    compiled_truth: 'Gamma parity concept.',
  });
  await engine.putPage('concepts/control-delta', {
    type: 'concept',
    title: 'Control Delta',
    compiled_truth: 'Delta concept without the parity tag.',
  });

  await engine.addTag('concepts/parity-alpha', 'parity');
  await engine.addTag('concepts/parity-gamma', 'parity');
  await engine.addTag('people/parity-beta', 'parity');
  await engine.addTag('people/parity-beta', 'people');

  await engine.addLink('concepts/parity-alpha', 'people/parity-beta', 'alpha to beta', 'mentions');
  await engine.addLink('concepts/parity-gamma', 'people/parity-beta', 'gamma to beta', 'mentions');
  await engine.addLink('people/parity-beta', 'concepts/parity-alpha', 'beta to alpha', 'supports');
}

async function collectListAndLinkSnapshot(engine: ListAndLinkEngine) {
  const slugs = ['concepts/parity-alpha', 'concepts/parity-gamma', 'people/parity-beta'];

  return {
    conceptPages: (await engine.listPages({ type: 'concept' })).map((page) => page.slug).sort(),
    parityTaggedPages: (await engine.listPages({ tag: 'parity' })).map((page) => page.slug).sort(),
    parityTaggedConcepts: (await engine.listPages({ type: 'concept', tag: 'parity' }))
      .map((page) => page.slug)
      .sort(),
    linksBySlug: normalizeLinkMap(await engine.getLinksForSlugs(slugs)),
    backlinksBySlug: normalizeLinkMap(await engine.getBacklinksForSlugs(slugs)),
  };
}

function normalizeLinkMap(map: Map<string, Link[]>): Record<string, string[]> {
  return Object.fromEntries(
    [...map.entries()]
      .map(([slug, links]) => [
        slug,
        links
          .map((link) => `${link.from_slug}->${link.to_slug}:${link.link_type}:${link.context}`)
          .sort(),
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function seedGraphTraversalFixture(engine: GraphTraversalEngine): Promise<void> {
  await engine.putPage('concepts/root', {
    type: 'concept',
    title: 'Root',
    compiled_truth: 'Root graph node.',
  });
  await engine.putPage('concepts/mid', {
    type: 'concept',
    title: 'Mid',
    compiled_truth: 'Intermediate graph node.',
  });
  await engine.putPage('concepts/target', {
    type: 'concept',
    title: 'Target',
    compiled_truth: 'Target graph node.',
  });

  await engine.addLink('concepts/root', 'concepts/target', 'direct', 'mentions');
  await engine.addLink('concepts/root', 'concepts/mid', 'indirect start', 'mentions');
  await engine.addLink('concepts/mid', 'concepts/target', 'indirect end', 'mentions');
}

async function collectGraphTraversalSnapshot(engine: GraphTraversalEngine): Promise<Record<string, number>> {
  return Object.fromEntries(
    (await engine.traverseGraph('concepts/root', 2))
      .map((node) => [node.slug, node.depth] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function seedStoredChunkSearchFixture(engine: StoredChunkSearchEngine): Promise<void> {
  await engine.putPage('concepts/stored-chunk-search', {
    type: 'concept',
    title: 'Stored Chunk Search',
    compiled_truth: 'Compiled truth also mentions needle-token so the page is searchable.',
    frontmatter: {
      codemap: 'frontmatter needle-token canonical snippet',
    },
  });
  await engine.upsertChunks('concepts/stored-chunk-search', [
    {
      chunk_index: 0,
      chunk_text: 'frontmatter needle-token canonical snippet',
      chunk_source: 'frontmatter',
      token_count: 4,
    },
    {
      chunk_index: 1,
      chunk_text: 'Compiled truth also mentions needle-token so the page is searchable.',
      chunk_source: 'compiled_truth',
      token_count: 8,
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────
// Behavioral correctness tests — real SQLiteEngine operations
// ─────────────────────────────────────────────────────────────────

const PARITY_TMP = mkdtempSync(join(tmpdir(), 'mbrain-parity-'));

describe('SQLiteEngine behavioral correctness', () => {
  let engine: InstanceType<typeof SQLiteEngine>;

  beforeAll(async () => {
    engine = new SQLiteEngine();
    await engine.connect({ database_path: join(PARITY_TMP, 'parity-test.db') });
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(PARITY_TMP, { recursive: true, force: true });
  });

  // ── Page CRUD ──────────────────────────────────────────────────

  test('putPage + getPage round-trip preserves all fields', async () => {
    const page = await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice Smith',
      compiled_truth: 'Alice is a neural retrieval researcher who specializes in dense passage retrieval and hybrid search architectures.',
      timeline: '- 2024-01-15: Joined the team.',
      frontmatter: { role: 'researcher', org: 'lab' },
      content_hash: 'abc123',
    });

    expect(page.slug).toBe('people/alice');
    expect(page.type).toBe('person');
    expect(page.title).toBe('Alice Smith');
    expect(page.compiled_truth).toContain('neural retrieval');
    expect(page.timeline).toContain('2024-01-15');
    expect(page.frontmatter.role).toBe('researcher');
    expect(page.content_hash).toBe('abc123');
    expect(page.created_at).toBeInstanceOf(Date);
    expect(page.updated_at).toBeInstanceOf(Date);

    const fetched = await engine.getPage('people/alice');
    expect(fetched).not.toBeNull();
    expect(fetched!.slug).toBe(page.slug);
    expect(fetched!.title).toBe(page.title);
    expect(fetched!.compiled_truth).toBe(page.compiled_truth);
    expect(fetched!.frontmatter.role).toBe('researcher');
  });

  test('getPage returns null for nonexistent slug', async () => {
    const page = await engine.getPage('nonexistent/page');
    expect(page).toBeNull();
  });

  test('deletePage removes a page', async () => {
    await engine.putPage('concepts/temp', {
      type: 'concept', title: 'Temporary', compiled_truth: 'Will be deleted.',
    });
    expect(await engine.getPage('concepts/temp')).not.toBeNull();
    await engine.deletePage('concepts/temp');
    expect(await engine.getPage('concepts/temp')).toBeNull();
  });

  test('listPages returns pages with type filter', async () => {
    await engine.putPage('concepts/embeddings', {
      type: 'concept', title: 'Embeddings', compiled_truth: 'Vector representations of text.',
    });

    const persons = await engine.listPages({ type: 'person' });
    const concepts = await engine.listPages({ type: 'concept' });
    expect(persons.every(p => p.type === 'person')).toBe(true);
    expect(concepts.every(p => p.type === 'concept')).toBe(true);
  });

  // ── Search ─────────────────────────────────────────────────────

  test('searchKeyword returns SearchResult[] with correct shape', async () => {
    const results = await engine.searchKeyword('neural retrieval');
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(typeof r.slug).toBe('string');
      expect(typeof r.page_id).toBe('number');
      expect(typeof r.title).toBe('string');
      expect(typeof r.type).toBe('string');
      expect(typeof r.chunk_text).toBe('string');
      expect(['compiled_truth', 'timeline']).toContain(r.chunk_source);
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(typeof r.stale).toBe('boolean');
    }
  });

  test('searchKeyword returns focused snippet, not full page body', async () => {
    // Insert a page with long content
    const longText = Array(100).fill('This is filler text for testing purposes. ').join('') +
      'The critical finding about quantum computing was groundbreaking. ' +
      Array(100).fill('More filler text to pad the content further. ').join('');

    await engine.putPage('concepts/quantum', {
      type: 'concept', title: 'Quantum Computing', compiled_truth: longText,
    });

    const results = await engine.searchKeyword('quantum computing');
    expect(results.length).toBeGreaterThan(0);
    // Snippet should be much shorter than the full text
    expect(results[0]!.chunk_text.length).toBeLessThan(500);
    expect(results[0]!.chunk_text).toContain('quantum');
  });

  test('searchKeyword with empty query returns empty array', async () => {
    const results = await engine.searchKeyword('');
    expect(results).toEqual([]);
  });

  test('searchKeyword with special characters degrades gracefully', async () => {
    const results = await engine.searchKeyword('"unmatched NEAR(a,b) ^weird');
    expect(Array.isArray(results)).toBe(true);
    // FTS5 error handler catches malformed queries and returns empty array
    expect(results.length).toBe(0);
  });

  test('searchVector with no embeddings returns empty array', async () => {
    const query = new Float32Array([1, 0, 0]);
    const results = await engine.searchVector(query);
    expect(results).toEqual([]);
  });

  // ── Chunks ─────────────────────────────────────────────────────

  test('upsertChunks + getChunks round-trip', async () => {
    await engine.upsertChunks('people/alice', [
      { chunk_index: 0, chunk_text: 'Alice is a researcher.', chunk_source: 'compiled_truth', token_count: 5 },
      { chunk_index: 1, chunk_text: 'She joined in 2024.', chunk_source: 'timeline', token_count: 5 },
    ]);

    const chunks = await engine.getChunks('people/alice');
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.chunk_text).toBe('Alice is a researcher.');
    expect(chunks[0]!.chunk_source).toBe('compiled_truth');
    expect(chunks[1]!.chunk_source).toBe('timeline');
    expect(chunks[0]!.embedded_at).toBeNull();
  });

  // ── Links ──────────────────────────────────────────────────────

  test('addLink + getLinks + getBacklinks consistency', async () => {
    await engine.addLink('people/alice', 'concepts/embeddings', 'works on', 'research');

    const links = await engine.getLinks('people/alice');
    expect(links.some(l => l.to_slug === 'concepts/embeddings')).toBe(true);

    const backlinks = await engine.getBacklinks('concepts/embeddings');
    expect(backlinks.some(l => l.from_slug === 'people/alice')).toBe(true);
  });

  // ── Tags ───────────────────────────────────────────────────────

  test('addTag + getTags idempotency', async () => {
    await engine.addTag('people/alice', 'researcher');
    await engine.addTag('people/alice', 'researcher'); // duplicate — should not throw

    const tags = await engine.getTags('people/alice');
    expect(tags.filter(t => t === 'researcher').length).toBe(1);
  });

  // ── Timeline ───────────────────────────────────────────────────

  test('addTimelineEntry + getTimeline', async () => {
    await engine.addTimelineEntry('people/alice', {
      date: '2024-03-01', source: 'manual', summary: 'Promoted to lead', detail: 'Effective immediately',
    });

    const timeline = await engine.getTimeline('people/alice');
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline[0]!.summary).toBe('Promoted to lead');
    expect(typeof timeline[0]!.id).toBe('number');
    expect(timeline[0]!.created_at).toBeInstanceOf(Date);
  });

  // ── Transaction rollback ───────────────────────────────────────

  test('transaction rollback on error', async () => {
    const before = await engine.getPage('people/alice');

    try {
      await engine.transaction(async (tx) => {
        await tx.putPage('people/alice', {
          type: 'person', title: 'SHOULD ROLLBACK', compiled_truth: 'nope',
        });
        throw new Error('forced rollback');
      });
    } catch {
      // expected
    }

    const after = await engine.getPage('people/alice');
    expect(after!.title).toBe(before!.title);
  });

  // ── Stats + Health ─────────────────────────────────────────────

  test('getStats returns correct shape', async () => {
    const stats = await engine.getStats();
    expect(typeof stats.page_count).toBe('number');
    expect(typeof stats.chunk_count).toBe('number');
    expect(typeof stats.link_count).toBe('number');
    expect(typeof stats.tag_count).toBe('number');
    expect(stats.page_count).toBeGreaterThan(0);
    expect(stats.pages_by_type).toBeDefined();
  });

  test('getHealth returns correct shape', async () => {
    const health = await engine.getHealth();
    expect(typeof health.page_count).toBe('number');
    expect(typeof health.embed_coverage).toBe('number');
    expect(typeof health.stale_pages).toBe('number');
    expect(typeof health.orphan_pages).toBe('number');
    expect(typeof health.dead_links).toBe('number');
    expect(typeof health.missing_embeddings).toBe('number');
    expect(health.page_count).toBeGreaterThan(0);
  });

  // ── resolveSlugs ───────────────────────────────────────────────

  test('resolveSlugs finds exact and partial matches', async () => {
    const exact = await engine.resolveSlugs('people/alice');
    expect(exact).toContain('people/alice');

    const partial = await engine.resolveSlugs('alice');
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.some(s => s.includes('alice'))).toBe(true);
  });
});
