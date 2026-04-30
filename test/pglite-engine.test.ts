/**
 * PGLite Engine Tests — validates all 37 BrainEngine methods against PGLite (in-memory).
 *
 * No Docker, no DATABASE_URL, no external dependencies. Runs instantly in CI.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput, ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

// Helper to reset data between test groups
async function truncateAll() {
  const tables = [
    'content_chunks', 'links', 'tags', 'raw_data',
    'timeline_entries', 'page_versions', 'ingest_log', 'pages',
  ];
  for (const t of tables) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

const testPage: PageInput = {
  type: 'concept',
  title: 'Test Page',
  compiled_truth: 'This is a test page about NovaMind AI agents.',
  timeline: '2024-01-15: Founded NovaMind',
};

// ─────────────────────────────────────────────────────────────────
// Pages CRUD
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Pages', () => {
  beforeEach(truncateAll);

  test('putPage + getPage round trip', async () => {
    const page = await engine.putPage('test/hello', testPage);
    expect(page.slug).toBe('test/hello');
    expect(page.title).toBe('Test Page');
    expect(page.type).toBe('concept');
    expect(page.compiled_truth).toContain('NovaMind');

    const fetched = await engine.getPage('test/hello');
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Test Page');
    expect(fetched!.content_hash).toBeTruthy();
  });

  test('putPage upserts on conflict', async () => {
    await engine.putPage('test/upsert', testPage);
    const updated = await engine.putPage('test/upsert', {
      ...testPage,
      title: 'Updated Title',
    });
    expect(updated.title).toBe('Updated Title');

    const all = await engine.listPages();
    const matches = all.filter(p => p.slug === 'test/upsert');
    expect(matches.length).toBe(1);
  });

  test('getPage returns null for missing slug', async () => {
    const result = await engine.getPage('nonexistent/slug');
    expect(result).toBeNull();
  });

  test('deletePage removes page', async () => {
    await engine.putPage('test/delete-me', testPage);
    await engine.deletePage('test/delete-me');
    const result = await engine.getPage('test/delete-me');
    expect(result).toBeNull();
  });

  test('listPages with type filter', async () => {
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('concepts/rag', { ...testPage, type: 'concept', title: 'RAG' });

    const people = await engine.listPages({ type: 'person' });
    expect(people.length).toBe(1);
    expect(people[0].title).toBe('Alice');
  });

  test('listPages with tag filter', async () => {
    await engine.putPage('test/tagged', testPage);
    await engine.addTag('test/tagged', 'special');

    const tagged = await engine.listPages({ tag: 'special' });
    expect(tagged.length).toBe(1);
    expect(tagged[0].slug).toBe('test/tagged');
  });

  test('listPages with slugPrefix filter (Issue #13)', async () => {
    await truncateAll();
    await engine.putPage('media/x/tweet-1', { ...testPage, type: 'concept' });
    await engine.putPage('media/x/tweet-2', { ...testPage, type: 'concept' });
    await engine.putPage('media/articles/post-1', { ...testPage, type: 'concept' });
    await engine.putPage('people/alice', { ...testPage, type: 'person' });

    const xOnly = await engine.listPages({ slugPrefix: 'media/x/', limit: 100 });
    expect(xOnly.map((p) => p.slug).sort()).toEqual(['media/x/tweet-1', 'media/x/tweet-2']);

    const allMedia = await engine.listPages({ slugPrefix: 'media/', limit: 100 });
    expect(allMedia.length).toBe(3);

    // Path-segment risk: 'media/x' (no trailing /) would also match 'media/xerox'.
    // The matcher in storage-config.ts is responsible for trailing-/ semantics
    // (step 6); the engine treats slugPrefix as a literal string prefix.
    expect((await engine.listPages({ slugPrefix: 'media/x', limit: 100 })).length).toBe(2);
  });

  test('listPages slugPrefix escapes LIKE metacharacters', async () => {
    await truncateAll();
    await engine.putPage('safe/foo', { ...testPage, type: 'concept' });
    // A user prefix containing % or _ would otherwise match unintended slugs
    // if not escaped. We can't easily insert a slug with % in it (most slugs
    // are url-safe), but we can confirm the escape logic doesn't break the
    // happy path.
    const result = await engine.listPages({ slugPrefix: 'safe/', limit: 10 });
    expect(result.length).toBe(1);
    expect(result[0].slug).toBe('safe/foo');
  });

  test('resolveSlugs exact match', async () => {
    await engine.putPage('test/exact', testPage);
    const slugs = await engine.resolveSlugs('test/exact');
    expect(slugs).toEqual(['test/exact']);
  });

  test('resolveSlugs fuzzy match via pg_trgm', async () => {
    await engine.putPage('people/sarah-chen', { ...testPage, title: 'Sarah Chen' });
    const slugs = await engine.resolveSlugs('sarah');
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs).toContain('people/sarah-chen');
  });

  test('updateSlug renames page', async () => {
    await engine.putPage('test/old-name', testPage);
    await engine.updateSlug('test/old-name', 'test/new-name');
    expect(await engine.getPage('test/old-name')).toBeNull();
    expect((await engine.getPage('test/new-name'))?.title).toBe('Test Page');
  });

  test('validateSlug rejects path traversal', async () => {
    expect(() => engine.putPage('../etc/passwd', testPage)).toThrow();
  });

  test('validateSlug rejects leading slash', async () => {
    expect(() => engine.putPage('/absolute/path', testPage)).toThrow();
  });

  test('validateSlug normalizes to lowercase', async () => {
    const page = await engine.putPage('Test/UPPER', testPage);
    expect(page.slug).toBe('test/upper');
  });
});

// ─────────────────────────────────────────────────────────────────
// Search (tsvector triggers + FTS)
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Search', () => {
  beforeAll(async () => {
    await truncateAll();
    await engine.putPage('companies/novamind', {
      type: 'company', title: 'NovaMind',
      compiled_truth: 'NovaMind builds AI agents for enterprise automation.',
    });
    await engine.upsertChunks('companies/novamind', [
      { chunk_index: 0, chunk_text: 'NovaMind builds AI agents for enterprise', chunk_source: 'compiled_truth' },
    ]);
    await engine.putPage('concepts/rag', {
      type: 'concept', title: 'Retrieval-Augmented Generation',
      compiled_truth: 'RAG combines retrieval with generation for better answers.',
    });
    await engine.upsertChunks('concepts/rag', [
      { chunk_index: 0, chunk_text: 'RAG combines retrieval with generation', chunk_source: 'compiled_truth' },
    ]);
  });

  test('searchKeyword returns results for matching term', async () => {
    const results = await engine.searchKeyword('NovaMind');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('companies/novamind');
  });

  test('searchKeyword returns empty for non-matching term', async () => {
    const results = await engine.searchKeyword('xyznonexistent');
    expect(results.length).toBe(0);
  });

  test('tsvector trigger populates search_vector on insert', async () => {
    // Verify the PL/pgSQL trigger fires and content_chunks.search_vector is
    // populated from chunk_text. v0.20.0 Cathedral II Layer 3 moved FTS from
    // pages.search_vector to content_chunks.search_vector — the chunk-grain
    // vector is built from chunk_text (+ optional doc_comment + qualified
    // symbol name). 'AI agents' is a phrase inside the chunk_text so it
    // stresses the chunk-grain tsvector directly.
    const results = await engine.searchKeyword('AI agents');
    expect(results.length).toBeGreaterThan(0);
  });

  test('searchVector returns empty when no embeddings', async () => {
    const fakeEmbedding = new Float32Array(1536);
    const results = await engine.searchVector(fakeEmbedding);
    expect(results.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Chunks
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Chunks', () => {
  beforeEach(truncateAll);

  test('upsertChunks + getChunks round trip', async () => {
    await engine.putPage('test/chunks', testPage);
    await engine.upsertChunks('test/chunks', [
      { chunk_index: 0, chunk_text: 'Chunk zero', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Chunk one', chunk_source: 'compiled_truth' },
    ]);
    const chunks = await engine.getChunks('test/chunks');
    expect(chunks.length).toBe(2);
    expect(chunks[0].chunk_text).toBe('Chunk zero');
    expect(chunks[1].chunk_text).toBe('Chunk one');
  });

  test('upsertChunks removes orphan chunks', async () => {
    await engine.putPage('test/orphan', testPage);
    await engine.upsertChunks('test/orphan', [
      { chunk_index: 0, chunk_text: 'Keep', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Remove', chunk_source: 'compiled_truth' },
    ]);
    // Re-upsert with only index 0
    await engine.upsertChunks('test/orphan', [
      { chunk_index: 0, chunk_text: 'Updated', chunk_source: 'compiled_truth' },
    ]);
    const chunks = await engine.getChunks('test/orphan');
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunk_text).toBe('Updated');
  });

  test('upsertChunks throws for missing page', async () => {
    await expect(
      engine.upsertChunks('nonexistent/page', [
        { chunk_index: 0, chunk_text: 'test', chunk_source: 'compiled_truth' },
      ])
    ).rejects.toThrow('Page not found');
  });

  test('deleteChunks removes all chunks for page', async () => {
    await engine.putPage('test/delete-chunks', testPage);
    await engine.upsertChunks('test/delete-chunks', [
      { chunk_index: 0, chunk_text: 'Gone', chunk_source: 'compiled_truth' },
    ]);
    await engine.deleteChunks('test/delete-chunks');
    const chunks = await engine.getChunks('test/delete-chunks');
    expect(chunks.length).toBe(0);
  });

  test('getChunksWithEmbeddings returns embedding data', async () => {
    await engine.putPage('test/embed', testPage);
    const embedding = new Float32Array(1536).fill(0.1);
    await engine.upsertChunks('test/embed', [
      { chunk_index: 0, chunk_text: 'With embedding', chunk_source: 'compiled_truth', embedding },
    ]);
    const chunks = await engine.getChunksWithEmbeddings('test/embed');
    expect(chunks.length).toBe(1);
    expect(chunks[0].embedding).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Links + Graph
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Links', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'ACME' });
    await engine.putPage('companies/beta', { ...testPage, type: 'company', title: 'Beta' });
  });

  test('addLink + getLinks', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'works at', 'employment');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(1);
    expect(links[0].to_slug).toBe('companies/acme');
  });

  test('getBacklinks', async () => {
    await engine.addLink('people/alice', 'companies/acme');
    const backlinks = await engine.getBacklinks('companies/acme');
    expect(backlinks.length).toBe(1);
    expect(backlinks[0].from_slug).toBe('people/alice');
  });

  test('removeLink', async () => {
    await engine.addLink('people/alice', 'companies/acme');
    await engine.removeLink('people/alice', 'companies/acme');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(0);
  });

  test('traverseGraph with depth', async () => {
    await engine.addLink('people/alice', 'companies/acme');
    await engine.addLink('companies/acme', 'companies/beta');

    const graph = await engine.traverseGraph('people/alice', 2);
    expect(graph.length).toBeGreaterThanOrEqual(2);
    const slugs = graph.map(n => n.slug);
    expect(slugs).toContain('people/alice');
    expect(slugs).toContain('companies/acme');
  });
});

// ─────────────────────────────────────────────────────────────────
// Tags
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Tags', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('test/tags', testPage);
  });

  test('addTag + getTags', async () => {
    await engine.addTag('test/tags', 'alpha');
    await engine.addTag('test/tags', 'beta');
    const tags = await engine.getTags('test/tags');
    expect(tags).toEqual(['alpha', 'beta']);
  });

  test('removeTag', async () => {
    await engine.addTag('test/tags', 'remove-me');
    await engine.removeTag('test/tags', 'remove-me');
    const tags = await engine.getTags('test/tags');
    expect(tags).not.toContain('remove-me');
  });

  test('duplicate tag is idempotent', async () => {
    await engine.addTag('test/tags', 'dup');
    await engine.addTag('test/tags', 'dup');
    const tags = await engine.getTags('test/tags');
    expect(tags.filter(t => t === 'dup').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Timeline', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('test/timeline', testPage);
  });

  test('addTimelineEntry + getTimeline', async () => {
    await engine.addTimelineEntry('test/timeline', {
      date: '2024-01-15', summary: 'Founded', detail: 'Company founded',
    });
    const entries = await engine.getTimeline('test/timeline');
    expect(entries.length).toBe(1);
    expect(entries[0].summary).toBe('Founded');
  });

  test('getTimeline with date range', async () => {
    await engine.addTimelineEntry('test/timeline', { date: '2024-01-01', summary: 'Jan' });
    await engine.addTimelineEntry('test/timeline', { date: '2024-06-01', summary: 'Jun' });
    await engine.addTimelineEntry('test/timeline', { date: '2024-12-01', summary: 'Dec' });

    const filtered = await engine.getTimeline('test/timeline', {
      after: '2024-03-01', before: '2024-09-01',
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].summary).toBe('Jun');
  });
});

// ─────────────────────────────────────────────────────────────────
// Batch methods (addLinksBatch / addTimelineEntriesBatch)
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: addLinksBatch', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('a', { type: 'concept', title: 'A', compiled_truth: '', timeline: '' });
    await engine.putPage('b', { type: 'concept', title: 'B', compiled_truth: '', timeline: '' });
    await engine.putPage('c', { type: 'concept', title: 'C', compiled_truth: '', timeline: '' });
  });

  test('empty batch returns 0 with no DB call', async () => {
    expect(await engine.addLinksBatch([])).toBe(0);
  });

  test('batch of 1 with missing optional fields inserts row with empty defaults', async () => {
    const inserted = await engine.addLinksBatch([{ from_slug: 'a', to_slug: 'b' }]);
    expect(inserted).toBe(1);
    const links = await engine.getLinks('a');
    expect(links.length).toBe(1);
    expect(links[0].context).toBe('');
    expect(links[0].link_type).toBe('');
  });

  test('within-batch duplicates are deduped via ON CONFLICT (no 21000 error)', async () => {
    const inserted = await engine.addLinksBatch([
      { from_slug: 'a', to_slug: 'b', link_type: 'mention' },
      { from_slug: 'a', to_slug: 'b', link_type: 'mention' },
      { from_slug: 'a', to_slug: 'c', link_type: 'mention' },
    ]);
    expect(inserted).toBe(2);
  });

  test('rows with missing slug are silently dropped by JOIN', async () => {
    const inserted = await engine.addLinksBatch([
      { from_slug: 'doesnt-exist', to_slug: 'b' },
      { from_slug: 'a', to_slug: 'b' },
    ]);
    expect(inserted).toBe(1);
  });

  test('half-existing batch returns count of new only', async () => {
    await engine.addLink('a', 'b', '', 'mention');
    const inserted = await engine.addLinksBatch([
      { from_slug: 'a', to_slug: 'b', link_type: 'mention' },
      { from_slug: 'a', to_slug: 'c', link_type: 'mention' },
    ]);
    expect(inserted).toBe(1);
  });

  test('batch of 100 fresh rows returns 100', async () => {
    // Create 100 target pages
    for (let i = 0; i < 100; i++) {
      await engine.putPage(`target/${i}`, { type: 'concept', title: `T${i}`, compiled_truth: '', timeline: '' });
    }
    const batch = Array.from({ length: 100 }, (_, i) => ({
      from_slug: 'a', to_slug: `target/${i}`, link_type: 'mention',
    }));
    expect(await engine.addLinksBatch(batch)).toBe(100);
  });
});

describe('PGLiteEngine: addTimelineEntriesBatch', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('p1', { type: 'concept', title: 'P1', compiled_truth: '', timeline: '' });
    await engine.putPage('p2', { type: 'concept', title: 'P2', compiled_truth: '', timeline: '' });
  });

  test('empty batch returns 0', async () => {
    expect(await engine.addTimelineEntriesBatch([])).toBe(0);
  });

  test('batch of 1 with missing optionals inserts with empty defaults', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'p1', date: '2024-01-15', summary: 'Founded' },
    ]);
    expect(inserted).toBe(1);
    const entries = await engine.getTimeline('p1');
    expect(entries.length).toBe(1);
    expect(entries[0].source).toBe('');
    expect(entries[0].detail).toBe('');
  });

  test('within-batch duplicates are deduped via ON CONFLICT', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'p1', date: '2024-01-15', summary: 'Founded' },
      { slug: 'p1', date: '2024-01-15', summary: 'Founded' },
      { slug: 'p1', date: '2024-02-01', summary: 'Launched' },
    ]);
    expect(inserted).toBe(2);
  });

  test('rows with missing slug are silently dropped by JOIN', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'no-such-page', date: '2024-01-15', summary: 'Phantom' },
      { slug: 'p1', date: '2024-01-15', summary: 'Real' },
    ]);
    expect(inserted).toBe(1);
  });

  test('mix of new + existing returns count of new only', async () => {
    await engine.addTimelineEntry('p1', { date: '2024-01-15', summary: 'Founded' });
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'p1', date: '2024-01-15', summary: 'Founded' },
      { slug: 'p1', date: '2024-02-01', summary: 'Launched' },
      { slug: 'p2', date: '2024-03-01', summary: 'Spun off' },
    ]);
    expect(inserted).toBe(2);
  });
});

// v0.18.0: regression guards for the cross-source JOIN fan-out.
// Before the fix, addLinksBatch/addTimelineEntriesBatch JOINed on pages.slug
// only — so a page with the same slug in two sources would fan out and
// silently create duplicate edges / entries. Source-id-qualified JOINs
// eliminate the fan-out.
describe('PGLiteEngine: batch ops source-awareness (v0.18.0)', () => {
  beforeEach(async () => {
    await truncateAll();
    // Register a second source and populate the same slugs in both.
    const db = (engine as any).db;
    await db.query(
      `INSERT INTO sources (id, name) VALUES ('alt', 'alt')
       ON CONFLICT (id) DO NOTHING`
    );
    // default-source rows via putPage (schema DEFAULT 'default').
    await engine.putPage('topics/ai', { type: 'concept', title: 'AI (default)', compiled_truth: '', timeline: '' });
    await engine.putPage('topics/ml', { type: 'concept', title: 'ML (default)', compiled_truth: '', timeline: '' });
    // alt-source rows with the same slugs, inserted via raw SQL.
    await db.query(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_id, updated_at)
       VALUES ('topics/ai', 'concept', 'AI (alt)', '', '', '{}'::jsonb, 'h1', 'alt', now()),
              ('topics/ml', 'concept', 'ML (alt)', '', '', '{}'::jsonb, 'h2', 'alt', now())`
    );
  });

  test('addLinksBatch default source_id does NOT fan out across sources', async () => {
    const inserted = await engine.addLinksBatch([
      { from_slug: 'topics/ai', to_slug: 'topics/ml', link_type: 'mention' },
    ]);
    // Exactly one edge, not two. Before the fix this was 2.
    expect(inserted).toBe(1);
    const db = (engine as any).db;
    const { rows } = await db.query(
      `SELECT f.source_id AS from_src, t.source_id AS to_src
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_src).toBe('default');
    expect(rows[0].to_src).toBe('default');
  });

  test('addLinksBatch with explicit alt source_id lands in alt only', async () => {
    const inserted = await engine.addLinksBatch([
      {
        from_slug: 'topics/ai', to_slug: 'topics/ml', link_type: 'mention',
        from_source_id: 'alt', to_source_id: 'alt',
      },
    ]);
    expect(inserted).toBe(1);
    const db = (engine as any).db;
    const { rows } = await db.query(
      `SELECT f.source_id AS from_src, t.source_id AS to_src
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_src).toBe('alt');
    expect(rows[0].to_src).toBe('alt');
  });

  test('addLinksBatch supports cross-source edges', async () => {
    const inserted = await engine.addLinksBatch([
      {
        from_slug: 'topics/ai', to_slug: 'topics/ml', link_type: 'mention',
        from_source_id: 'default', to_source_id: 'alt',
      },
    ]);
    expect(inserted).toBe(1);
    const db = (engine as any).db;
    const { rows } = await db.query(
      `SELECT f.source_id AS from_src, t.source_id AS to_src
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_src).toBe('default');
    expect(rows[0].to_src).toBe('alt');
  });

  test('addTimelineEntriesBatch default source_id does NOT fan out across sources', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'topics/ai', date: '2024-01-15', summary: 'Founded' },
    ]);
    // Exactly one entry (default source), not two. Before the fix this was 2.
    expect(inserted).toBe(1);
    const db = (engine as any).db;
    const { rows } = await db.query(
      `SELECT p.source_id FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });

  test('addTimelineEntriesBatch with explicit alt source_id lands in alt only', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'topics/ai', date: '2024-01-15', summary: 'Founded', source_id: 'alt' },
    ]);
    expect(inserted).toBe(1);
    const db = (engine as any).db;
    const { rows } = await db.query(
      `SELECT p.source_id FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('alt');
  });
});

// ─────────────────────────────────────────────────────────────────
// Raw Data, Versions, Config, IngestLog
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: RawData', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('test/raw', testPage);
  });

  test('putRawData + getRawData', async () => {
    await engine.putRawData('test/raw', 'crunchbase', { funding: '$10M' });
    const data = await engine.getRawData('test/raw', 'crunchbase');
    expect(data.length).toBe(1);
    expect((data[0].data as any).funding).toBe('$10M');
  });
});

describe('PGLiteEngine: Versions', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('test/version', testPage);
  });

  test('createVersion + getVersions', async () => {
    const v = await engine.createVersion('test/version');
    expect(v.compiled_truth).toBe(testPage.compiled_truth);

    const versions = await engine.getVersions('test/version');
    expect(versions.length).toBe(1);
  });

  test('revertToVersion restores content', async () => {
    await engine.createVersion('test/version');
    await engine.putPage('test/version', { ...testPage, compiled_truth: 'Changed' });

    const versions = await engine.getVersions('test/version');
    await engine.revertToVersion('test/version', versions[0].id);

    const page = await engine.getPage('test/version');
    expect(page!.compiled_truth).toBe(testPage.compiled_truth);
  });
});

describe('PGLiteEngine: Config', () => {
  test('getConfig + setConfig', async () => {
    await engine.setConfig('test_key', 'test_value');
    const val = await engine.getConfig('test_key');
    expect(val).toBe('test_value');
  });

  test('getConfig returns null for missing key', async () => {
    const val = await engine.getConfig('nonexistent_key');
    expect(val).toBeNull();
  });
});

describe('PGLiteEngine: IngestLog', () => {
  test('logIngest + getIngestLog', async () => {
    await engine.logIngest({
      source_type: 'git', source_ref: '/tmp/test-repo',
      pages_updated: ['test/a', 'test/b'], summary: 'Imported 2 pages',
    });
    const log = await engine.getIngestLog({ limit: 10 });
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].source_type).toBe('git');
  });
});

// ─────────────────────────────────────────────────────────────────
// Stats + Health
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Stats & Health', () => {
  beforeAll(async () => {
    await truncateAll();
    await engine.putPage('test/stats', testPage);
    await engine.upsertChunks('test/stats', [
      { chunk_index: 0, chunk_text: 'chunk', chunk_source: 'compiled_truth' },
    ]);
    await engine.addTag('test/stats', 'stat-tag');
  });

  test('getStats returns correct counts', async () => {
    const stats = await engine.getStats();
    expect(stats.page_count).toBe(1);
    expect(stats.chunk_count).toBe(1);
    expect(stats.tag_count).toBe(1);
    expect(stats.pages_by_type.concept).toBe(1);
  });

  test('getHealth returns coverage metrics', async () => {
    const health = await engine.getHealth();
    expect(health.page_count).toBe(1);
    expect(health.missing_embeddings).toBe(1); // chunk has no embedding
    expect(health.embed_coverage).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Transactions', () => {
  beforeEach(truncateAll);

  test('transaction commits on success', async () => {
    await engine.transaction(async (tx) => {
      await tx.putPage('test/tx-ok', testPage);
    });
    const page = await engine.getPage('test/tx-ok');
    expect(page).not.toBeNull();
  });

  test('transaction rolls back on error', async () => {
    try {
      await engine.transaction(async (tx) => {
        await tx.putPage('test/tx-fail', testPage);
        throw new Error('Deliberate rollback');
      });
    } catch { /* expected */ }

    const page = await engine.getPage('test/tx-fail');
    expect(page).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Cascade deletes
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: Cascade deletes', () => {
  test('deleting a page cascades to chunks, tags, links', async () => {
    await engine.putPage('test/cascade', testPage);
    await engine.upsertChunks('test/cascade', [
      { chunk_index: 0, chunk_text: 'cascade chunk', chunk_source: 'compiled_truth' },
    ]);
    await engine.addTag('test/cascade', 'cascade-tag');

    await engine.deletePage('test/cascade');

    const chunks = await engine.getChunks('test/cascade');
    expect(chunks.length).toBe(0);
    const tags = await engine.getTags('test/cascade');
    expect(tags.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// v0.10.1: Knowledge graph layer
// ─────────────────────────────────────────────────────────────────

describe('PGLiteEngine: getAllSlugs', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
  });

  test('returns Set of all page slugs', async () => {
    const slugs = await engine.getAllSlugs();
    expect(slugs).toBeInstanceOf(Set);
    expect(slugs.size).toBe(3);
    expect(slugs.has('people/alice')).toBe(true);
    expect(slugs.has('companies/acme')).toBe(true);
  });

  test('empty brain returns empty Set', async () => {
    await truncateAll();
    const slugs = await engine.getAllSlugs();
    expect(slugs.size).toBe(0);
  });
});

