/** Legacy orphan pages must not poison a brain-wide link drain (#6808).
 * The FK is removed only in this isolated fixture to model the reported legacy state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB, runExtract } from '../src/commands/extract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) {
  describe(`missing source link extraction (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') {
        const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = fixture.engine;
        close = fixture.close;
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.executeRaw('ALTER TABLE pages DROP CONSTRAINT pages_source_id_fkey');
      await engine.setConfig('mentions.auto_link', 'false');
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.setConfig('link_resolution.cross_source', 'false');
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('missing','Missing'),('healthy','Healthy')");
      for (const sourceId of ['missing', 'healthy']) {
        for (const [slug, body] of [['notes/a', 'See [[notes/b]].'], ['notes/b', 'Target.']]) {
          await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body }, { sourceId });
        }
      }
      await engine.executeRaw("DELETE FROM sources WHERE id='missing'");
    });

    async function edges() {
      return engine.executeRaw<{ source_id: string; from_slug: string; to_slug: string }>(`SELECT f.source_id,f.slug from_slug,t.slug to_slug
        FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id ORDER BY f.source_id,f.slug,t.slug`);
    }

    test('brain-wide DB links replays a failed batch and counts orphan pages while healthy pages publish', async () => {
      // Cross the 100-page publication boundary: later batches must run too.
      for (let i = 0; i < 105; i++) await engine.putPage(`notes/tail-${i}`, { type: 'note', title: 'Tail', compiled_truth: 'No links.' }, { sourceId: 'healthy' });
      const log = spyOn(console, 'log').mockImplementation(() => {});
      const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('Unexpected CLI exit'); });
      try {
        await runExtract(engine, ['links', '--source', 'db', '--json']);
        const summary = JSON.parse(String(log.mock.calls.at(-1)![0]));
        expect(summary.skipped_unknown_source).toBe(2);
        expect(summary.unknown_source_pages).toEqual([
          { slug: 'notes/a', source_id: 'missing', missing_source: 'missing' },
          { slug: 'notes/b', source_id: 'missing', missing_source: 'missing' },
        ]);
        expect(summary.pages_processed).toBe(107);
        expect(summary.links_created).toBe(1);
        expect(await edges()).toEqual([{ source_id: 'healthy', from_slug: 'notes/a', to_slug: 'notes/b' }]);
        // Retry does not create duplicates or declare the orphan pages processed.
        await runExtract(engine, ['links', '--source', 'db', '--json']);
        expect(JSON.parse(String(log.mock.calls.at(-1)![0])).skipped_unknown_source).toBe(2);
        expect(await edges()).toHaveLength(1);
      } finally { exit.mockRestore(); log.mockRestore(); }
    });

    test('stale extraction continues without stamping the orphan pages fresh', async () => {
      const result = await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });
      expect(result).toMatchObject({ skippedUnknownSource: 2, pagesProcessed: 2, staleRemaining: 2 });
      expect(await edges()).toEqual([{ source_id: 'healthy', from_slug: 'notes/a', to_slug: 'notes/b' }]);
      const orphan = await engine.executeRaw<{ links_extracted_at: unknown }>("SELECT links_extracted_at FROM pages WHERE source_id='missing'");
      expect(orphan).toHaveLength(2);
      expect(orphan.every(row => row.links_extracted_at === null)).toBe(true);
    });

    test('an unrelated error with similar text is still fatal', async () => {
      const original = engine.replaceDerivedLinks;
      engine.replaceDerivedLinks = async function () { throw new Error('Page source does not exist: injected storage failure'); };
      try {
        await expect(extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true }))
          .rejects.toThrow('injected storage failure');
      } finally { engine.replaceDerivedLinks = original; }
    });

    test('a missing target source preserves the healthy origin\'s prior projection and watermark', async () => {
      await engine.setConfig('link_resolution.cross_source', 'true');
      await engine.putPage('notes/a', { type: 'note', title: 'Origin', compiled_truth: 'See [[missing:notes/b]].' }, { sourceId: 'healthy' });
      await engine.addLinksBatch([{ from_slug: 'notes/a', to_slug: 'notes/b', from_source_id: 'healthy', to_source_id: 'healthy',
        link_type: 'mentions', link_source: 'markdown' }]);
      const before = await engine.executeRaw('SELECT * FROM links ORDER BY id');
      const result = await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });
      expect(result).toMatchObject({ skippedUnknownSource: 3, pagesProcessed: 1, staleRemaining: 3 });
      expect(await engine.executeRaw('SELECT * FROM links ORDER BY id')).toEqual(before);
      const [page] = await engine.executeRaw<{ links_extracted_at: unknown }>("SELECT links_extracted_at FROM pages WHERE source_id='healthy' AND slug='notes/a'");
      expect(page!.links_extracted_at).toBeNull();
    });
  });
}
