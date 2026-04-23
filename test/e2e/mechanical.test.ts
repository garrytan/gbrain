/**
 * E2E Mechanical Tests — Tier 1 (no API keys required)
 *
 * Tests all operations against a real Postgres+pgvector database.
 * Requires DATABASE_URL env var or .env.testing file.
 *
 * Run: DATABASE_URL=... bun test test/e2e/mechanical.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import {
  hasDatabase, setupDB, teardownDB, getEngine, getConn,
  importFixtures, importFixture, time, dumpDBState, FIXTURES_PATH,
} from './helpers.ts';
import { operationsByName, operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { importFromContent } from '../../src/core/import-file.ts';

// Skip all E2E tests if no database is configured
const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

function makeCtx(opts: { remote?: boolean } = {}): OperationContext {
  return {
    engine: getEngine(),
    config: { engine: 'postgres', database_url: process.env.DATABASE_URL! },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    // Default: trusted local invocation (matches `gbrain call` semantics).
    remote: opts.remote ?? false,
  };
}

async function callOp(name: string, params: Record<string, unknown> = {}) {
  const op = operationsByName[name];
  if (!op) throw new Error(`Unknown operation: ${name}`);
  return op.handler(makeCtx(), params);
}

// ─────────────────────────────────────────────────────────────────
// Page CRUD
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Page CRUD', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('fixture import creates correct page count', async () => {
    const stats = await callOp('get_stats') as any;
    expect(stats.page_count).toBe(16);
  });

  test('get_page returns correct data for person', async () => {
    const page = await callOp('get_page', { slug: 'people/sarah-chen' }) as any;
    expect(page.title).toBe('Sarah Chen');
    expect(page.type).toBe('person');
    expect(page.compiled_truth).toContain('NovaMind');
    expect(page.tags).toContain('founder');
    expect(page.tags).toContain('yc-w25');
  });

  test('get_page returns correct data for concept', async () => {
    const page = await callOp('get_page', { slug: 'concepts/retrieval-augmented-generation' }) as any;
    expect(page.title).toBe('Retrieval-Augmented Generation');
    expect(page.type).toBe('concept');
    expect(page.compiled_truth).toContain('検索拡張生成');
  });

  test('get_page for company includes key details', async () => {
    const page = await callOp('get_page', { slug: 'companies/novamind' }) as any;
    expect(page.type).toBe('company');
    expect(page.compiled_truth).toContain('Sarah Chen');
  });

  test('list_pages type filter returns correct count', async () => {
    const people = await callOp('list_pages', { type: 'person' }) as any[];
    expect(people.length).toBe(3);

    const companies = await callOp('list_pages', { type: 'company' }) as any[];
    expect(companies.length).toBe(3); // novamind, threshold-ventures, ohmygreen

    const concepts = await callOp('list_pages', { type: 'concept' }) as any[];
    expect(concepts.length).toBe(5); // compiled-truth, hybrid-search, RAG, notes-march-2024, big-file
  });

  test('list_pages tag filter works', async () => {
    const ycPages = await callOp('list_pages', { tag: 'yc-w25' }) as any[];
    expect(ycPages.length).toBeGreaterThanOrEqual(2);
    expect(ycPages.some((p: any) => p.slug === 'people/sarah-chen')).toBe(true);
  });

  test('put_page updates existing page', async () => {
    const updated = readFileSync(join(FIXTURES_PATH, 'people/sarah-chen.md'), 'utf-8')
      .replace('Stanford CS', 'MIT CS');
    // Use importFromContent directly with noEmbed to avoid OpenAI timeout
    const engine = getEngine();
    const result = await importFromContent(engine, 'people/sarah-chen', updated, { noEmbed: true });
    expect(result.status).toBe('imported');
    const page = await callOp('get_page', { slug: 'people/sarah-chen' }) as any;
    expect(page.compiled_truth).toContain('MIT CS');
  });

  test('delete_page removes page and others survive', async () => {
    await callOp('delete_page', { slug: 'sources/crustdata-sarah-chen' });
    const stats = await callOp('get_stats') as any;
    expect(stats.page_count).toBe(15);

    // Other pages still exist
    const sarah = await callOp('get_page', { slug: 'people/sarah-chen' }) as any;
    expect(sarah.title).toBe('Sarah Chen');
  });
});

// ─────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Search', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('keyword search for "NovaMind" returns multiple hits', async () => {
    const results = await callOp('search', { query: 'NovaMind' }) as any[];
    expect(results.length).toBeGreaterThanOrEqual(3);
    const slugs = results.map((r: any) => r.slug);
    expect(slugs).toContain('companies/novamind');
  });

  test('keyword search for "Threshold Ventures" finds investor', async () => {
    const results = await callOp('search', { query: 'Threshold Ventures' }) as any[];
    expect(results.length).toBeGreaterThanOrEqual(1);
    const slugs = results.map((r: any) => r.slug);
    expect(slugs).toContain('companies/threshold-ventures');
  });

  test('keyword search for "Stanford" finds Priya', async () => {
    const results = await callOp('search', { query: 'Stanford' }) as any[];
    expect(results.length).toBeGreaterThanOrEqual(1);
    const slugs = results.map((r: any) => r.slug);
    expect(slugs).toContain('people/priya-patel');
  });

  test('keyword search for nonexistent term returns empty', async () => {
    const results = await callOp('search', { query: 'xyznonexistent123' }) as any[];
    expect(results.length).toBe(0);
  });

  test('search quality: precision@5 for known queries', async () => {
    const groundTruth: Record<string, string[]> = {
      'NovaMind': ['people/sarah-chen', 'companies/novamind', 'deals/novamind-seed'],
      'hybrid search': ['concepts/hybrid-search', 'concepts/retrieval-augmented-generation'],
      'compiled truth': ['concepts/compiled-truth'],
    };

    const scores: Record<string, number> = {};
    for (const [query, expected] of Object.entries(groundTruth)) {
      const results = await callOp('search', { query, limit: 5 }) as any[];
      const topSlugs = results.slice(0, 5).map((r: any) => r.slug);
      const hits = expected.filter(e => topSlugs.includes(e));
      scores[query] = hits.length / Math.min(expected.length, 5);
    }

    console.log('\n  Search Quality (precision@5, keyword-only):');
    for (const [query, score] of Object.entries(scores)) {
      console.log(`    "${query}": ${(score * 100).toFixed(0)}%`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Links
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Links', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('add_link + get_links + get_backlinks round trip', async () => {
    await callOp('add_link', {
      from: 'people/sarah-chen',
      to: 'companies/novamind',
      link_type: 'founded',
      context: 'CEO and founder since 2024',
    });

    const links = await callOp('get_links', { slug: 'people/sarah-chen' }) as any[];
    expect(links.some((l: any) => l.to_slug === 'companies/novamind' || l.to_page_slug === 'companies/novamind')).toBe(true);

    const backlinks = await callOp('get_backlinks', { slug: 'companies/novamind' }) as any[];
    expect(backlinks.some((l: any) => l.from_slug === 'people/sarah-chen' || l.from_page_slug === 'people/sarah-chen')).toBe(true);
  });

  test('traverse_graph finds connected pages', async () => {
    // Links should already be added from prior test in this describe block
    const graph = await callOp('traverse_graph', { slug: 'people/sarah-chen', depth: 2 }) as any;
    expect(Array.isArray(graph)).toBe(true);
    expect(graph.length).toBeGreaterThanOrEqual(1);
  });

  test('remove_link removes the link', async () => {
    await callOp('add_link', { from: 'people/marcus-reid', to: 'companies/threshold-ventures' });
    await callOp('remove_link', { from: 'people/marcus-reid', to: 'companies/threshold-ventures' });

    const links = await callOp('get_links', { slug: 'people/marcus-reid' }) as any[];
    const hasLink = links.some((l: any) =>
      (l.to_slug || l.to_page_slug) === 'companies/threshold-ventures'
    );
    expect(hasLink).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// Tags
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Tags', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('get_tags returns imported tags', async () => {
    const tags = await callOp('get_tags', { slug: 'people/sarah-chen' }) as string[];
    expect(tags).toContain('founder');
    expect(tags).toContain('yc-w25');
    expect(tags).toContain('ai-agents');
  });

  test('add_tag + remove_tag round trip', async () => {
    await callOp('add_tag', { slug: 'people/marcus-reid', tag: 'test-tag' });
    let tags = await callOp('get_tags', { slug: 'people/marcus-reid' }) as string[];
    expect(tags).toContain('test-tag');

    await callOp('remove_tag', { slug: 'people/marcus-reid', tag: 'test-tag' });
    tags = await callOp('get_tags', { slug: 'people/marcus-reid' }) as string[];
    expect(tags).not.toContain('test-tag');
  });

  test('list_pages with tag filter finds tagged pages', async () => {
    await callOp('add_tag', { slug: 'people/priya-patel', tag: 'test-search-tag' });
    const pages = await callOp('list_pages', { tag: 'test-search-tag' }) as any[];
    expect(pages.length).toBe(1);
    expect(pages[0].slug).toBe('people/priya-patel');
  });
});

// ─────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Timeline', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('add_timeline_entry + get_timeline round trip', async () => {
    await callOp('add_timeline_entry', {
      slug: 'people/sarah-chen',
      date: '2025-04-01',
      summary: 'Test timeline entry',
      detail: 'Added via E2E test',
      source: 'e2e-test',
    });

    const timeline = await callOp('get_timeline', { slug: 'people/sarah-chen' }) as any[];
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    const entry = timeline.find((e: any) => e.summary === 'Test timeline entry');
    expect(entry).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// Batch methods (addLinksBatch / addTimelineEntriesBatch)
// ─────────────────────────────────────────────────────────────────
//
// Postgres-engine batch methods use postgres-js's sql(rows, 'col1', ...) helper,
// which is structurally different from PGLite's manual $N placeholder construction
// (covered in test/pglite-engine.test.ts). These tests verify the postgres-js code
// path against a real Postgres against the same invariants.

describeE2E('E2E: addLinksBatch (postgres-engine)', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('empty batch returns 0 with no DB call', async () => {
    const engine = getEngine();
    expect(await engine.addLinksBatch([])).toBe(0);
  });

  test('within-batch duplicates dedup via ON CONFLICT (no 21000 cardinality error)', async () => {
    const engine = getEngine();
    const conn = getConn();
    // Deterministic cleanup so re-runs aren't perturbed by prior fixture state.
    await conn`DELETE FROM links WHERE link_type = 'e2e-batch-dup'`;
    const inserted = await engine.addLinksBatch([
      { from_slug: 'people/sarah-chen', to_slug: 'companies/novamind', link_type: 'e2e-batch-dup' },
      { from_slug: 'people/sarah-chen', to_slug: 'companies/novamind', link_type: 'e2e-batch-dup' },
    ]);
    expect(inserted).toBe(1);
    await conn`DELETE FROM links WHERE link_type = 'e2e-batch-dup'`;
  });

  test('rows with missing slug silently dropped by JOIN', async () => {
    const engine = getEngine();
    const conn = getConn();
    await conn`DELETE FROM links WHERE link_type = 'e2e-batch-missing'`;
    const inserted = await engine.addLinksBatch([
      { from_slug: 'people/does-not-exist', to_slug: 'companies/novamind', link_type: 'e2e-batch-missing' },
      { from_slug: 'people/sarah-chen', to_slug: 'companies/novamind', link_type: 'e2e-batch-missing' },
    ]);
    expect(inserted).toBe(1);
    await conn`DELETE FROM links WHERE link_type = 'e2e-batch-missing'`;
  });

  test('half-existing batch returns count of new only', async () => {
    const engine = getEngine();
    const conn = getConn();
    await conn`DELETE FROM links WHERE link_type = 'e2e-batch-half'`;
    await engine.addLink('people/sarah-chen', 'companies/novamind', 'pre-existing', 'e2e-batch-half');
    const inserted = await engine.addLinksBatch([
      { from_slug: 'people/sarah-chen', to_slug: 'companies/novamind', link_type: 'e2e-batch-half' },
      { from_slug: 'people/sarah-chen', to_slug: 'people/marcus-reid', link_type: 'e2e-batch-half' },
    ]);
    expect(inserted).toBe(1);
    await conn`DELETE FROM links WHERE link_type = 'e2e-batch-half'`;
  });

  test('missing optional fields normalize to empty strings (NOT NULL safety)', async () => {
    const engine = getEngine();
    const conn = getConn();
    await conn`DELETE FROM links WHERE link_type = ''`;
    // No link_type, no context — must default to '' to satisfy NOT NULL.
    const inserted = await engine.addLinksBatch([
      { from_slug: 'people/sarah-chen', to_slug: 'companies/novamind' },
    ]);
    expect(inserted).toBe(1);
    const rows = await conn`
      SELECT link_type, context FROM links
      WHERE from_page_id = (SELECT id FROM pages WHERE slug = 'people/sarah-chen')
        AND to_page_id = (SELECT id FROM pages WHERE slug = 'companies/novamind')
        AND link_type = ''
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].context).toBe('');
    await conn`DELETE FROM links WHERE link_type = ''`;
  });
});

describeE2E('E2E: addTimelineEntriesBatch (postgres-engine)', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('empty batch returns 0', async () => {
    const engine = getEngine();
    expect(await engine.addTimelineEntriesBatch([])).toBe(0);
  });

  test('within-batch duplicates dedup via ON CONFLICT', async () => {
    const engine = getEngine();
    const conn = getConn();
    await conn`DELETE FROM timeline_entries WHERE summary = 'e2e-batch-tl-dup'`;
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'people/sarah-chen', date: '2025-05-01', summary: 'e2e-batch-tl-dup' },
      { slug: 'people/sarah-chen', date: '2025-05-01', summary: 'e2e-batch-tl-dup' },
    ]);
    expect(inserted).toBe(1);
    await conn`DELETE FROM timeline_entries WHERE summary = 'e2e-batch-tl-dup'`;
  });

  test('rows with missing slug silently dropped by JOIN', async () => {
    const engine = getEngine();
    const conn = getConn();
    await conn`DELETE FROM timeline_entries WHERE summary = 'e2e-batch-tl-missing'`;
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'people/no-such-page', date: '2025-05-02', summary: 'e2e-batch-tl-missing' },
      { slug: 'people/sarah-chen', date: '2025-05-02', summary: 'e2e-batch-tl-missing' },
    ]);
    expect(inserted).toBe(1);
    await conn`DELETE FROM timeline_entries WHERE summary = 'e2e-batch-tl-missing'`;
  });

  test('mix of new + existing returns count of new only', async () => {
    const engine = getEngine();
    const conn = getConn();
    await conn`DELETE FROM timeline_entries WHERE summary IN ('e2e-batch-tl-half-1', 'e2e-batch-tl-half-2')`;
    await engine.addTimelineEntry('people/sarah-chen', { date: '2025-05-03', summary: 'e2e-batch-tl-half-1' });
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'people/sarah-chen', date: '2025-05-03', summary: 'e2e-batch-tl-half-1' },
      { slug: 'people/sarah-chen', date: '2025-05-04', summary: 'e2e-batch-tl-half-2' },
    ]);
    expect(inserted).toBe(1);
    await conn`DELETE FROM timeline_entries WHERE summary IN ('e2e-batch-tl-half-1', 'e2e-batch-tl-half-2')`;
  });
});

// ─────────────────────────────────────────────────────────────────
// Versions
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Versions', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('put_page creates version, revert restores', async () => {
    const original = await callOp('get_page', { slug: 'people/sarah-chen' }) as any;

    // Modify page using importFromContent with noEmbed
    const modified = readFileSync(join(FIXTURES_PATH, 'people/sarah-chen.md'), 'utf-8')
      .replace('Sarah Chen', 'Sarah Chen (Modified)');
    const engine = getEngine();
    await importFromContent(engine, 'people/sarah-chen', modified, { noEmbed: true });

    // Check versions exist
    const versions = await callOp('get_versions', { slug: 'people/sarah-chen' }) as any[];
    expect(versions.length).toBeGreaterThanOrEqual(1);

    // Revert to first version
    const firstVersion = versions[versions.length - 1];
    await callOp('revert_version', { slug: 'people/sarah-chen', version_id: firstVersion.id });

    const reverted = await callOp('get_page', { slug: 'people/sarah-chen' }) as any;
    expect(reverted.compiled_truth).not.toContain('(Modified)');
  });
});

// ─────────────────────────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Admin', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('get_stats returns valid structure', async () => {
    const stats = await callOp('get_stats') as any;
    expect(stats.page_count).toBe(16);
    expect(typeof stats.chunk_count).toBe('number');
  });

  test('get_health returns valid structure', async () => {
    const health = await callOp('get_health') as any;
    expect(health).toBeDefined();
    expect(typeof health.page_count).toBe('number');
    expect(typeof health.embed_coverage).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────
// Chunks & Resolution
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Chunks & Resolution', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('get_chunks returns chunks for imported page', async () => {
    const chunks = await callOp('get_chunks', { slug: 'people/sarah-chen' }) as any[];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].chunk_text).toBeTruthy();
  });

  test('resolve_slugs finds partial match', async () => {
    const matches = await callOp('resolve_slugs', { partial: 'sarah' }) as string[];
    expect(matches).toContain('people/sarah-chen');
  });

  test('resolve_slugs finds exact match', async () => {
    const matches = await callOp('resolve_slugs', { partial: 'people/sarah-chen' }) as string[];
    expect(matches).toContain('people/sarah-chen');
  });
});

// ─────────────────────────────────────────────────────────────────
// Ingest Log & Raw Data
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Ingest Log & Raw Data', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('log_ingest + get_ingest_log round trip', async () => {
    await callOp('log_ingest', {
      source_type: 'e2e-test',
      source_ref: 'test-run-1',
      pages_updated: ['people/sarah-chen', 'companies/novamind'],
      summary: 'E2E test ingest',
    });

    const log = await callOp('get_ingest_log', { limit: 5 }) as any[];
    expect(log.length).toBeGreaterThanOrEqual(1);
    const entry = log.find((e: any) => e.source_ref === 'test-run-1');
    expect(entry).toBeDefined();
    expect(entry.source_type).toBe('e2e-test');
  });

  test('put_raw_data + get_raw_data round trip', async () => {
    const testData = { education: 'Stanford CS 2020', title: 'CEO' };
    await callOp('put_raw_data', {
      slug: 'people/sarah-chen',
      source: 'crustdata',
      data: testData,
    });

    const raw = await callOp('get_raw_data', {
      slug: 'people/sarah-chen',
      source: 'crustdata',
    }) as any[];
    expect(raw.length).toBeGreaterThanOrEqual(1);
    // JSONB may come back as string or parsed object
    const data = typeof raw[0].data === 'string' ? JSON.parse(raw[0].data) : raw[0].data;
    expect(data.education).toBe('Stanford CS 2020');
    expect(data.title).toBe('CEO');
  });
});

// ─────────────────────────────────────────────────────────────────
// Files (stub verification)
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Files', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('file_list returns empty initially', async () => {
    const files = await callOp('file_list', {}) as any[];
    expect(files.length).toBe(0);
  });

  test('file_upload stores metadata + file_list shows it', async () => {
    // Create a temp file
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-e2e-'));
    const tmpFile = join(tmpDir, 'test-doc.pdf');
    writeFileSync(tmpFile, 'fake pdf content');

    try {
      const result = await callOp('file_upload', {
        path: tmpFile,
        page_slug: 'people/sarah-chen',
      }) as any;
      expect(result.status).toBe('uploaded');
      expect(result.storage_path).toContain('sarah-chen');

      // Verify file_list
      const files = await callOp('file_list', {}) as any[];
      expect(files.length).toBe(1);

      // Verify file_url returns URI format
      const url = await callOp('file_url', { storage_path: result.storage_path }) as any;
      expect(url.url).toContain('gbrain:files/');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  // Security-wave-3 regression: MCP/remote callers MUST be confined to cwd
  // (Issue #139). Local CLI callers are unrestricted — different trust model.
  test('file_upload rejects outside-cwd paths for remote (MCP) callers', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-e2e-ssrf-'));
    const tmpFile = join(tmpDir, 'stealable.txt');
    writeFileSync(tmpFile, 'sensitive');

    try {
      const op = operationsByName['file_upload'];
      let threw = false;
      try {
        await op.handler(makeCtx({ remote: true }), {
          path: tmpFile,
          page_slug: 'people/sarah-chen',
        });
      } catch (e: any) {
        threw = true;
        expect(String(e.message || e)).toMatch(/within the working directory/i);
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Security: Query Bounds
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: file_list LIMIT enforcement', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(teardownDB);

  test('file_list with slug filter respects LIMIT 100', async () => {
    const sql = getConn();
    const testSlug = 'test-limit-slug';

    // Create the parent page first (FK constraint on files.page_slug)
    await sql`
      INSERT INTO pages (slug, title, type, compiled_truth, frontmatter)
      VALUES (${testSlug}, ${'Test Limit Page'}, ${'note'}, ${'body'}, ${'{}'}::jsonb)
      ON CONFLICT (source_id, slug) DO NOTHING
    `;

    // Insert 150 file rows for the same slug
    for (let i = 0; i < 150; i++) {
      await sql`
        INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
        VALUES (${testSlug}, ${'file-' + String(i).padStart(3, '0') + '.txt'}, ${testSlug + '/file-' + i + '.txt'}, ${'text/plain'}, ${100}, ${'hash-' + i}, ${'{}'}::jsonb)
        ON CONFLICT (storage_path) DO NOTHING
      `;
    }

    // Verify we inserted 150
    const count = await sql`SELECT count(*) as cnt FROM files WHERE page_slug = ${testSlug}`;
    expect(Number(count[0].cnt)).toBe(150);

    // Call file_list with slug — should return at most 100
    const files = await callOp('file_list', { slug: testSlug }) as any[];
    expect(files.length).toBeLessThanOrEqual(100);
    expect(files.length).toBe(100);
  });

  test('file_list without slug also respects LIMIT 100', async () => {
    // The 150 rows from the previous test are still in the DB
    const files = await callOp('file_list', {}) as any[];
    expect(files.length).toBeLessThanOrEqual(100);
  });
});

// ─────────────────────────────────────────────────────────────────
// Idempotency Stress
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Idempotency', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(teardownDB);

  test('double import produces no duplicates', async () => {
    // First import
    await importFixtures();
    const stats1 = await callOp('get_stats') as any;

    // Second import (identical content)
    await importFixtures();
    const stats2 = await callOp('get_stats') as any;

    expect(stats2.page_count).toBe(stats1.page_count);
    expect(stats2.chunk_count).toBe(stats1.chunk_count);
  });

  test('modify one fixture, reimport, only that page updates', async () => {
    await importFixtures();
    const engine = getEngine();

    // Modify sarah-chen content
    const modified = readFileSync(join(FIXTURES_PATH, 'people/sarah-chen.md'), 'utf-8')
      .replace('Stanford CS', 'MIT CS');

    const result = await importFromContent(engine, 'people/sarah-chen', modified, { noEmbed: true });
    expect(result.status).toBe('imported');

    // Other pages should have been skipped if reimported
    const content = readFileSync(join(FIXTURES_PATH, 'people/marcus-reid.md'), 'utf-8');
    const { parseMarkdown } = await import('../../src/core/markdown.ts');
    const parsed = parseMarkdown(content, 'people/marcus-reid.md');
    const result2 = await importFromContent(engine, parsed.slug, content, { noEmbed: true });
    expect(result2.status).toBe('skipped');
  });
});

// ─────────────────────────────────────────────────────────────────
// Setup Journey (CLI subprocess tests)
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Setup Journey', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(teardownDB);

  const cliCwd = join(import.meta.dir, '../..');
  const cliEnv = () => ({ ...process.env, DATABASE_URL: process.env.DATABASE_URL! });

  test('gbrain init --non-interactive connects and initializes', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'init', '--non-interactive', '--url', process.env.DATABASE_URL!],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 15_000,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Brain ready');
  }, 30_000);

  test('gbrain import imports fixtures via CLI', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'import', '--no-embed', FIXTURES_PATH],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 30_000,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('imported');
  }, 60_000);

  test('gbrain search returns results via CLI', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'search', 'NovaMind'],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 15_000,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  }, 30_000);

  test('gbrain stats shows page count via CLI', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'stats'],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test('gbrain health runs via CLI', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'health'],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────
// Init Edge Cases
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Init Edge Cases', () => {
  afterAll(teardownDB);

  test('init --non-interactive without URL fails gracefully', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.GBRAIN_DATABASE_URL;
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'init', '--non-interactive'],
      cwd: join(import.meta.dir, '../..'),
      env,
      timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  test('double init is idempotent', async () => {
    await setupDB();
    const conn = getConn();
    const before = await conn.unsafe(`SELECT count(*) as n FROM information_schema.tables WHERE table_schema = 'public'`);

    // Re-init
    const { initSchema } = await import('../../src/core/db.ts');
    await initSchema();

    const after = await conn.unsafe(`SELECT count(*) as n FROM information_schema.tables WHERE table_schema = 'public'`);
    expect(after[0].n).toBe(before[0].n);
  });

  test('init then import then re-init preserves pages', async () => {
    await setupDB();
    await importFixtures();
    const before = await callOp('get_stats') as any;

    const { initSchema } = await import('../../src/core/db.ts');
    await initSchema();

    const after = await callOp('get_stats') as any;
    expect(after.page_count).toBe(before.page_count);
  });
});

// ─────────────────────────────────────────────────────────────────
// Schema Idempotency
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Schema Idempotency', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(teardownDB);

  test('initSchema twice produces no errors and same object count', async () => {
    const conn = getConn();
    const tables1 = await conn.unsafe(`SELECT count(*) as n FROM information_schema.tables WHERE table_schema = 'public'`);
    const indexes1 = await conn.unsafe(`SELECT count(*) as n FROM pg_indexes WHERE schemaname = 'public'`);

    const { initSchema } = await import('../../src/core/db.ts');
    await initSchema();

    const tables2 = await conn.unsafe(`SELECT count(*) as n FROM information_schema.tables WHERE table_schema = 'public'`);
    const indexes2 = await conn.unsafe(`SELECT count(*) as n FROM pg_indexes WHERE schemaname = 'public'`);

    expect(tables2[0].n).toBe(tables1[0].n);
    expect(indexes2[0].n).toBe(indexes1[0].n);
  });
});

// ─────────────────────────────────────────────────────────────────
// Schema Diff Guard
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Schema Diff Guard', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(teardownDB);

  test('all expected tables exist', async () => {
    const conn = getConn();
    const tables = await conn.unsafe(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const tableNames = tables.map((t: any) => t.table_name);

    const expected = [
      'config', 'content_chunks', 'files', 'ingest_log',
      'links', 'page_versions', 'pages', 'raw_data',
      'tags', 'timeline_entries',
    ];
    for (const table of expected) {
      expect(tableNames).toContain(table);
    }
  });

  test('pgvector extension is installed', async () => {
    const conn = getConn();
    const ext = await conn.unsafe(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    expect(ext.length).toBe(1);
  });

  test('pg_trgm extension is installed', async () => {
    const conn = getConn();
    const ext = await conn.unsafe(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(ext.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// Slug with Special Characters (Apple Notes fix)
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Slug with Special Characters', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  test('imports files with spaces in filename', async () => {
    const page = await callOp('get_page', { slug: 'apple-notes/2017-05-03-ohmygreen' }) as any;
    expect(page).not.toBeNull();
    expect(page.title).toBe('OhMyGreen');
    expect(page.type).toBe('company');
  });

  test('imports files with parens in filename', async () => {
    const page = await callOp('get_page', { slug: 'apple-notes/notes-march-2024' }) as any;
    expect(page).not.toBeNull();
    expect(page.title).toBe('March 2024 Notes');
  });

  test('search finds content from special-char files', async () => {
    const results = await callOp('search', { query: 'OhMyGreen' }) as any[];
    expect(results.length).toBeGreaterThanOrEqual(1);
    const slugs = results.map((r: any) => r.slug);
    expect(slugs).toContain('apple-notes/2017-05-03-ohmygreen');
  });

  test('re-import of special-char files is idempotent', async () => {
    const before = await callOp('get_stats') as any;
    await importFixtures(); // second import
    const after = await callOp('get_stats') as any;
    expect(after.page_count).toBe(before.page_count);
  });
});

// ─────────────────────────────────────────────────────────────────
// RLS Verification
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: RLS Verification', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(teardownDB);

  const cliCwd = join(import.meta.dir, '../..');
  const cliEnv = () => ({ ...process.env, DATABASE_URL: process.env.DATABASE_URL!, GBRAIN_DATABASE_URL: process.env.DATABASE_URL! });

  // Seed a unique suffix per run so concurrent test DBs / crashed prior
  // runs don't collide. All helper tables follow `gbrain_rls_regression_<suffix>`.
  const suffix = `${process.pid}_${Date.now()}`;

  test('RLS is enabled on every public table (no hardcoded allowlist)', async () => {
    const conn = getConn();
    const tables = await conn.unsafe(`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname = 'public'
    `);
    const noRls = tables.filter((t: any) => !t.rowsecurity);
    // Some test DBs may not have BYPASSRLS privilege, so RLS might be skipped.
    // If RLS was enabled at all (the common case against Docker postgres), EVERY
    // public table must have it — no hardcoded IN-list exceptions.
    if (tables.some((t: any) => t.rowsecurity)) {
      expect(noRls.map((t: any) => t.tablename)).toEqual([]);
    }
  });

  test('current user role has BYPASSRLS', async () => {
    const conn = getConn();
    const rows = await conn.unsafe(`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    if (rows.length > 0) {
      expect(rows[0].rolbypassrls).toBe(true);
    }
  });

  test('gbrain doctor fails with exit 1 when a public table is missing RLS', async () => {
    const conn = getConn();
    const tbl = `gbrain_rls_regression_${suffix}`;
    try {
      await conn.unsafe(`CREATE TABLE public.${tbl} (id int)`);
      // Make sure RLS is actually off; CREATE TABLE default is off but be explicit.
      await conn.unsafe(`ALTER TABLE public.${tbl} DISABLE ROW LEVEL SECURITY`);

      // Init (idempotent) so the CLI has a config to read.
      Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'init', '--non-interactive', '--url', process.env.DATABASE_URL!],
        cwd: cliCwd, env: cliEnv(), timeout: 15_000,
      });
      const result = Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'doctor', '--json'],
        cwd: cliCwd, env: cliEnv(), timeout: 20_000,
      });
      const stdout = new TextDecoder().decode(result.stdout);
      const parsed = JSON.parse(stdout);
      const rls = parsed.checks.find((c: any) => c.name === 'rls');
      expect(rls).toBeDefined();
      expect(rls.status).toBe('fail');
      expect(rls.message).toContain(tbl);
      expect(rls.message).toContain('ALTER TABLE');
      expect(result.exitCode).toBe(1);
    } finally {
      await conn.unsafe(`DROP TABLE IF EXISTS public.${tbl}`);
    }
  }, 60_000);

  test('GBRAIN:RLS_EXEMPT comment with valid reason exempts a non-RLS public table', async () => {
    const conn = getConn();
    const tbl = `gbrain_rls_exempt_ok_${suffix}`;
    try {
      await conn.unsafe(`CREATE TABLE public.${tbl} (id int)`);
      await conn.unsafe(`ALTER TABLE public.${tbl} DISABLE ROW LEVEL SECURITY`);
      await conn.unsafe(`COMMENT ON TABLE public.${tbl} IS 'GBRAIN:RLS_EXEMPT reason=e2e test fixture, anon-readable ok'`);

      Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'init', '--non-interactive', '--url', process.env.DATABASE_URL!],
        cwd: cliCwd, env: cliEnv(), timeout: 15_000,
      });
      const result = Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'doctor', '--json'],
        cwd: cliCwd, env: cliEnv(), timeout: 20_000,
      });
      const stdout = new TextDecoder().decode(result.stdout);
      const parsed = JSON.parse(stdout);
      const rls = parsed.checks.find((c: any) => c.name === 'rls');
      expect(rls.status).toBe('ok');
      expect(rls.message).toContain('explicitly exempt');
      expect(rls.message).toContain(tbl);
    } finally {
      await conn.unsafe(`DROP TABLE IF EXISTS public.${tbl}`);
    }
  }, 60_000);

  test('GBRAIN:RLS_EXEMPT comment WITHOUT reason= still fails doctor', async () => {
    const conn = getConn();
    const tbl = `gbrain_rls_exempt_bad_${suffix}`;
    try {
      await conn.unsafe(`CREATE TABLE public.${tbl} (id int)`);
      await conn.unsafe(`ALTER TABLE public.${tbl} DISABLE ROW LEVEL SECURITY`);
      // Missing the `reason=<...>` segment — prefix alone is not enough.
      await conn.unsafe(`COMMENT ON TABLE public.${tbl} IS 'GBRAIN:RLS_EXEMPT'`);

      Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'init', '--non-interactive', '--url', process.env.DATABASE_URL!],
        cwd: cliCwd, env: cliEnv(), timeout: 15_000,
      });
      const result = Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'doctor', '--json'],
        cwd: cliCwd, env: cliEnv(), timeout: 20_000,
      });
      const stdout = new TextDecoder().decode(result.stdout);
      const parsed = JSON.parse(stdout);
      const rls = parsed.checks.find((c: any) => c.name === 'rls');
      expect(rls.status).toBe('fail');
      expect(rls.message).toContain(tbl);
      expect(result.exitCode).toBe(1);
    } finally {
      await conn.unsafe(`DROP TABLE IF EXISTS public.${tbl}`);
    }
  }, 60_000);

  test('Non-exempt unrelated COMMENT on a no-RLS table still fails doctor', async () => {
    const conn = getConn();
    const tbl = `gbrain_rls_comment_${suffix}`;
    try {
      await conn.unsafe(`CREATE TABLE public.${tbl} (id int)`);
      await conn.unsafe(`ALTER TABLE public.${tbl} DISABLE ROW LEVEL SECURITY`);
      await conn.unsafe(`COMMENT ON TABLE public.${tbl} IS 'Regular docs comment, not an exemption'`);

      Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'init', '--non-interactive', '--url', process.env.DATABASE_URL!],
        cwd: cliCwd, env: cliEnv(), timeout: 15_000,
      });
      const result = Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'doctor', '--json'],
        cwd: cliCwd, env: cliEnv(), timeout: 20_000,
      });
      const stdout = new TextDecoder().decode(result.stdout);
      const parsed = JSON.parse(stdout);
      const rls = parsed.checks.find((c: any) => c.name === 'rls');
      expect(rls.status).toBe('fail');
      expect(result.exitCode).toBe(1);
    } finally {
      await conn.unsafe(`DROP TABLE IF EXISTS public.${tbl}`);
    }
  }, 60_000);

  // Regression test for the v24 self-healing guard. If an operator manually
  // drops budget_ledger and/or budget_reservations (they are migration-only
  // per v12, not in schema.sql, and the data is regenerable from resolver
  // logs — so dropping them is a reasonable cleanup), v24 must NOT fail
  // with 42P01. The information_schema.tables IF EXISTS guards around those
  // two ALTERs let the migration skip them and continue.
  //
  // Without the guard, a brain with dropped budget_* tables would get stuck
  // in an infinite retry loop: v24 fails → transaction rolls back →
  // schema_version stays at prior value → next initSchema re-runs v24 →
  // same failure forever.
  test('v24 self-heals when budget_ledger + budget_reservations are missing', async () => {
    const conn = getConn();
    let priorVersion: string | null = null;
    try {
      // Capture current version so we can restore after the test.
      const verRows = await conn.unsafe(`SELECT value FROM config WHERE key = 'version'`);
      priorVersion = (verRows[0] as any)?.value ?? null;

      // Simulate an operator who dropped the budget_* tables for any reason
      // (cleanup, migration from an older gbrain, etc).
      await conn.unsafe(`DROP TABLE IF EXISTS public.budget_ledger CASCADE`);
      await conn.unsafe(`DROP TABLE IF EXISTS public.budget_reservations CASCADE`);

      // Roll the version back to 23 so v24 re-runs on the next initSchema.
      // UPSERT so this works whether the key exists or not.
      await conn.unsafe(`
        INSERT INTO config (key, value) VALUES ('version', '23')
        ON CONFLICT (key) DO UPDATE SET value = '23'
      `);

      // Re-trigger initSchema via the CLI. With the guard, this should
      // apply v24 cleanly and advance version to 24. Without the guard,
      // this would error out with 42P01 and leave version at 23.
      const result = Bun.spawnSync({
        cmd: ['bun', 'run', 'src/cli.ts', 'init', '--non-interactive', '--url', process.env.DATABASE_URL!],
        cwd: cliCwd, env: cliEnv(), timeout: 30_000,
      });
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);

      // Must succeed — no 42P01, no transaction rollback.
      expect(result.exitCode).toBe(0);
      expect(stderr + stdout).not.toMatch(/42P01|does not exist.*budget/i);

      // Version must have advanced to 24.
      const afterRows = await conn.unsafe(`SELECT value FROM config WHERE key = 'version'`);
      expect((afterRows[0] as any).value).toBe('24');

      // The tables stayed dropped (v12 didn't re-run because current=23 > 12
      // was already true before this test ran). That's intentional — we're
      // proving v24 doesn't require those tables to exist.
      const tblRows = await conn.unsafe(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('budget_ledger', 'budget_reservations')
      `);
      expect(tblRows.length).toBe(0);
    } finally {
      // Restore: recreate the budget_* tables (minimal schema — just enough
      // to keep the rest of the test suite happy) and reset version.
      // Mirror migration v12's CREATE TABLE IF NOT EXISTS exactly so any
      // downstream test that touches these tables sees the original shape.
      await conn.unsafe(`
        CREATE TABLE IF NOT EXISTS budget_ledger (
          scope          TEXT        NOT NULL,
          resolver_id    TEXT        NOT NULL,
          local_date     DATE        NOT NULL,
          reserved_usd   NUMERIC(12,4) NOT NULL DEFAULT 0,
          committed_usd  NUMERIC(12,4) NOT NULL DEFAULT 0,
          cap_usd        NUMERIC(12,4),
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (scope, resolver_id, local_date)
        )
      `);
      await conn.unsafe(`
        CREATE TABLE IF NOT EXISTS budget_reservations (
          reservation_id TEXT        PRIMARY KEY,
          scope          TEXT        NOT NULL,
          resolver_id    TEXT        NOT NULL,
          local_date     DATE        NOT NULL,
          estimate_usd   NUMERIC(12,4) NOT NULL,
          reserved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at     TIMESTAMPTZ NOT NULL,
          status         TEXT        NOT NULL DEFAULT 'held'
        )
      `);
      // Enable RLS on the recreated tables so the "every public table has
      // RLS" assertion earlier in this block stays green if re-run.
      await conn.unsafe(`ALTER TABLE budget_ledger ENABLE ROW LEVEL SECURITY`);
      await conn.unsafe(`ALTER TABLE budget_reservations ENABLE ROW LEVEL SECURITY`);
      // Restore version so we don't leave the DB at a weird state for
      // subsequent test blocks.
      if (priorVersion !== null) {
        await conn.unsafe(
          `UPDATE config SET value = $1 WHERE key = 'version'`,
          [priorVersion],
        );
      }
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────
// Doctor Command
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Doctor Command', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);

  const cliCwd = join(import.meta.dir, '../..');
  const cliEnv = () => ({ ...process.env, DATABASE_URL: process.env.DATABASE_URL!, GBRAIN_DATABASE_URL: process.env.DATABASE_URL! });

  test('gbrain doctor exits 0 on healthy DB', () => {
    // Init first so config exists for CLI
    Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'init', '--non-interactive', '--url', process.env.DATABASE_URL!],
      cwd: cliCwd, env: cliEnv(), timeout: 15_000,
    });
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'doctor'],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
  }, 60_000);

  test('gbrain doctor --json produces valid JSON', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'doctor', '--json'],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 15_000,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBeDefined();
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
    for (const check of parsed.checks) {
      expect(['ok', 'warn', 'fail']).toContain(check.status);
      expect(typeof check.name).toBe('string');
      expect(typeof check.message).toBe('string');
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────
// Parallel Import
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Parallel Import', () => {
  afterAll(teardownDB);

  const cliCwd = join(import.meta.dir, '../..');
  const cliEnv = () => ({ ...process.env, DATABASE_URL: process.env.DATABASE_URL!, GBRAIN_DATABASE_URL: process.env.DATABASE_URL! });

  function initCli() {
    Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'init', '--non-interactive', '--url', process.env.DATABASE_URL!],
      cwd: cliCwd, env: cliEnv(), timeout: 15_000,
    });
  }

  // Store sequential baseline for comparison
  let seqPageCount: number;
  let seqChunkCount: number;
  let seqPageSlugs: string[];

  test('sequential baseline: import all fixtures', async () => {
    await setupDB();
    initCli();
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'import', '--no-embed', FIXTURES_PATH],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 30_000,
    });
    expect(result.exitCode).toBe(0);

    const stats = await callOp('get_stats') as any;
    seqPageCount = stats.page_count;
    seqChunkCount = stats.chunk_count;

    const pages = await callOp('list_pages', { limit: 200 }) as any[];
    seqPageSlugs = pages.map((p: any) => p.slug).sort();

    expect(seqPageCount).toBeGreaterThan(0);
    expect(seqChunkCount).toBeGreaterThan(0);
  }, 60_000);

  test('parallel import with --workers 2 matches sequential page count', async () => {
    await setupDB();
    initCli();
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'import', '--no-embed', '--workers', '2', FIXTURES_PATH],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 30_000,
    });
    expect(result.exitCode).toBe(0);

    const stats = await callOp('get_stats') as any;
    expect(stats.page_count).toBe(seqPageCount);
  }, 60_000);

  test('parallel import has same chunk count (no duplicates)', async () => {
    const stats = await callOp('get_stats') as any;
    expect(stats.chunk_count).toBe(seqChunkCount);
  });

  test('parallel import has same page slugs', async () => {
    const pages = await callOp('list_pages', { limit: 200 }) as any[];
    const parSlugs = pages.map((p: any) => p.slug).sort();
    expect(parSlugs).toEqual(seqPageSlugs);
  });

  test('no duplicate pages from concurrent writes', async () => {
    const conn = getConn();
    const dupes = await conn.unsafe(`
      SELECT slug, count(*) as n FROM pages GROUP BY slug HAVING count(*) > 1
    `);
    expect(dupes.length).toBe(0);
  });

  test('no duplicate chunks from concurrent writes', async () => {
    const conn = getConn();
    const dupes = await conn.unsafe(`
      SELECT page_id, chunk_index, count(*) as n
      FROM content_chunks
      GROUP BY page_id, chunk_index
      HAVING count(*) > 1
    `);
    expect(dupes.length).toBe(0);
  });

  test('parallel import with --workers 4 also works', async () => {
    await setupDB();
    initCli();
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'import', '--no-embed', '--workers', '4', FIXTURES_PATH],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 30_000,
    });
    expect(result.exitCode).toBe(0);

    const stats = await callOp('get_stats') as any;
    expect(stats.page_count).toBe(seqPageCount);
    expect(stats.chunk_count).toBe(seqChunkCount);
  }, 60_000);

  test('re-import with workers is idempotent', async () => {
    // Import again on top of existing data
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'import', '--no-embed', '--workers', '2', FIXTURES_PATH],
      cwd: cliCwd,
      env: cliEnv(),
      timeout: 30_000,
    });
    expect(result.exitCode).toBe(0);

    const stats = await callOp('get_stats') as any;
    expect(stats.page_count).toBe(seqPageCount);
    expect(stats.chunk_count).toBe(seqChunkCount);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────
// Performance Baselines
// ─────────────────────────────────────────────────────────────────

describeE2E('E2E: Performance Baselines', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(teardownDB);

  test('import + search + link performance', async () => {
    const [_, importMs] = await time(importFixtures);

    const searchTimes: number[] = [];
    for (const q of ['NovaMind', 'hybrid search', 'Stanford', 'investor', 'compiled truth']) {
      const [__, ms] = await time(() => callOp('search', { query: q }));
      searchTimes.push(ms);
    }

    const [___, linkMs] = await time(async () => {
      await callOp('add_link', { from: 'people/sarah-chen', to: 'companies/novamind' });
      await callOp('get_backlinks', { slug: 'companies/novamind' });
    });

    searchTimes.sort((a, b) => a - b);
    const p50 = searchTimes[Math.floor(searchTimes.length * 0.5)];
    const p99 = searchTimes[searchTimes.length - 1];

    console.log('\n  Performance Baselines:');
    console.log(`    Import 13 fixtures: ${importMs.toFixed(0)}ms`);
    console.log(`    Search p50: ${p50.toFixed(0)}ms`);
    console.log(`    Search p99: ${p99.toFixed(0)}ms`);
    console.log(`    Link + backlink: ${linkMs.toFixed(0)}ms`);
  });
});
