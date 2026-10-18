/**
 * A projection build racing a demotion of its page (Wave B PR 2, lane A).
 *
 * 1. Protects: a segmented projection that read its page at generation G and is overtaken by a demotion (an inline
 *    write onto the page, committed at G+1 with its own inline chunks and seal) deletes none of the inline page's
 *    chunks: its retirement re-reads the page under the page lock and stops when the page is no longer segmented
 *    at G, so the demoted page stays searchable.
 * 2. Fails when: retirement deletes every body_generation IS NULL row before checking the page's generation and
 *    storage, so the demotion's new inline chunks are lost while the inline page stays sealed and unqueued.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The interleaving is forced: the projection's
 *    manifest read (its first statement after reading the page) runs the demotion before it returns.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { buildSegmentedProjection } from '../../src/core/page-body/projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';

function sections(tag: string, n = 60): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`## Section ${tag}${i}\n\n` + `Paragraph ${i} of ${tag} about widgets and gadgets number ${i}. `.repeat(400) + '\n\n');
  return parts.join('');
}
const page = (body: string) => `---\ntitle: Demotion race\ntype: note\n---\n\n${body}`;

/** The engine with readManifest running before(target) once, after its own read and before it returns. */
function withManifestHook(engine: BrainEngine, before: (target: BrainEngine) => Promise<void>): BrainEngine {
  let fired = false;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'readManifest') {
        return async (...args: Parameters<BrainEngine['readManifest']>) => {
          const rows = await target.readManifest(...args);
          if (!fired) { fired = true; await before(target); }
          return rows;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const kind of testBackends()) {
  describe(`projection racing a demotion (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => { await engine.setConfig('pages.segmented_storage', 'on'); });

    test('a demotion that commits while the projection reads its manifest keeps its inline chunks and stays searchable', async () => {
      const slug = 'notes/demotion-race';
      await importFromContent(engine, slug, page(sections('a')), { sourceId: 'default', noEmbed: true });
      const { id } = await segmentedPageRow(engine, slug);
      await engine.executeRaw('UPDATE pages SET text_projection_revision = NULL WHERE id = $1', [id]);
      const racing = withManifestHook(engine, async target => {
        expect(await importFromContent(target, slug, page('A short replacement body about lighthouses and harbours.\n'), { sourceId: 'default', noEmbed: true }))
          .toMatchObject({ status: 'imported' });
      });
      const result = await buildSegmentedProjection(racing, { sourceId: 'default', slug });
      expect(result.sealed).toBe(false);
      const row = await segmentedPageRow(engine, slug);
      expect(row.body_storage).toBe('inline');
      expect(row.text_projection_revision).toBe(row.knowledge_revision);
      const [inline] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1 AND body_generation IS NULL', [id]);
      expect(Number(inline!.n)).toBeGreaterThan(0);
      expect((await engine.searchKeyword('lighthouses', { limit: 5 })).map(r => r.slug)).toContain(slug);
    }, 180_000);
  });
}
