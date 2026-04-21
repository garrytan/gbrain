/**
 * SQLite E2E tests for the local-file SqliteEngine backend.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SqliteEngine } from '../../src/core/sqlite-engine.ts';

let engine: SqliteEngine;
let tempDir: string;
let dbPath: string;

async function resetTables() {
  const tables = [
    'content_chunks',
    'links',
    'tags',
    'raw_data',
    'timeline_entries',
    'page_versions',
    'ingest_log',
    'pages',
  ];
  for (const table of tables) {
    await engine.executeRaw(`DELETE FROM ${table}`);
  }
}

describe('E2E: SqliteEngine', () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'gbrain-sqlite-e2e-'));
    dbPath = join(tempDir, 'brain.sqlite');
    engine = new SqliteEngine();
    await engine.connect({ engine: 'sqlite', database_path: dbPath });
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTables();
  });

  test('page CRUD + chunks + keyword search', async () => {
    await engine.putPage('people/sarah-chen', {
      type: 'person',
      title: 'Sarah Chen',
      compiled_truth: 'Sarah founded NovaMind and focuses on AI infrastructure.',
      timeline: '2025-01-01: Founded NovaMind',
      frontmatter: { tags: ['founder'] },
    });

    await engine.upsertChunks('people/sarah-chen', [
      {
        chunk_index: 0,
        chunk_text: 'Sarah founded NovaMind and focuses on AI infrastructure.',
        chunk_source: 'compiled_truth',
      },
    ]);

    const page = await engine.getPage('people/sarah-chen');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Sarah Chen');

    const chunks = await engine.getChunks('people/sarah-chen');
    expect(chunks.length).toBe(1);

    const results = await engine.searchKeyword('NovaMind');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('people/sarah-chen');
  });

  test('links + tags + timeline + raw_data + versions', async () => {
    await engine.putPage('people/sarah-chen', {
      type: 'person',
      title: 'Sarah Chen',
      compiled_truth: 'Founder profile.',
    });
    await engine.putPage('companies/novamind', {
      type: 'company',
      title: 'NovaMind',
      compiled_truth: 'AI infra startup.',
    });

    await engine.addLink('people/sarah-chen', 'companies/novamind', 'founded company', 'founded');
    const links = await engine.getLinks('people/sarah-chen');
    expect(links.some(l => l.to_slug === 'companies/novamind')).toBe(true);

    await engine.addTag('people/sarah-chen', 'founder');
    const tags = await engine.getTags('people/sarah-chen');
    expect(tags).toContain('founder');

    await engine.addTimelineEntry('people/sarah-chen', {
      date: '2025-01-01',
      summary: 'Founded NovaMind',
      source: 'test',
      detail: 'E2E timeline entry',
    });
    const timeline = await engine.getTimeline('people/sarah-chen');
    expect(timeline.length).toBeGreaterThan(0);

    await engine.putRawData('people/sarah-chen', 'crustdata', { employees: 12 });
    const raw = await engine.getRawData('people/sarah-chen');
    expect(raw.length).toBe(1);
    expect(raw[0].data.employees).toBe(12);

    await engine.createVersion('people/sarah-chen');
    const versions = await engine.getVersions('people/sarah-chen');
    expect(versions.length).toBeGreaterThan(0);
  });

  test('stats + health + vector-search guardrail', async () => {
    await engine.putPage('concepts/hybrid-search', {
      type: 'concept',
      title: 'Hybrid Search',
      compiled_truth: 'Combines keyword and vector retrieval.',
    });

    const stats = await engine.getStats();
    expect(stats.page_count).toBe(1);

    const health = await engine.getHealth();
    expect(typeof health.page_count).toBe('number');
    expect(typeof health.embed_coverage).toBe('number');

    await expect(
      engine.searchVector(new Float32Array(1536)),
    ).rejects.toThrow(/SQLite vector search is unavailable/);
  });

  test('getChunksWithEmbeddings decodes sqlite blob embeddings', async () => {
    await engine.putPage('people/embed-roundtrip', {
      type: 'person',
      title: 'Embed Roundtrip',
      compiled_truth: 'Roundtrip test',
    });

    await engine.upsertChunks('people/embed-roundtrip', [
      {
        chunk_index: 0,
        chunk_text: 'Embedding payload',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      },
    ]);

    const chunks = await engine.getChunksWithEmbeddings('people/embed-roundtrip');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].embedding).toBeInstanceOf(Float32Array);
    expect(chunks[0].embedding).not.toBeNull();
    expect(chunks[0].embedding?.[0]).toBeCloseTo(0.1, 6);
    expect(chunks[0].embedding?.[1]).toBeCloseTo(0.2, 6);
    expect(chunks[0].embedding?.[2]).toBeCloseTo(0.3, 6);
  });

  test('addLinksBatch returns per-statement changes count', async () => {
    await engine.putPage('people/a', {
      type: 'person',
      title: 'A',
      compiled_truth: 'A',
    });
    await engine.putPage('people/b', {
      type: 'person',
      title: 'B',
      compiled_truth: 'B',
    });
    await engine.putPage('people/c', {
      type: 'person',
      title: 'C',
      compiled_truth: 'C',
    });
    await engine.putPage('people/d', {
      type: 'person',
      title: 'D',
      compiled_truth: 'D',
    });
    await engine.putPage('people/e', {
      type: 'person',
      title: 'E',
      compiled_truth: 'E',
    });

    const first = await engine.addLinksBatch([
      { from_slug: 'people/a', to_slug: 'people/b' },
      { from_slug: 'people/a', to_slug: 'people/c' },
      { from_slug: 'people/a', to_slug: 'people/d' },
    ]);
    expect(first).toBe(3);

    const second = await engine.addLinksBatch([
      { from_slug: 'people/a', to_slug: 'people/b' }, // conflict
      { from_slug: 'people/a', to_slug: 'people/e' },
      { from_slug: 'people/b', to_slug: 'people/c' },
    ]);
    expect(second).toBe(2);
  });
});
