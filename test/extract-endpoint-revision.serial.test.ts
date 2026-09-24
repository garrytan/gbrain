import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine, LinkBatchInput } from '../src/core/engine.ts';
import type { DerivedLinkReplacementOptions } from '../src/core/derived-links.ts';
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
      return engine.executeRaw<{ id: number; link_type: string; link_source: string; to_source: string }>(
        `SELECT l.id,l.link_type,l.link_source,t.source_id AS to_source FROM links l
         JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
         WHERE f.source_id=$1 AND f.slug=$2 ORDER BY l.id`, [sourceId, originSlug]);
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
          expect(before.filter(row => row.link_source === 'markdown').map(row => [row.link_type, row.to_source]))
            .toEqual([['attended', targetSourceId]]);
          await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1 AND slug=$2', [sourceId, originSlug]);
          const targetSnapshot = (await engine.readPageSnapshot(targetSlug, { sourceId: targetSourceId }))!;
          const original = engine.replaceDerivedLinks;
          let retyped = false;
          let captured: LinkBatchInput[] = [];
          let fences: DerivedLinkReplacementOptions['expectedEndpoints'];
          engine.replaceDerivedLinks = async (origin, links, opts) => {
            if (!retyped && origin.sourceId === sourceId && origin.slug === originSlug) {
              retyped = true;
              captured = links;
              fences = opts?.expectedEndpoints;
              await engine.putPage(targetSlug, { type: 'decision', title: 'Decision Example', compiled_truth: 'Retyped after inference.' }, { sourceId: targetSourceId });
            }
            return original.call(engine, origin, links, opts);
          };
          const errors: string[] = [];
          const errorSpy = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
          const exitSpy = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`extract exited ${code}`); });
          try {
            await expect(run()).rejects.toThrow(mode === 'stale' ? 'endpoint changed after type resolution' : 'extract exited 1');
            if (mode !== 'stale') {
              expect(exitSpy).toHaveBeenCalledWith(1);
              expect(errors).toContain('A derived link endpoint changed after type resolution');
            }
          } finally {
            engine.replaceDerivedLinks = original;
            errorSpy.mockRestore();
            exitSpy.mockRestore();
          }
          expect(retyped).toBe(true);
          expect(captured.some(link => link.link_type === 'attended' && link.to_source_id === targetSourceId)).toBe(true);
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
  });
}
