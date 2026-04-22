/**
 * PGLite Engine Tests — validates all 37 BrainEngine methods against PGLite (in-memory).
 *
 * No Docker, no DATABASE_URL, no external dependencies. Runs instantly in CI.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { buildPageChunks, importFromContent } from '../src/core/import-file.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput, ChunkInput } from '../src/core/types.ts';
import { importContentHash } from '../src/core/utils.ts';

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
    // Verify the PL/pgSQL trigger fires and search_vector is populated
    const results = await engine.searchKeyword('enterprise automation');
    expect(results.length).toBeGreaterThan(0);
  });

  test('searchVector returns empty when no embeddings', async () => {
    const fakeEmbedding = new Float32Array(768);
    const results = await engine.searchVector(fakeEmbedding);
    expect(results.length).toBe(0);
  });

  test('searchKeyword honors type and exclude_slugs filters', async () => {
    await engine.putPage('people/alice-keyword', {
      type: 'person',
      title: 'Alice Keyword',
      compiled_truth: 'Keyword retrieval for a person entry.',
    });
    await engine.upsertChunks('people/alice-keyword', [
      { chunk_index: 0, chunk_text: 'keyword retrieval for person', chunk_source: 'compiled_truth' },
    ]);

    await engine.putPage('projects/apollo-keyword', {
      type: 'project',
      title: 'Apollo Keyword',
      compiled_truth: 'Keyword retrieval for a project entry.',
    });
    await engine.upsertChunks('projects/apollo-keyword', [
      { chunk_index: 0, chunk_text: 'keyword retrieval for project', chunk_source: 'compiled_truth' },
    ]);

    const peopleOnly = await engine.searchKeyword('keyword retrieval', { type: 'person' });
    expect(peopleOnly.map((entry) => entry.slug)).toEqual(['people/alice-keyword']);

    const excluded = await engine.searchKeyword('keyword retrieval', {
      type: 'person',
      exclude_slugs: ['people/alice-keyword'],
    });
    expect(excluded).toEqual([]);
  });

  test('searchKeyword finds codemap symbols stored in technical frontmatter', async () => {
    const frontmatter = {
      codemap: [
        {
          system: 'systems/llvm',
          pointers: [
            {
              path: 'llvm/lib/Passes/PassBuilder.cpp',
              symbol: 'PassBuilder::buildPerModuleDefaultPipeline()',
              role: 'Builds the default optimization pipeline',
              verified_at: '2026-04-15',
            },
          ],
        },
      ],
    };

    await engine.putPage('systems/llvm', {
      type: 'system',
      title: 'LLVM',
      compiled_truth: 'Compiler infrastructure overview.',
      timeline: '',
      frontmatter,
    });
    await engine.upsertChunks('systems/llvm', buildPageChunks('Compiler infrastructure overview.', '', frontmatter));

    const results = await engine.searchKeyword('PassBuilder default pipeline');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.slug).toBe('systems/llvm');
    expect(results[0]?.chunk_source).toBe('frontmatter');
    expect(results[0]?.chunk_text).toContain('PassBuilder::buildPerModuleDefaultPipeline()');
  });

  test('searchKeyword prefers frontmatter snippets even before frontmatter chunks are rebuilt', async () => {
    const frontmatter = {
      codemap: [
        {
          system: 'systems/llvm',
          pointers: [
            {
              path: 'llvm/lib/Passes/LegacyPassBuilder.cpp',
              symbol: 'LegacyPassBuilder::rebuildPipeline()',
              role: 'Rebuilds the legacy optimization pipeline',
              verified_at: '2026-04-15',
            },
          ],
        },
      ],
    };

    await engine.putPage('systems/llvm-migrated', {
      type: 'system',
      title: 'LLVM Migrated',
      compiled_truth: 'Compiler infrastructure overview.',
      timeline: '',
      frontmatter,
    });
    await engine.upsertChunks('systems/llvm-migrated', [
      {
        chunk_index: 0,
        chunk_text: 'Compiler infrastructure overview.',
        chunk_source: 'compiled_truth',
      },
    ]);

    const results = await engine.searchKeyword('LegacyPassBuilder rebuild pipeline');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.slug).toBe('systems/llvm-migrated');
    expect(results[0]?.chunk_source).toBe('frontmatter');
    expect(results[0]?.chunk_text).toContain('LegacyPassBuilder::rebuildPipeline()');
  });

  test('migration v6 backfills dedicated frontmatter chunks for upgraded pages', async () => {
    const frontmatter = {
      codemap: [
        {
          system: 'systems/llvm',
          pointers: [
            {
              path: 'llvm/lib/Passes/LegacyPassBuilder.cpp',
              symbol: 'LegacyPassBuilder::rebuildPipeline()',
              role: 'Rebuilds the legacy optimization pipeline',
              verified_at: '2026-04-15',
            },
          ],
        },
      ],
    };

    await engine.putPage('systems/llvm-upgraded', {
      type: 'system',
      title: 'LLVM Upgraded',
      compiled_truth: 'Compiler infrastructure overview.',
      timeline: '',
      frontmatter,
    });
    await engine.upsertChunks('systems/llvm-upgraded', [
      {
        chunk_index: 0,
        chunk_text: 'Compiler infrastructure overview.',
        chunk_source: 'compiled_truth',
      },
    ]);
    await engine.setConfig('version', String(5));

    await runMigrations(engine);

    const chunks = await engine.getChunks('systems/llvm-upgraded');
    expect(chunks.map(chunk => chunk.chunk_source)).toEqual(['compiled_truth', 'frontmatter']);
    expect(chunks[1]?.chunk_text).toContain('LegacyPassBuilder::rebuildPipeline()');
  });

  test('rerunning initSchema upgrades version 6 databases missing page_embedding', async () => {
    await engine.putPage('systems/page-embedding-upgrade', {
      type: 'system',
      title: 'Page Embedding Upgrade',
      compiled_truth: 'Upgrade coverage for page embeddings.',
    });

    await (engine as any).db.exec(`ALTER TABLE pages DROP COLUMN page_embedding`);
    await engine.setConfig('version', '6');

    await engine.initSchema();

    const embedding = new Float32Array(768);
    embedding[0] = 1;
    embedding[1] = 2;
    embedding[2] = 3;

    await engine.updatePageEmbedding('systems/page-embedding-upgrade', embedding);

    const pageEmbeddings = await engine.getPageEmbeddings('system');
    const upgraded = pageEmbeddings.find((entry) => entry.slug === 'systems/page-embedding-upgrade');

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(upgraded).toBeDefined();
    expect(Array.from(upgraded!.embedding!.slice(0, 3))).toEqual([1, 2, 3]);
  });

  test('migration v7 backfills page_embedding centroids from existing chunk embeddings', async () => {
    await engine.putPage('systems/page-embedding-centroid-upgrade', {
      type: 'system',
      title: 'Page Embedding Centroid Upgrade',
      compiled_truth: 'Upgrade coverage for page embedding centroid backfill.',
    });

    const first = new Float32Array(768);
    first[0] = 1;
    first[1] = 2;
    first[2] = 3;
    const second = new Float32Array(768);
    second[0] = 3;
    second[1] = 4;
    second[2] = 5;

    await engine.upsertChunks('systems/page-embedding-centroid-upgrade', [
      { chunk_index: 0, chunk_text: 'First embedded chunk', chunk_source: 'compiled_truth', embedding: first },
      { chunk_index: 1, chunk_text: 'Second embedded chunk', chunk_source: 'timeline', embedding: second },
    ]);

    await (engine as any).db.exec(`ALTER TABLE pages DROP COLUMN page_embedding`);
    await engine.setConfig('version', '6');

    await engine.initSchema();

    const pageEmbeddings = await engine.getPageEmbeddings('system');
    const upgraded = pageEmbeddings.find((entry) => entry.slug === 'systems/page-embedding-centroid-upgrade');

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(upgraded?.embedding).not.toBeNull();
    expect(Array.from(upgraded!.embedding!.slice(0, 3))).toEqual([2, 3, 4]);
  });

  test('searchVector honors type and exclude_slugs filters', async () => {
    const personEmbedding = new Float32Array(768);
    personEmbedding[0] = 1;
    const projectEmbedding = new Float32Array(768);
    projectEmbedding[0] = 1;
    const queryEmbedding = new Float32Array(768);
    queryEmbedding[0] = 1;

    await engine.putPage('people/alice-vector', {
      type: 'person',
      title: 'Alice Vector',
      compiled_truth: 'Vector retrieval for a person entry.',
    });
    await engine.upsertChunks('people/alice-vector', [
      {
        chunk_index: 0,
        chunk_text: 'vector retrieval person',
        chunk_source: 'compiled_truth',
        embedding: personEmbedding,
      },
    ]);

    await engine.putPage('projects/apollo-vector', {
      type: 'project',
      title: 'Apollo Vector',
      compiled_truth: 'Vector retrieval for a project entry.',
    });
    await engine.upsertChunks('projects/apollo-vector', [
      {
        chunk_index: 0,
        chunk_text: 'vector retrieval project',
        chunk_source: 'compiled_truth',
        embedding: projectEmbedding,
      },
    ]);

    const projectsOnly = await engine.searchVector(queryEmbedding, { type: 'project' });
    expect(projectsOnly.map((entry) => entry.slug)).toEqual(['projects/apollo-vector']);

    const excluded = await engine.searchVector(queryEmbedding, {
      type: 'project',
      exclude_slugs: ['projects/apollo-vector'],
    });
    expect(excluded).toEqual([]);
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
    const embedding = new Float32Array(768).fill(0.1);
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

  test('revertToVersion restores content and technical search state', async () => {
    const originalFrontmatter = {
      codemap: [
        {
          system: 'systems/test-version',
          pointers: [
            {
              path: 'src/original.ts',
              symbol: 'Old::Symbol()',
              role: 'Original implementation',
              verified_at: '2026-04-16',
            },
          ],
        },
      ],
    };
    const updatedFrontmatter = {
      codemap: [
        {
          system: 'systems/test-version',
          pointers: [
            {
              path: 'src/updated.ts',
              symbol: 'New::Symbol()',
              role: 'Updated implementation',
              verified_at: '2026-04-16',
            },
          ],
        },
      ],
    };

    await engine.putPage('test/version', {
      ...testPage,
      type: 'system',
      title: 'Versioned System',
      compiled_truth: 'Original symbol map.',
      frontmatter: originalFrontmatter,
    });
    await engine.upsertChunks('test/version', buildPageChunks('Original symbol map.', '', originalFrontmatter));

    await engine.createVersion('test/version');
    await engine.putPage('test/version', {
      ...testPage,
      type: 'system',
      title: 'Versioned System',
      compiled_truth: 'Changed',
      frontmatter: updatedFrontmatter,
    });
    await engine.upsertChunks('test/version', buildPageChunks('Changed', '', updatedFrontmatter));

    const versions = await engine.getVersions('test/version');
    await engine.revertToVersion('test/version', versions[0].id);

    const page = await engine.getPage('test/version');
    expect(page!.compiled_truth).toBe('Original symbol map.');
    expect(page!.content_hash).toBe(importContentHash({
      title: 'Versioned System',
      type: 'system',
      compiled_truth: 'Original symbol map.',
      timeline: testPage.timeline!,
      frontmatter: originalFrontmatter,
      tags: [],
    }));
    expect(await engine.searchKeyword('New Symbol')).toEqual([]);
    expect((await engine.searchKeyword('Old Symbol')).map(result => result.slug)).toEqual(['test/version']);
    const chunks = await engine.getChunks('test/version');
    expect(chunks[0]?.chunk_text).toBe('Original symbol map.');
    expect(chunks[chunks.length - 1]?.chunk_text).toContain('Old::Symbol()');
    const rerun = await importFromContent(engine, 'test/version', `---
type: system
title: Versioned System
codemap:
  - system: systems/test-version
    pointers:
      - path: src/original.ts
        symbol: Old::Symbol()
        role: Original implementation
        verified_at: 2026-04-16
---
Original symbol map.

---
${testPage.timeline!}
`);
    expect(rerun.status).toBe('skipped');
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
