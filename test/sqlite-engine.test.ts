import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { ChunkInput, PageInput } from '../src/core/types.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let tempDir = '';
let dbPath = '';
let engine: SQLiteEngine;

async function putPage(slug: string, overrides: Partial<PageInput> = {}) {
  return engine.putPage(slug, {
    type: 'person',
    title: slug,
    compiled_truth: `${slug} truth`,
    timeline: `${slug} timeline`,
    frontmatter: { source: 'test' },
    ...overrides,
  });
}

async function putChunks(slug: string, chunks: ChunkInput[]) {
  await engine.upsertChunks(slug, chunks);
  return engine.getChunks(slug);
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'gbrain-sqlite-engine-'));
  dbPath = join(tempDir, 'brain.db');
  engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: dbPath });
  await engine.initSchema();
});

afterEach(async () => {
  await engine.disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SQLiteEngine', () => {
  test('supports page CRUD, chunks, config, slug resolution, and slug updates', async () => {
    const page = await putPage('People/Alice.md', {
      title: 'Alice Example',
      compiled_truth: 'Alice leads product strategy.',
      timeline: '2025: promoted to staff product lead',
    });

    expect(page.slug).toBe('people/alice.md');
    expect((await engine.getPage('people/alice.md'))?.title).toBe('Alice Example');
    expect((await engine.listPages({ type: 'person' })).map(p => p.slug)).toEqual(['people/alice.md']);
    expect(await engine.resolveSlugs('people/alice.md')).toEqual(['people/alice.md']);
    expect(await engine.resolveSlugs('alice')).toContain('people/alice.md');

    await putChunks('people/alice.md', [
      {
        chunk_index: 0,
        chunk_text: 'Alice leads product strategy.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.1, 0.2, 0.3]),
        token_count: 4,
      },
      {
        chunk_index: 1,
        chunk_text: '2025: promoted to staff product lead',
        chunk_source: 'timeline',
      },
    ]);

    const chunks = await engine.getChunks('people/alice.md');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunk_source).toBe('compiled_truth');
    expect(chunks[0].embedded_at).toBeInstanceOf(Date);
    expect(chunks[0].embedding).toBeNull();
    expect(chunks[1].embedded_at).toBeNull();

    await engine.setConfig('sync.repo_path', '/tmp/repo');
    expect(await engine.getConfig('sync.repo_path')).toBe('/tmp/repo');

    await engine.updateSlug('people/alice.md', 'People/Alice-Renamed.md');
    await engine.rewriteLinks('people/alice.md', 'people/alice-renamed.md');

    expect(await engine.getPage('people/alice.md')).toBeNull();
    expect((await engine.getPage('people/alice-renamed.md'))?.title).toBe('Alice Example');
    expect(await engine.resolveSlugs('alice-renamed')).toEqual(['people/alice-renamed.md']);

    await engine.deleteChunks('people/alice-renamed.md');
    expect(await engine.getChunks('people/alice-renamed.md')).toHaveLength(0);

    await engine.deletePage('people/alice-renamed.md');
    expect(await engine.getPage('people/alice-renamed.md')).toBeNull();
  });

  test('supports tags, links, backlinks, and graph traversal across renamed slugs', async () => {
    await putPage('people/alice.md', { title: 'Alice' });
    await putPage('companies/acme.md', { type: 'company', title: 'Acme' });
    await putPage('projects/apollo.md', { type: 'project', title: 'Apollo' });

    await engine.addTag('people/alice.md', 'founder');
    await engine.addTag('people/alice.md', 'operator');
    await engine.addTag('people/alice.md', 'founder');
    expect(await engine.getTags('people/alice.md')).toEqual(['founder', 'operator']);
    expect((await engine.listPages({ tag: 'founder' })).map(p => p.slug)).toEqual(['people/alice.md']);

    await engine.addLink('people/alice.md', 'companies/acme.md', 'founded company', 'founder_of');
    await engine.addLink('companies/acme.md', 'projects/apollo.md', 'incubated project', 'incubates');

    expect(await engine.getLinks('people/alice.md')).toEqual([
      {
        from_slug: 'people/alice.md',
        to_slug: 'companies/acme.md',
        link_type: 'founder_of',
        context: 'founded company',
      },
    ]);
    expect(await engine.getBacklinks('companies/acme.md')).toEqual([
      {
        from_slug: 'people/alice.md',
        to_slug: 'companies/acme.md',
        link_type: 'founder_of',
        context: 'founded company',
      },
    ]);

    await engine.updateSlug('companies/acme.md', 'companies/acme-ai.md');
    await engine.rewriteLinks('companies/acme.md', 'companies/acme-ai.md');

    expect((await engine.getLinks('people/alice.md'))[0]?.to_slug).toBe('companies/acme-ai.md');

    const graph = await engine.traverseGraph('people/alice.md', 2);
    expect(graph).toEqual([
      {
        slug: 'people/alice.md',
        title: 'Alice',
        type: 'person',
        depth: 0,
        links: [{ to_slug: 'companies/acme-ai.md', link_type: 'founder_of' }],
      },
      {
        slug: 'companies/acme-ai.md',
        title: 'Acme',
        type: 'company',
        depth: 1,
        links: [{ to_slug: 'projects/apollo.md', link_type: 'incubates' }],
      },
      {
        slug: 'projects/apollo.md',
        title: 'Apollo',
        type: 'project',
        depth: 2,
        links: [],
      },
    ]);

    await engine.removeLink('people/alice.md', 'companies/acme-ai.md');
    expect(await engine.getLinks('people/alice.md')).toEqual([]);

    await engine.removeTag('people/alice.md', 'operator');
    expect(await engine.getTags('people/alice.md')).toEqual(['founder']);
  });

  test('supports timeline entries, versions, raw data, ingest log, and vector placeholder behavior', async () => {
    await putPage('people/alice.md', {
      title: 'Alice',
      compiled_truth: 'Version 2',
      frontmatter: { role: 'operator' },
    });

    await delay(10);
    await engine.addTimelineEntry('people/alice.md', {
      date: '2024-01-01',
      source: 'news',
      summary: 'Joined Acme',
      detail: 'Joined as COO',
    });
    await delay(10);
    await engine.addTimelineEntry('people/alice.md', {
      date: '2025-03-10',
      source: 'press',
      summary: 'Promoted',
      detail: 'Promoted to CEO',
    });

    expect((await engine.getTimeline('people/alice.md')).map(entry => entry.summary)).toEqual(['Promoted', 'Joined Acme']);
    expect((await engine.getTimeline('people/alice.md', { after: '2025-01-01' })).map(entry => entry.summary)).toEqual(['Promoted']);

    await engine.putRawData('people/alice.md', 'linkedin', { headline: 'CEO at Acme' });
    await engine.putRawData('people/alice.md', 'linkedin', { headline: 'CEO + board member' });
    expect(await engine.getRawData('people/alice.md', 'linkedin')).toHaveLength(1);
    expect((await engine.getRawData('people/alice.md', 'linkedin'))[0]?.data).toEqual({ headline: 'CEO + board member' });

    const version = await engine.createVersion('people/alice.md');
    await engine.putPage('people/alice.md', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Version 3',
      frontmatter: { role: 'ceo' },
    });

    const versions = await engine.getVersions('people/alice.md');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.id).toBe(version.id);
    expect(versions[0]?.compiled_truth).toBe('Version 2');

    await engine.revertToVersion('people/alice.md', version.id);
    const reverted = await engine.getPage('people/alice.md');
    expect(reverted?.compiled_truth).toBe('Version 2');
    expect(reverted?.frontmatter).toEqual({ role: 'operator' });

    await engine.logIngest({
      source_type: 'git_sync',
      source_ref: '/repo@abc123',
      pages_updated: ['people/alice.md'],
      summary: 'Synced Alice page',
    });
    const ingest = await engine.getIngestLog({ limit: 5 });
    expect(ingest).toHaveLength(1);
    expect(ingest[0]?.pages_updated).toEqual(['people/alice.md']);

    expect(await engine.searchVector(new Float32Array([0.1, 0.2, 0.3]))).toEqual([]);
  });

  test('reports stats and health for SQLite data', async () => {
    await putPage('people/alice.md', { title: 'Alice' });
    await putPage('companies/acme.md', { type: 'company', title: 'Acme' });

    await engine.addTag('people/alice.md', 'founder');
    await engine.addTag('companies/acme.md', 'portfolio');
    await engine.addLink('people/alice.md', 'companies/acme.md', 'founded', 'founder_of');
    await delay(10);
    await engine.addTimelineEntry('people/alice.md', {
      date: '2024-01-01',
      summary: 'Founded Acme',
      detail: 'Company launch',
    });

    await putChunks('people/alice.md', [
      {
        chunk_index: 0,
        chunk_text: 'Alice founded Acme.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array([0.1, 0.2]),
      },
      {
        chunk_index: 1,
        chunk_text: '2024: founded Acme.',
        chunk_source: 'timeline',
      },
    ]);

    const stats = await engine.getStats();
    expect(stats).toEqual({
      page_count: 2,
      chunk_count: 2,
      embedded_count: 1,
      link_count: 1,
      tag_count: 2,
      timeline_entry_count: 1,
      pages_by_type: { company: 1, person: 1 },
    });

    const health = await engine.getHealth();
    expect(health.page_count).toBe(2);
    expect(health.embed_coverage).toBeCloseTo(0.5, 5);
    expect(health.stale_pages).toBe(1);
    expect(health.orphan_pages).toBe(1);
    expect(health.dead_links).toBe(0);
    expect(health.missing_embeddings).toBe(1);
  });

  test('supports FTS keyword search with normalized SearchResult rows', async () => {
    await putPage('people/alice.md', {
      title: 'Alice Neural',
      compiled_truth: 'Alice works on neural retrieval systems.',
      timeline: '2025: shipped offline keyword search',
    });
    await putPage('projects/apollo.md', {
      type: 'project',
      title: 'Apollo',
      compiled_truth: 'Apollo focuses on analytics dashboards.',
      timeline: '2024: launched beta',
    });

    const results = await engine.searchKeyword('neural retrieval', { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: 'people/alice.md',
      title: 'Alice Neural',
      type: 'person',
      chunk_source: 'compiled_truth',
      stale: false,
    });
    expect(results[0]!.chunk_text).toContain('neural retrieval');
    expect(results[0]!.score).toBeGreaterThanOrEqual(0);

    expect(await engine.searchKeyword('keyword', { type: 'project' })).toEqual([]);
    expect(await engine.searchKeyword('keyword', { type: 'person', exclude_slugs: ['people/alice.md'] })).toEqual([]);
  });
});