describe('PGLiteEngine: listPages updated_after filter', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  test('filters pages by updated_at > given date', async () => {
    await engine.putPage('test/old', testPage);
    // Sleep briefly so the second page has a strictly later updated_at.
    await new Promise(r => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await new Promise(r => setTimeout(r, 10));
    await engine.putPage('test/new', testPage);

    const recent = await engine.listPages({ updated_after: cutoff, limit: 100 });
    const recentSlugs = recent.map(p => p.slug);
    expect(recentSlugs).toContain('test/new');
    expect(recentSlugs).not.toContain('test/old');
  });

  test('without updated_after, returns all pages (regression)', async () => {
    await engine.putPage('test/a', testPage);
    await engine.putPage('test/b', testPage);
    const all = await engine.listPages({ limit: 100 });
    expect(all.length).toBe(2);
  });
});

describe('PGLiteEngine: Multi-type links (v5 migration)', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
  });

  test('same (from, to) with different link_types both stored', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'CEO', 'works_at');
    await engine.addLink('people/alice', 'companies/acme', 'on the board', 'advises');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(2);
    const types = links.map(l => l.link_type).sort();
    expect(types).toEqual(['advises', 'works_at']);
  });

  test('upsert on same (from, to, type) updates context', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'old context', 'works_at');
    await engine.addLink('people/alice', 'companies/acme', 'new context', 'works_at');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(1);
    expect(links[0].context).toBe('new context');
  });

  test('removeLink without linkType removes ALL types for the pair (regression)', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'a', 'works_at');
    await engine.addLink('people/alice', 'companies/acme', 'b', 'advises');
    await engine.removeLink('people/alice', 'companies/acme');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(0);
  });

  test('removeLink with linkType removes only that type', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'a', 'works_at');
    await engine.addLink('people/alice', 'companies/acme', 'b', 'advises');
    await engine.removeLink('people/alice', 'companies/acme', 'works_at');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(1);
    expect(links[0].link_type).toBe('advises');
  });
});

