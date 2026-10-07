/**
 * #5889 + remote title FTS: the page-grain title arm (engine-sql/titles.ts)
 * on PGLite here and on PostgreSQL through test/e2e/title-arm-postgres.test.ts.
 *
 * #5889: every title holding the query term once ties on ts_rank_cd, ties
 * broke by page id, and the exact-lookup tier only sees the arm's top rows,
 * so an identity page titled exactly "Acme" (created last) was buried under
 * 60+ "Acme weekly sync N" pages for local and remote callers.
 *
 * Remote predicate: safe-chunks callers match weight-A (title) lexemes of
 * pages.search_vector. Parity cases compare against the previous title-only
 * predicate (`to_tsvector(lang, title) @@ websearch_to_tsquery(lang, q)`),
 * so timeline text can never change which titles a remote caller sees.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchOpts } from '../../src/core/types.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch, hybridSearchCached } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const DIM = 1536;
const LOCAL: SearchOpts = {};
const REMOTE: SearchOpts = { requireSafeChunks: true, excludePrivate: true };
const SYNC_PAGES = 64;

for (const kind of testBackends()) {
  describe(`title arm (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      // Empty env: no embedding, so hybridSearch takes the keyword + title path.
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIM, env: {} });
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);

    afterAll(async () => {
      await close?.();
      resetGateway(); // R5: restore the preload baseline for later files in this shard
    });

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages');
    });

    async function page(slug: string, title: string, body: string, timeline = '') {
      await engine.putPage(slug, { type: 'note', title, compiled_truth: body, timeline });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
    }

    async function seedSyncPages(prefix: string) {
      for (let i = 1; i <= SYNC_PAGES; i++) {
        await page(`${prefix}/acme-sync-${i}`, `Acme weekly sync ${i}`, `Acme sync ${i} notes: the Acme team reviewed the Acme roadmap.`);
      }
    }

    describe('#5889 exact-title page ranks first', () => {
      for (const prefix of ['notes', 'meetings']) {
        test(`${prefix}/ variant, local and remote callers`, async () => {
          await seedSyncPages(prefix);
          await page('projects/acme', 'Acme', 'Our flagship client project.');
          for (const [label, opts] of [['local', LOCAL], ['remote', REMOTE]] as const) {
            const titles = await engine.searchTitles('Acme', { ...opts, limit: 50 });
            expect({ label, slug: titles[0]?.slug }).toEqual({ label, slug: 'projects/acme' });
            const results = await hybridSearch(engine, 'Acme', { ...opts, limit: 20, expansion: false });
            expect({ label, slug: results[0]?.slug, exact: results[0]?.exact_lookup }).toEqual({ label, slug: 'projects/acme', exact: 'title' });
          }
        }, 120_000);
      }

      test('production cached path (search cache on) ranks it first too', async () => {
        await seedSyncPages('notes');
        await page('projects/acme', 'Acme', 'Our flagship client project.');
        for (const opts of [LOCAL, REMOTE]) {
          const results = await hybridSearchCached(engine, 'Acme', { ...opts, limit: 20, expansion: false, useCache: true });
          expect(results[0]?.slug).toBe('projects/acme');
          expect(results[0]?.exact_lookup).toBe('title');
        }
      }, 120_000);

      for (const [label, title] of [['quoted YAML title', '"Acme"'], ['trailing NBSP', 'Acme\u00a0']] as const) {
        test(`${label} ranks first with exact_lookup: title`, async () => {
          await seedSyncPages('notes');
          await page('projects/acme', title, 'Our flagship client project.');
          for (const opts of [LOCAL, REMOTE]) {
            const results = await hybridSearch(engine, 'Acme', { ...opts, limit: 20, expansion: false });
            expect(results[0]?.slug).toBe('projects/acme');
            expect(results[0]?.exact_lookup).toBe('title');
          }
        }, 120_000);
      }

      test('negative control: "Acme Corp" gets no exact_lookup', async () => {
        await seedSyncPages('notes');
        await page('companies/acme-corp', 'Acme Corp', 'A supplier.');
        for (const opts of [LOCAL, REMOTE]) {
          const results = await hybridSearch(engine, 'Acme', { ...opts, limit: 20, expansion: false });
          expect(results.some((r) => r.exact_lookup !== undefined)).toBe(false);
        }
      }, 120_000);

      test('the OR fallback re-runs the same statement and tags relaxed rows', async () => {
        await seedSyncPages('notes');
        await page('projects/acme-zebra', 'Acme Zebra', 'Unrelated body.');
        // Strict AND matches nothing, so the arm re-runs as OR; no title equals the query.
        const rows = await engine.searchTitles('Acme Zebra Quokka', { limit: 50 });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.keyword_relaxed === true)).toBe(true);
      }, 120_000);
    });

    describe('remote predicate matches the title alone', () => {
      async function legacyRemoteSlugs(query: string): Promise<string[]> {
        const rows = await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages WHERE to_tsvector('english', COALESCE(title, '')) @@ websearch_to_tsquery('english', $1) ORDER BY slug`,
          [query],
        );
        return rows.map((r) => r.slug);
      }
      async function remoteSlugs(query: string): Promise<string[]> {
        return (await engine.searchTitles(query, { ...REMOTE, limit: 100 })).map((r) => r.slug).sort();
      }

      beforeEach(async () => {
        await page('notes/acme-plan', 'Acme launch plan', 'Body without title words.', '- 2026-01-01: secret kickoff with the zebra team');
        await page('notes/acme-secret', 'Acme secret roadmap', 'Body.');
        await page('notes/globex-sync', 'Globex weekly sync', 'Body.', '- 2026-01-02: Acme mentioned in passing');
        await page('notes/launch-acme', 'Launch the Acme product', 'Body.');
        await page('notes/zebra', 'Zebra crossing', 'Body.');
      });

      const queries = [
        ['negation where only a timeline mentions the term', 'acme -secret'],
        ['phrase', '"acme launch"'],
        ['phrase across title words only', '"launch plan"'],
        ['OR', 'globex or zebra'],
        ['timeline-only term', 'kickoff'],
        ['purely negative', '-acme'],
        ['prefix-style token', 'acme*'],
        ['negated phrase', 'acme -"secret roadmap"'],
      ] as const;
      for (const [label, query] of queries) {
        test(`${label}: \`${query}\` matches the legacy title-only predicate`, async () => {
          expect(await remoteSlugs(query)).toEqual(await legacyRemoteSlugs(query));
        });
      }

      test('negation pins the expected titles', async () => {
        expect(await remoteSlugs('acme -secret')).toEqual(['notes/acme-plan', 'notes/launch-acme']);
        expect(await remoteSlugs('kickoff')).toEqual([]);
      });

      test('order follows the title rank, like the legacy predicate', async () => {
        const rows = await engine.searchTitles('acme', { ...REMOTE, limit: 100 });
        const legacy = await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages WHERE to_tsvector('english', title) @@ websearch_to_tsquery('english', 'acme')
            ORDER BY ts_rank_cd(to_tsvector('english', title), websearch_to_tsquery('english', 'acme')) DESC, id`,
        );
        expect(rows.map((r) => r.slug)).toEqual(legacy.map((r) => r.slug));
      });

      test('a page with a NULL search_vector is absent from the remote arm (accepted)', async () => {
        await engine.executeRaw(`UPDATE pages SET search_vector = NULL WHERE slug = 'notes/zebra'`);
        expect(await legacyRemoteSlugs('zebra')).toEqual(['notes/zebra']);
        expect(await remoteSlugs('zebra')).toEqual([]);
      });

      test('weight A of pages.search_vector is the title alone', async () => {
        await engine.executeRaw(
          `INSERT INTO timeline_entries (page_id, date, summary, detail)
           SELECT id, '2026-01-03', 'Quokka summit', 'quokka detail' FROM pages WHERE slug = 'notes/acme-plan'`,
        );
        await engine.executeRaw(`UPDATE pages SET timeline = timeline || ' more quokka text' WHERE slug = 'notes/acme-plan'`);
        const [row] = await engine.executeRaw<{ a: string; title: string; c: string }>(
          `SELECT strip(ts_filter(search_vector, '{a}'))::text AS a,
                  strip(to_tsvector('english', title))::text AS title,
                  strip(ts_filter(search_vector, '{c}'))::text AS c
             FROM pages WHERE slug = 'notes/acme-plan'`,
        );
        expect(row.a).toBe(row.title);
        expect(row.c).toContain('quokka');
      });
    });
  });
}
