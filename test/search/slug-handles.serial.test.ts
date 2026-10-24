/**
 * GBRA-108: a slug handle (`dan-example`) names the page `people/dan-example`
 * even when no indexed text holds it: the page is titled "Dan Example" and
 * `websearch_to_tsquery` turns a hyphenated handle into a phrase only the
 * literal handle matches. Keyword search resolves each handle by exact slug
 * basename (search/keyword-handles.ts) under the keyword statement's scope,
 * filters and visibility, in `match: "keyword"` and in the hybrid keyword
 * arm, and the resolved pages vote like strict rows.
 *
 * PGLite here, PostgreSQL through test/e2e/slug-handles-postgres.test.ts.
 * Serial: it stubs the process-wide embedding transport.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { callSearch } from '../helpers/keyword-paging-fixture.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const QUERY_VEC = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0));
const vec = (spread: number) => '[' + Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : j === 1000 ? spread : 0)).join(',') + ']';
const CLOSE = vec(0.05);
const FAR = vec(0.6);

const Q = '"dan-example" OR "erin-example"';
const PEOPLE = ['people/dan-example', 'people/erin-example'];
const LEAKS = ['people/gina-example', 'people/hank-example', 'people/ivy-example'];
const LEAK_Q = '"dan-example" OR "gina-example" OR "hank-example" OR "ivy-example"';

let prevHome: string | undefined;
let home: string;

beforeAll(() => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-slug-handles-'));
  process.env.GBRAIN_HOME = home;
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests(async (args: any) => ({ embeddings: args.values.map(() => QUERY_VEC) }) as any);
});

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

for (const kind of testBackends()) {
  describe('slug handles in keyword search (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    async function page(slug: string, type: string, title: string, body: string, embedding: string, extra: { sourceId?: string; frontmatter?: Record<string, unknown> } = {}) {
      const sourceId = extra.sourceId ?? 'default';
      await engine.putPage(slug, { type, title, compiled_truth: body, frontmatter: extra.frontmatter ?? {} } as never, { sourceId } as never);
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { sourceId });
      await engine.executeRaw(
        'UPDATE content_chunks SET embedding = $1::vector, model = $4, embedded_text_hash = md5(chunk_text) WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = $3)',
        [embedding, slug, sourceId, MODEL],
      );
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
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES ('other','other','{}') ON CONFLICT DO NOTHING");
      await page('people/dan-example', 'person', 'Dan Example', 'VP of Procurement at northwind-example. Reports to the COO.', FAR);
      await page('people/erin-example', 'person', 'Erin Example', 'Product Manager, Mobile at lumen-example.', FAR);
      await page('companies/northwind-example', 'company', 'Northwind Example', 'Procurement led by dan-example. Renewal due in Q3.', CLOSE);
      await page('meetings/2026-10-06-mobile-planning', 'meeting', 'Mobile planning', 'Attendees: erin-example, frank-example. Mobile planning for the launch.', CLOSE);
      for (let i = 0; i < 20; i++) await page('notes/planning-' + i, 'note', 'Planning note ' + i, 'Weekly planning note ' + i + ' for the launch.', CLOSE);
      await page('people/gina-example', 'person', 'Gina Example', 'Private notes on a candidate.', FAR, { frontmatter: { visibility: 'private' } });
      await page('people/hank-example', 'person', 'Hank Example', 'A contact filed in another source.', FAR, { sourceId: 'other' });
      await page('people/ivy-example', 'person', 'Ivy Example', 'An unverified stub.', FAR, { frontmatter: { quarantine: 'unverified' } });
    }, 300_000);

    afterAll(async () => {
      await close?.();
    });

    const slugs = (rows: Array<{ slug?: unknown }>) => rows.map((r) => String(r.slug));

    test('match: "keyword" lists the pages the quoted handles name first, and counts them', async () => {
      const { rows, retrieval } = await callSearch(engine, { query: Q, match: 'keyword' }, false);
      expect(slugs(rows).slice(0, 2).sort()).toEqual(PEOPLE);
      expect(slugs(rows)).toContain('companies/northwind-example');
      expect(retrieval.total).toBe(rows.length);
    });

    test('match: "keyword" with types person returns the named people', async () => {
      const { rows, retrieval } = await callSearch(engine, { query: Q, match: 'keyword', types: ['person'] }, false);
      expect(slugs(rows).sort()).toEqual(PEOPLE);
      expect(retrieval.total).toBe(2);
    });

    test('the hybrid keyword arm leads with the named pages as rows that vote like strict rows', async () => {
      const rows = await engine.searchKeyword(Q, { limit: 20, orFallback: true });
      expect(slugs(rows).slice(0, 2).sort()).toEqual(PEOPLE);
      expect(rows.slice(0, 2).every((r) => r.keyword_relaxed === undefined)).toBe(true);
      const results = await hybridSearch(engine, Q, { limit: 10, expansion: false });
      expect(slugs(results).slice(0, 2).sort()).toEqual(PEOPLE);
      const people = await hybridSearch(engine, Q, { limit: 10, expansion: false, types: ['person'] });
      expect(slugs(people).slice(0, 2).sort()).toEqual(PEOPLE);
    });

    test('a bare handle in keyword mode returns the page it names', async () => {
      const { rows } = await callSearch(engine, { query: 'dan-example', match: 'keyword', types: ['person'] }, false);
      expect(slugs(rows)).toEqual(['people/dan-example']);
    });

    test('precision callers (no orFallback) keep the strict-AND contract', async () => {
      expect(slugs(await engine.searchKeyword(Q, { limit: 20 }))).not.toContain('people/dan-example');
    });

    test('a local unscoped read resolves the private and other-source handles (the fixture can leak)', async () => {
      const rows = await engine.searchKeywordPages(LEAK_Q, {}, { limit: 20 });
      expect(slugs(rows)).toEqual(expect.arrayContaining(['people/dan-example', 'people/gina-example', 'people/hank-example']));
      expect(slugs(rows)).not.toContain('people/ivy-example');
    });

    test('a remote caller resolves no handle naming an ungranted source, a private page or a quarantined page', async () => {
      for (const params of [{ query: LEAK_Q, match: 'keyword' }, { query: LEAK_Q, match: 'keyword', types: ['person'] }, { query: LEAK_Q }]) {
        const { rows } = await callSearch(engine, params, true);
        expect(slugs(rows)).toContain('people/dan-example');
        for (const leaked of LEAKS) expect(slugs(rows)).not.toContain(leaked);
      }
    });
  });
}