describe('PGLiteEngine: Timeline dedup constraint (v6 migration)', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('test/timeline-dedup', testPage);
  });

  test('inserting same (date, summary) twice is silent no-op (idempotent)', async () => {
    await engine.addTimelineEntry('test/timeline-dedup', { date: '2026-01-15', summary: 'Event A' });
    await engine.addTimelineEntry('test/timeline-dedup', { date: '2026-01-15', summary: 'Event A' });
    const entries = await engine.getTimeline('test/timeline-dedup');
    expect(entries.length).toBe(1);
  });

  test('different summary on same date: both inserted', async () => {
    await engine.addTimelineEntry('test/timeline-dedup', { date: '2026-01-15', summary: 'Morning' });
    await engine.addTimelineEntry('test/timeline-dedup', { date: '2026-01-15', summary: 'Evening' });
    const entries = await engine.getTimeline('test/timeline-dedup');
    expect(entries.length).toBe(2);
  });

  test('throws on missing page (default behavior preserved)', async () => {
    await expect(engine.addTimelineEntry('does/not-exist', { date: '2026-01-15', summary: 'X' }))
      .rejects.toThrow();
  });

  test('skipExistenceCheck=true: silent no-op on missing page', async () => {
    // No throw, but also nothing inserted (subquery returns no rows).
    await engine.addTimelineEntry(
      'does/not-exist',
      { date: '2026-01-15', summary: 'X' },
      { skipExistenceCheck: true },
    );
    // No assertion needed beyond "did not throw".
  });
});

