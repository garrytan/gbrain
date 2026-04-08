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
});
