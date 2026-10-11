import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine, LinkBatchInput } from '../src/core/engine.ts';
import type { DerivedLinkOrigin, DerivedLinkReplacementOptions } from '../src/core/derived-links.ts';
import { DerivedLinkEndpointChangedError, DerivedLinkSettingsChangedError, replaceDerivedLinksBatchOrReplay } from '../src/core/derived-links.ts';
import { PageRevisionConflictError, RevisionBackfillPendingError } from '../src/core/page-state/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract, extractStaleFromDB } from '../src/commands/extract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const sourceId = 'revision-origin';
const otherSourceId = 'revision-target';
const originSlug = 'meetings/weekly';
const targetSlug = 'people/alice-example';

for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) {
  describe(`DB extraction endpoint fences (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    beforeEach(async () => {
      for (const source of [sourceId, otherSourceId]) {
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [source]);
      }
      await engine.setConfig('link_resolution.cross_source', 'true');
    });
    afterAll(async () => { await close?.(); });

    async function graph() {
      return engine.executeRaw<{ id: number; link_type: string; link_source: string; peer_source: string }>(
        `SELECT l.id,l.link_type,l.link_source,CASE WHEN f.source_id=$1 AND f.slug=$2 THEN t.source_id ELSE f.source_id END AS peer_source
         FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
         WHERE (f.source_id=$1 AND f.slug=$2) OR (t.source_id=$1 AND t.slug=$2) ORDER BY l.id`, [sourceId, originSlug]);
    }
    async function stamp() {
      const rows = await engine.executeRaw<{ links_extracted_at: string | null }>(
        'SELECT links_extracted_at FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, originSlug]);
      return rows[0].links_extracted_at;
    }

    for (const mode of ['links', 'all', 'stale']) {
      for (const qualified of [false, true]) {
        test(`${mode}: ${qualified ? 'qualified foreign' : 'local'} target retyping rejects stale typing and preserves graph/freshness`, async () => {
          const targetSourceId = qualified ? otherSourceId : sourceId;
          const duplicateSourceId = qualified ? sourceId : otherSourceId;
          await engine.putPage(targetSlug, { type: 'person', title: 'Alice Example', compiled_truth: 'A person.' }, { sourceId: targetSourceId });
          await engine.putPage(targetSlug, { type: 'company', title: 'Company Example', compiled_truth: 'An unrelated duplicate slug.' }, { sourceId: duplicateSourceId });
          const target = qualified ? `${otherSourceId}:${targetSlug}` : targetSlug;
          await engine.putPage(originSlug, { type: 'meeting', title: 'Weekly Meeting', compiled_truth: `Attendees: [[${target}]].` }, { sourceId });
          await engine.addLink(originSlug, targetSlug, 'Manual evidence', 'mentions', 'manual', undefined, undefined,
            { fromSourceId: sourceId, toSourceId: targetSourceId });
          const run = () => mode === 'stale'
            ? extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, sourceIdFilter: sourceId,
              includeFrontmatter: false, catchUp: false })
            : runExtract(engine, [mode, '--source', 'db', '--source-id', sourceId, '--json']);
          await run();
          const before = await graph();
          expect(before.filter(row => row.link_source === 'markdown').map(row => [row.link_type, row.peer_source]))
            .toEqual([['attended', targetSourceId]]);
          await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1 AND slug=$2', [sourceId, originSlug]);
          const targetSnapshot = (await engine.readPageSnapshot(targetSlug, { sourceId: targetSourceId }))!;
          const original = engine.replaceDerivedLinks;
          const originalBatch = engine.replaceDerivedLinksBatch;
          let retyped = false;
          let captured: LinkBatchInput[] = [];
          let fences: DerivedLinkReplacementOptions['expectedEndpoints'];
          const retypeBeforePublishing = async (origin: DerivedLinkOrigin, links: LinkBatchInput[], opts?: DerivedLinkReplacementOptions) => {
            if (!retyped && origin.sourceId === sourceId && origin.slug === originSlug) {
              retyped = true;
              captured = links;
              fences = opts?.expectedEndpoints;
              await engine.putPage(targetSlug, { type: 'decision', title: 'Decision Example', compiled_truth: 'Retyped after inference.' }, { sourceId: targetSourceId });
            }
          };
          engine.replaceDerivedLinks = async (origin, links, opts) => {
            await retypeBeforePublishing(origin, links, opts);
            return original.call(engine, origin, links, opts);
          };
          engine.replaceDerivedLinksBatch = async items => {
            for (const item of items) await retypeBeforePublishing(item.origin, item.links, item.opts);
            return originalBatch.call(engine, items);
          };
          const errors: string[] = [];
          const errorSpy = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
          const exitSpy = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`extract exited ${code}`); });
          try {
            // #6272: the run defers the conflicted origin (unstamped, graph untouched) instead of aborting.
            await run();
            expect(exitSpy).not.toHaveBeenCalled();
            expect(errors).not.toContain('A derived link endpoint changed after type resolution');
          } finally {
            engine.replaceDerivedLinks = original;
            engine.replaceDerivedLinksBatch = originalBatch;
            errorSpy.mockRestore();
            exitSpy.mockRestore();
          }
          expect(retyped).toBe(true);
          expect(captured.some(link => link.link_type === 'attended' && link.from_slug === targetSlug && link.from_source_id === targetSourceId)).toBe(true);
          expect(fences).toContainEqual({ slug: targetSlug, sourceId: targetSourceId, revision: targetSnapshot.revision });
          expect(await graph()).toEqual(before);
          expect(await stamp()).toBeNull();
          expect((await engine.readPageSnapshot(targetSlug, { sourceId: targetSourceId }))!.page.type).toBe('decision');
          await run();
          expect((await graph()).filter(row => row.link_source === 'markdown').map(row => row.link_type)).toEqual(['mentions']);
          expect((await graph()).filter(row => row.link_source === 'manual')).toEqual(before.filter(row => row.link_source === 'manual'));
          if (mode === 'links') expect(await stamp()).toBeNull();
          else expect(await stamp()).not.toBeNull();
        });
      }
    }

    for (const mode of ['links', 'all', 'stale']) {
      test(`${mode}: a later origin edited after its snapshot read is deferred unstamped; its siblings are written (#6272)`, async () => {
        const slugs = ['notes/a', 'notes/b', 'notes/c'];
        // a -> c, b -> c, c -> a: no origin links to b, so editing b moves no other origin's endpoint.
        for (const [slug, to] of [['notes/a', 'notes/c'], ['notes/b', 'notes/c'], ['notes/c', 'notes/a']]) {
          await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Links [[${to}]].` }, { sourceId });
        }
        const stamps = async () => Object.fromEntries((await engine.executeRaw<{ slug: string; links_extracted_at: string | null }>(
          'SELECT slug,links_extracted_at FROM pages WHERE source_id=$1 AND slug=ANY($2) ORDER BY slug', [sourceId, slugs])).map(r => [r.slug, r.links_extracted_at]));
        const outgoing = async (slug: string) => (await engine.executeRaw<{ to_slug: string }>(
          `SELECT t.slug AS to_slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
           WHERE f.source_id=$1 AND f.slug=$2 AND l.link_source='markdown' ORDER BY t.slug`, [sourceId, slug])).map(r => r.to_slug);
        await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1', [sourceId]);
        const original = engine.replaceDerivedLinks, originalBatch = engine.replaceDerivedLinksBatch;
        let edited = false;
        // Another writer edits b after its snapshot was read, just as b's links are published.
        const editLaterOrigin = async (origins: DerivedLinkOrigin[]) => {
          if (edited || !origins.some(origin => origin.slug === 'notes/b')) return;
          edited = true;
          await engine.putPage('notes/b', { type: 'note', title: 'notes/b', compiled_truth: 'Edited by another writer: [[notes/a]].' }, { sourceId });
        };
        engine.replaceDerivedLinks = async (origin, links, opts) => { await editLaterOrigin([origin]); return original.call(engine, origin, links, opts); };
        engine.replaceDerivedLinksBatch = async items => { await editLaterOrigin(items.map(item => item.origin)); return originalBatch.call(engine, items); };
        const out: string[] = [];
        const writeSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out.push(String(chunk)); return true; }) as never);
        const logSpy = spyOn(console, 'log').mockImplementation((...args) => { out.push(args.join(' ')); });
        const exitSpy = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`extract exited ${code}`); });
        let stale: Awaited<ReturnType<typeof extractStaleFromDB>> | undefined;
        try {
          if (mode === 'stale') stale = await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, sourceIdFilter: sourceId, includeFrontmatter: false, catchUp: false });
          else await runExtract(engine, [mode, '--source', 'db', '--source-id', sourceId, '--json']);
        } finally {
          engine.replaceDerivedLinks = original;
          engine.replaceDerivedLinksBatch = originalBatch;
          writeSpy.mockRestore();
          logSpy.mockRestore();
          exitSpy.mockRestore();
        }
        expect(edited).toBe(true);
        expect(exitSpy).not.toHaveBeenCalled();
        const summary = out.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).at(-1);
        expect(summary.skipped_concurrent_write).toBe(1);
        if (stale) expect(stale.skippedConcurrentWrite).toBe(1);
        expect(await outgoing('notes/a')).toEqual(['notes/c']);
        expect(await outgoing('notes/c')).toEqual(['notes/a']);
        // The deferred origin kept nothing from the read it lost: no links from that read, no stamp.
        expect(await outgoing('notes/b')).toEqual([]);
        expect(out.join('\n')).not.toContain('extract exited');
        const after = await stamps();
        expect(after['notes/b']).toBeNull();
        if (mode !== 'links') { expect(after['notes/a']).not.toBeNull(); expect(after['notes/c']).not.toBeNull(); }
        // The next run finishes it from the new content.
        if (mode === 'stale') await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, sourceIdFilter: sourceId, includeFrontmatter: false, catchUp: false });
        else await runExtract(engine, [mode, '--source', 'db', '--source-id', sourceId, '--json']);
        expect(await outgoing('notes/b')).toEqual(['notes/a']);
        for (const slug of slugs) await engine.executeRaw('DELETE FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      });
    }

    test('only a real concurrent write defers; a synthetic revision_conflict, a backfill-pending revision and storage errors stay fatal (#6272)', async () => {
      const item = { origin: { slug: 'notes/x', sourceId, expectedRevision: '00000000-0000-0000-0000-000000000000', sourceIncarnation: '00000000-0000-0000-0000-000000000000' }, links: [] };
      const failing = (error: unknown) => ({ replaceDerivedLinks: async () => { throw error; }, replaceDerivedLinksBatch: async () => { throw error; } }) as unknown as BrainEngine;
      expect(await replaceDerivedLinksBatchOrReplay(failing(new DerivedLinkEndpointChangedError('moved')), [item])).toEqual(['concurrent_write']);
      expect(await replaceDerivedLinksBatchOrReplay(failing(new PageRevisionConflictError('a', 'b')), [item])).toEqual(['concurrent_write']);
      expect(await replaceDerivedLinksBatchOrReplay(failing(new DerivedLinkSettingsChangedError()), [item])).toEqual(['settings_changed']);
      for (const fatal of [Object.assign(new Error('synthetic'), { code: 'revision_conflict' }), new RevisionBackfillPendingError('a'), new TypeError('bad row')]) {
        await expect(replaceDerivedLinksBatchOrReplay(failing(fatal), [item])).rejects.toBe(fatal);
      }
    });
  });
}