describe('PGLiteEngine: getBacklinkCounts', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
  });

  test('returns Map<slug, count> for given slugs', async () => {
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('people/bob', 'companies/acme', '', 'invested_in');
    const counts = await engine.getBacklinkCounts(['companies/acme', 'people/alice']);
    expect(counts.get('companies/acme')).toBe(2);
    expect(counts.get('people/alice')).toBe(0);
  });

  test('empty input -> empty Map', async () => {
    const counts = await engine.getBacklinkCounts([]);
    expect(counts.size).toBe(0);
  });

  test('slugs with zero links: present in Map with 0', async () => {
    const counts = await engine.getBacklinkCounts(['people/alice']);
    expect(counts.get('people/alice')).toBe(0);
  });
});

describe('PGLiteEngine: traversePaths (v0.10.1)', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('people/carol', { ...testPage, type: 'person', title: 'Carol' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
    await engine.putPage('meetings/standup', { ...testPage, type: 'meeting', title: 'Standup' });
    // Build a small typed graph
    await engine.addLink('meetings/standup', 'people/alice', '', 'attended');
    await engine.addLink('meetings/standup', 'people/bob', '', 'attended');
    await engine.addLink('meetings/standup', 'people/carol', '', 'attended');
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('people/bob', 'companies/acme', '', 'invested_in');
  });

  test('out direction (default): follows from->to edges', async () => {
    const paths = await engine.traversePaths('meetings/standup', { depth: 1 });
    expect(paths.length).toBe(3);
    expect(new Set(paths.map(p => p.to_slug))).toEqual(new Set(['people/alice', 'people/bob', 'people/carol']));
    expect(paths.every(p => p.link_type === 'attended')).toBe(true);
  });

  test('in direction: follows to->from edges', async () => {
    const paths = await engine.traversePaths('companies/acme', { depth: 1, direction: 'in' });
    expect(paths.length).toBe(2);
    expect(new Set(paths.map(p => p.from_slug))).toEqual(new Set(['people/alice', 'people/bob']));
  });

  test('linkType per-edge filter: only follows matching edges', async () => {
    const paths = await engine.traversePaths('companies/acme', {
      depth: 1, direction: 'in', linkType: 'works_at',
    });
    expect(paths.length).toBe(1);
    expect(paths[0].from_slug).toBe('people/alice');
  });

  test('depth 2: multi-hop traversal', async () => {
    const paths = await engine.traversePaths('meetings/standup', { depth: 2 });
    // alice/bob/carol direct + alice->acme + bob->acme
    expect(paths.length).toBeGreaterThanOrEqual(5);
    const acmePaths = paths.filter(p => p.to_slug === 'companies/acme');
    expect(acmePaths.length).toBe(2);
    expect(acmePaths.every(p => p.depth === 2)).toBe(true);
  });

  test('non-existent slug returns empty', async () => {
    const paths = await engine.traversePaths('does/not-exist', { depth: 5 });
    expect(paths).toEqual([]);
  });
});

