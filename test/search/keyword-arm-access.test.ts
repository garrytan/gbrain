/**
 * Keyword arm access pin, on PGLite here and on PostgreSQL through
 * test/e2e/keyword-arm-ranking-postgres.test.ts.
 *
 * Every page that matches the query term ranks above the open pages (the
 * restricted ones repeat it), so a filter that stopped running would put a
 * restricted page at the top. The term matches every page for a local caller
 * that may read private pages, which proves the matches exist; a remote
 * (excludePrivate) caller reads only the open ones. Soft-deleted, quarantined
 * and archived-source pages never surface for anyone.
 *
 * On Postgres the calls cover each shape of the keyword statement
 * (PostgresEngine.searchKeyword): no source scope and a scope that covers every
 * live source (candidates driven by the chunk match, one page probe per
 * match), a type filter and a scope that leaves a live source out (the page
 * join), and the keyword-mode count and pages statements.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const TERM = 'quorvanel';
const OPEN = ['notes/open-a', 'notes/open-b'];
const SIDE_OPEN = 'side/open-c';
const READABLE_LOCALLY = ['notes/private', 'notes/readers', 'side/private'];

for (const kind of testBackends()) {
  describe(`keyword arm access (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    async function page(slug: string, sourceId: string, frontmatter: Record<string, unknown>, hits: number) {
      const body = `${Array.from({ length: hits }, () => TERM).join(' ')} planning notes for ${slug}.`;
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, frontmatter }, { sourceId });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { sourceId });
    }

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('side', 'side'), ('gone', 'gone') ON CONFLICT DO NOTHING`);
      for (const slug of OPEN) await page(slug, 'default', {}, 1);
      await page(SIDE_OPEN, 'side', {}, 1);
      await page('notes/private', 'default', { visibility: 'private' }, 6);
      await page('notes/readers', 'default', { readable_by: ['alice-example'] }, 6);
      await page('side/private', 'side', { visibility: 'private' }, 6);
      await page('notes/deleted', 'default', {}, 6);
      await page('notes/quarantined', 'default', { quarantine: true }, 6);
      await page('gone/archived', 'gone', {}, 6);
      await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/deleted'`);
      await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'gone'`);
    }, 120_000);

    afterAll(async () => { await close?.(); });

    const scopes: Array<[string, SearchOpts, string[]]> = [
      ['no source scope', {}, [...OPEN, SIDE_OPEN]],
      ['a type filter', { types: ['note'] }, [...OPEN, SIDE_OPEN]],
      ['a scope covering every live source', { sourceIds: ['default', 'side'] }, [...OPEN, SIDE_OPEN]],
      ['a scope leaving a live source out', { sourceIds: ['default'] }, OPEN],
      ['one source', { sourceId: 'side' }, [SIDE_OPEN]],
    ];

    test('a local caller that reads private pages finds every live match, and never a deleted, quarantined or archived-source page', async () => {
      const slugs = (await engine.searchKeyword(TERM, { limit: 50 })).map(r => r.slug).sort();
      expect(slugs).toEqual([...OPEN, SIDE_OPEN, ...READABLE_LOCALLY].sort());
    });

    for (const [name, scope, open] of scopes) {
      test(`remote keyword arm with ${name} returns only open pages`, async () => {
        const remote = { ...scope, excludePrivate: true, requireSafeChunks: true };
        const arm = (await engine.searchKeyword(TERM, { ...remote, limit: 50 })).map(r => r.slug);
        expect([...arm].sort()).toEqual([...open].sort());
        const pages = (await engine.searchKeywordPages(TERM, remote, { limit: 50 })).map(r => r.slug);
        expect([...pages].sort()).toEqual([...open].sort());
        expect(await engine.countKeywordPages(TERM, remote)).toBe(open.length);
      });
    }

    const armFilters: Array<[string, SearchOpts, string[]]> = [
      ['an excluded slug', { exclude_slugs: ['notes/open-b'] }, ['notes/open-a', SIDE_OPEN]],
      ['a type no page has', { type: 'person' }, []],
      ['a date no page passes', { afterDate: '2999-01-01' }, []],
    ];

    for (const [name, filter, open] of armFilters) {
      test(`remote keyword arm with ${name} applies it`, async () => {
        const arm = await engine.searchKeyword(TERM, { ...filter, excludePrivate: true, requireSafeChunks: true, limit: 50 });
        expect(arm.map(r => r.slug).sort()).toEqual([...open].sort());
      });
    }

    test('remote keyword arm OR fallback returns only open pages', async () => {
      const arm = await engine.searchKeyword(`${TERM} zzvorquent`, { excludePrivate: true, requireSafeChunks: true, orFallback: true, limit: 50 });
      expect(arm.map(r => r.slug).sort()).toEqual([...OPEN, SIDE_OPEN].sort());
    });

  });
}
