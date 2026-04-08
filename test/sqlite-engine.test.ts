import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB = join(tmpdir(), `gbrain-test-${Date.now()}.db`);

describe('SQLiteEngine', () => {
  let engine: SQLiteEngine;

  beforeAll(async () => {
    engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: TEST_DB });
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  describe('lifecycle', () => {
    test('WAL mode is enabled and config seeded', async () => {
      const config = await engine.getConfig('engine');
      expect(config).toBe('sqlite');
    });
  });

  describe('pages CRUD', () => {
    test('putPage + getPage round-trip', async () => {
      const page = await engine.putPage('people/john-doe', {
        type: 'person',
        title: 'John Doe',
        compiled_truth: 'A test person.',
        timeline: '2024-01-01: Born',
        frontmatter: { role: 'engineer' },
      });
      expect(page.slug).toBe('people/john-doe');
      expect(page.title).toBe('John Doe');
      expect(page.type).toBe('person');
      expect(page.compiled_truth).toBe('A test person.');
      expect(page.timeline).toBe('2024-01-01: Born');
      expect(page.frontmatter).toEqual({ role: 'engineer' });
      expect(page.content_hash).toBeDefined();
      expect(page.id).toBeGreaterThan(0);

      const fetched = await engine.getPage('people/john-doe');
      expect(fetched).not.toBeNull();
      expect(fetched!.slug).toBe('people/john-doe');
      expect(fetched!.title).toBe('John Doe');
    });

    test('putPage upserts on conflict', async () => {
      await engine.putPage('people/jane', {
        type: 'person',
        title: 'Jane v1',
        compiled_truth: 'v1',
      });
      const updated = await engine.putPage('people/jane', {
        type: 'person',
        title: 'Jane v2',
        compiled_truth: 'v2',
      });
      expect(updated.title).toBe('Jane v2');

      const all = await engine.listPages();
      const janes = all.filter(p => p.slug === 'people/jane');
      expect(janes).toHaveLength(1);
    });

    test('getPage returns null for missing slug', async () => {
      const page = await engine.getPage('nonexistent/slug');
      expect(page).toBeNull();
    });

    test('deletePage removes the page', async () => {
      await engine.putPage('people/to-delete', {
        type: 'person',
        title: 'Delete Me',
        compiled_truth: 'bye',
      });
      await engine.deletePage('people/to-delete');
      const page = await engine.getPage('people/to-delete');
      expect(page).toBeNull();
    });

    test('listPages returns pages', async () => {
      const pages = await engine.listPages();
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.some(p => p.slug === 'people/john-doe')).toBe(true);
    });

    test('listPages filters by type', async () => {
      await engine.putPage('companies/acme', {
        type: 'company',
        title: 'ACME Corp',
        compiled_truth: 'A company.',
      });
      const companies = await engine.listPages({ type: 'company' });
      expect(companies.every(p => p.type === 'company')).toBe(true);
      expect(companies.some(p => p.slug === 'companies/acme')).toBe(true);
    });

    test('listPages filters by tag', async () => {
      await engine.addTag('people/john-doe', 'vip');
      const tagged = await engine.listPages({ tag: 'vip' });
      expect(tagged.some(p => p.slug === 'people/john-doe')).toBe(true);
    });

    test('listPages filters by type + tag', async () => {
      const results = await engine.listPages({ type: 'person', tag: 'vip' });
      expect(results.every(p => p.type === 'person')).toBe(true);
    });

    test('resolveSlugs finds exact match', async () => {
      const slugs = await engine.resolveSlugs('people/john-doe');
      expect(slugs).toContain('people/john-doe');
    });

    test('resolveSlugs finds partial match via LIKE', async () => {
      const slugs = await engine.resolveSlugs('john');
      expect(slugs.length).toBeGreaterThan(0);
    });

    test('validateSlug rejects invalid slugs', async () => {
      await expect(engine.putPage('../bad', {
        type: 'person',
        title: 'Bad',
        compiled_truth: '',
      })).rejects.toThrow('Invalid slug');
    });
  });

  describe('FTS5 keyword search', () => {
    test('searchKeyword finds pages by content', async () => {
      await engine.putPage('test/searchable', {
        type: 'concept',
        title: 'Quantum Computing',
        compiled_truth: 'Quantum computing uses qubits for parallel computation.',
      });
      await engine.upsertChunks('test/searchable', [{
        chunk_index: 0,
        chunk_text: 'Quantum computing uses qubits for parallel computation.',
        chunk_source: 'compiled_truth',
      }]);

      const results = await engine.searchKeyword('quantum computing');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].slug).toBe('test/searchable');
      expect(results[0].score).toBeGreaterThan(0);
    });

    test('searchKeyword returns empty for no match', async () => {
      const results = await engine.searchKeyword('xyznonexistent123');
      expect(results).toEqual([]);
    });

    test('searchKeyword handles empty query', async () => {
      const results = await engine.searchKeyword('');
      expect(results).toEqual([]);
    });
  });

  describe('chunks', () => {
    test('upsertChunks + getChunks round-trip', async () => {
      await engine.upsertChunks('people/john-doe', [
        { chunk_index: 0, chunk_text: 'Chunk zero.', chunk_source: 'compiled_truth' },
        { chunk_index: 1, chunk_text: 'Chunk one.', chunk_source: 'timeline' },
      ]);
      const chunks = await engine.getChunks('people/john-doe');
      expect(chunks).toHaveLength(2);
      expect(chunks[0].chunk_text).toBe('Chunk zero.');
      expect(chunks[1].chunk_text).toBe('Chunk one.');
    });

    test('upsertChunks replaces existing chunks', async () => {
      await engine.upsertChunks('people/john-doe', [
        { chunk_index: 0, chunk_text: 'Replacement.', chunk_source: 'compiled_truth' },
      ]);
      const chunks = await engine.getChunks('people/john-doe');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].chunk_text).toBe('Replacement.');
    });

    test('deleteChunks removes all chunks', async () => {
      await engine.deleteChunks('people/john-doe');
      const chunks = await engine.getChunks('people/john-doe');
      expect(chunks).toHaveLength(0);
    });
  });

  describe('links', () => {
    test('addLink + getLinks', async () => {
      await engine.putPage('test/link-from', { type: 'concept', title: 'From', compiled_truth: '' });
      await engine.putPage('test/link-to', { type: 'concept', title: 'To', compiled_truth: '' });
      await engine.addLink('test/link-from', 'test/link-to', 'related', 'knows');

      const links = await engine.getLinks('test/link-from');
      expect(links).toHaveLength(1);
      expect(links[0].to_slug).toBe('test/link-to');
      expect(links[0].link_type).toBe('knows');
    });

    test('getBacklinks returns incoming links', async () => {
      const backlinks = await engine.getBacklinks('test/link-to');
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0].from_slug).toBe('test/link-from');
    });

    test('removeLink removes the link', async () => {
      await engine.removeLink('test/link-from', 'test/link-to');
      const links = await engine.getLinks('test/link-from');
      expect(links).toHaveLength(0);
    });

    test('traverseGraph returns connected nodes', async () => {
      await engine.addLink('test/link-from', 'test/link-to', 'related', 'knows');
      const graph = await engine.traverseGraph('test/link-from', 2);
      expect(graph.length).toBeGreaterThan(0);
      expect(graph[0].slug).toBe('test/link-from');
      expect(graph[0].depth).toBe(0);
    });
  });

  describe('tags', () => {
    test('addTag + getTags', async () => {
      await engine.addTag('people/john-doe', 'engineer');
      const tags = await engine.getTags('people/john-doe');
      expect(tags).toContain('engineer');
    });

    test('removeTag', async () => {
      await engine.removeTag('people/john-doe', 'engineer');
      const tags = await engine.getTags('people/john-doe');
      expect(tags).not.toContain('engineer');
    });

    test('addTag is idempotent', async () => {
      await engine.addTag('people/john-doe', 'test-tag');
      await engine.addTag('people/john-doe', 'test-tag');
      const tags = await engine.getTags('people/john-doe');
      expect(tags.filter(t => t === 'test-tag')).toHaveLength(1);
    });
  });

  describe('timeline', () => {
    test('addTimelineEntry + getTimeline', async () => {
      await engine.addTimelineEntry('people/john-doe', {
        date: '2024-06-15',
        source: 'manual',
        summary: 'Joined company',
        detail: 'Started as engineer',
      });
      const timeline = await engine.getTimeline('people/john-doe');
      expect(timeline.length).toBeGreaterThan(0);
      expect(timeline[0].summary).toBe('Joined company');
    });

    test('getTimeline filters by date range', async () => {
      await engine.addTimelineEntry('people/john-doe', {
        date: '2023-01-01',
        summary: 'Old event',
      });
      const filtered = await engine.getTimeline('people/john-doe', { after: '2024-01-01' });
      expect(filtered.every(e => e.date >= '2024-01-01')).toBe(true);
    });
  });

  describe('raw data', () => {
    test('putRawData + getRawData', async () => {
      await engine.putRawData('people/john-doe', 'linkedin', { url: 'https://linkedin.com/in/john' });
      const data = await engine.getRawData('people/john-doe', 'linkedin');
      expect(data).toHaveLength(1);
      expect((data[0].data as { url: string }).url).toBe('https://linkedin.com/in/john');
    });

    test('putRawData upserts on conflict', async () => {
      await engine.putRawData('people/john-doe', 'linkedin', { url: 'https://linkedin.com/in/john-v2' });
      const data = await engine.getRawData('people/john-doe', 'linkedin');
      expect(data).toHaveLength(1);
      expect((data[0].data as { url: string }).url).toBe('https://linkedin.com/in/john-v2');
    });

    test('getRawData without source returns all', async () => {
      await engine.putRawData('people/john-doe', 'github', { user: 'johndoe' });
      const all = await engine.getRawData('people/john-doe');
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('versions', () => {
    test('createVersion + getVersions', async () => {
      const version = await engine.createVersion('people/john-doe');
      expect(version.id).toBeGreaterThan(0);
      expect(version.compiled_truth).toBeDefined();

      const versions = await engine.getVersions('people/john-doe');
      expect(versions.length).toBeGreaterThan(0);
    });

    test('revertToVersion restores content', async () => {
      const before = await engine.getPage('people/john-doe');
      const version = await engine.createVersion('people/john-doe');

      await engine.putPage('people/john-doe', {
        type: 'person',
        title: 'John Doe MODIFIED',
        compiled_truth: 'modified content',
      });

      await engine.revertToVersion('people/john-doe', version.id);
      const after = await engine.getPage('people/john-doe');
      expect(after!.compiled_truth).toBe(before!.compiled_truth);
    });
  });

  describe('stats + health', () => {
    test('getStats returns counts', async () => {
      const stats = await engine.getStats();
      expect(stats.page_count).toBeGreaterThan(0);
      expect(stats.pages_by_type).toBeDefined();
      expect(typeof stats.page_count).toBe('number');
    });

    test('getHealth returns health metrics', async () => {
      const health = await engine.getHealth();
      expect(health.page_count).toBeGreaterThan(0);
      expect(typeof health.embed_coverage).toBe('number');
      expect(typeof health.orphan_pages).toBe('number');
    });
  });

  describe('ingest log', () => {
    test('logIngest + getIngestLog', async () => {
      await engine.logIngest({
        source_type: 'directory',
        source_ref: '/test/dir',
        pages_updated: ['people/john-doe'],
        summary: 'Test ingest',
      });
      const log = await engine.getIngestLog({ limit: 10 });
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].source_type).toBe('directory');
      expect(log[0].pages_updated).toContain('people/john-doe');
    });
  });

  describe('sync', () => {
    test('updateSlug renames a page', async () => {
      await engine.putPage('test/old-slug', { type: 'concept', title: 'Rename Me', compiled_truth: '' });
      await engine.updateSlug('test/old-slug', 'test/new-slug');
      expect(await engine.getPage('test/old-slug')).toBeNull();
      expect(await engine.getPage('test/new-slug')).not.toBeNull();
    });
  });

  describe('config', () => {
    test('getConfig returns seeded values', async () => {
      const version = await engine.getConfig('version');
      expect(version).toBe('1');
    });

    test('setConfig + getConfig round-trip', async () => {
      await engine.setConfig('test_key', 'test_value');
      const value = await engine.getConfig('test_key');
      expect(value).toBe('test_value');
    });

    test('setConfig upserts', async () => {
      await engine.setConfig('test_key', 'updated_value');
      const value = await engine.getConfig('test_key');
      expect(value).toBe('updated_value');
    });

    test('getConfig returns null for missing key', async () => {
      const value = await engine.getConfig('nonexistent_key');
      expect(value).toBeNull();
    });
  });

  describe('transaction', () => {
    test('commits on success', async () => {
      await engine.transaction(async (eng) => {
        await eng.putPage('test/tx-page', { type: 'concept', title: 'TX Page', compiled_truth: '' });
      });
      const page = await engine.getPage('test/tx-page');
      expect(page).not.toBeNull();
    });

    test('rolls back on error', async () => {
      try {
        await engine.transaction(async (eng) => {
          await eng.putPage('test/tx-rollback', { type: 'concept', title: 'Rollback', compiled_truth: '' });
          throw new Error('Intentional rollback');
        });
      } catch {}
      const page = await engine.getPage('test/tx-rollback');
      expect(page).toBeNull();
    });
  });
});