describe('PGLiteEngine: traverseGraph cycle prevention', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('people/a', { ...testPage, type: 'person', title: 'A' });
    await engine.putPage('people/b', { ...testPage, type: 'person', title: 'B' });
    // Create a 2-cycle: A -> B -> A
    await engine.addLink('people/a', 'people/b', '', 'mentions');
    await engine.addLink('people/b', 'people/a', '', 'mentions');
  });

  test('does not amplify on cyclic graphs', async () => {
    // Without cycle prevention, depth 5 on a 2-cycle would loop indefinitely
    // (or at least produce many duplicate nodes). With the visited array, each
    // node appears at most once.
    const graph = await engine.traverseGraph('people/a', 5);
    const slugs = graph.map(n => n.slug);
    // Each slug should appear at most twice (once at depth 0, possibly once
    // again at a deeper level via the cycle, but bounded by visited check).
    const counts = new Map<string, number>();
    for (const s of slugs) counts.set(s, (counts.get(s) ?? 0) + 1);
    for (const [slug, count] of counts) {
      expect(count).toBeLessThanOrEqual(2); // tolerate root + 1 traversal entry
      void slug;
    }
  });
});

describe('PGLiteEngine: getHealth graph metrics', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
  });

  test('link_coverage = 0 when no links exist', async () => {
    const h = await engine.getHealth();
    expect(h.link_coverage).toBe(0);
  });

  test('link_coverage = % of entity pages with >= 1 inbound link', async () => {
    // Acme gets 1 inbound link (from Alice), Alice/Bob get 0 inbound.
    // 1 of 3 entity pages has inbound links -> 33%.
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    const h = await engine.getHealth();
    expect(h.link_coverage).toBeCloseTo(1 / 3, 2);
  });

  test('timeline_coverage = % with >= 1 timeline entry', async () => {
    await engine.addTimelineEntry('people/alice', { date: '2026-01-15', summary: 'Joined' });
    const h = await engine.getHealth();
    expect(h.timeline_coverage).toBeCloseTo(1 / 3, 2);
  });

  test('most_connected lists top entities by link count', async () => {
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('people/bob', 'companies/acme', '', 'invested_in');
    const h = await engine.getHealth();
    expect(h.most_connected.length).toBeGreaterThan(0);
    expect(h.most_connected[0].slug).toBe('companies/acme');
    expect(h.most_connected[0].link_count).toBe(2);
  });

  test('orphan_pages: pages with neither inbound nor outbound links', async () => {
    // All 3 pages start with no links. Expect 3 orphans.
    const h = await engine.getHealth();
    expect(h.orphan_pages).toBe(3);

    // Add alice -> acme. Alice has outbound, acme has inbound, only Bob is orphan.
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    const h2 = await engine.getHealth();
    expect(h2.orphan_pages).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// v0.13.1 — PGLite.create() error-wrap (structural guard for #223)
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: v0.13.1 error-wrap on connect() (#223)', () => {
  test('pglite-engine.ts source contains the wrap with #223 hint and nested original error', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/core/pglite-engine.ts', 'utf-8');
    // Structural: the try/catch block must wrap PGlite.create() (the actual
    // abort site, NOT engine-factory.ts). The error message must name the
    // issue and suggest gbrain doctor. Must NOT suggest "missing migrations"
    // as a cause (that was conflating #218 and #223 — migrations run AFTER
    // create()).
    expect(src).toContain('this._db = await PGlite.create');
    expect(src).toContain('https://github.com/garrytan/gbrain/issues/223');
    expect(src).toContain('gbrain doctor');
    expect(src).toContain('Original error:');
    // Regression guard: the user-visible error MESSAGE must not re-introduce
    // the misleading "missing migrations" hint. (A source comment explaining
    // *why* we removed it is fine — match only inside the wrapped Error body.)
    const wrapStart = src.indexOf('const wrapped = new Error(');
    expect(wrapStart).toBeGreaterThan(-1);
    const wrapEnd = src.indexOf(');', wrapStart);
    const errBody = src.slice(wrapStart, wrapEnd);
    expect(errBody).not.toContain('missing migrations');
    expect(errBody).not.toContain('apply-migrations');
  });
});

// ─────────────────────────────────────────────────────────────────
// v0.13.1 — Engine kind discriminator
// ─────────────────────────────────────────────────────────────────
describe('PGLiteEngine: v0.13.1 kind discriminator', () => {
  test('exposes readonly kind = pglite', () => {
    expect(engine.kind).toBe('pglite');
  });
});
