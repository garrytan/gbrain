/**
 * #7491: a question naming an identifier ("What did the latest weekly digest
 * (#412) say?") must return the one page holding it. Three shapes lost it:
 * (1) no chunk holds every word, the any-word retry ranks the target first,
 * and hybrid drops relaxed rows while the vector arm is healthy; (2) the retry
 * ranks long chunks repeating common words above the short chunk holding the
 * identifier; (3) an unrelated chunk holds every word, so the strict match
 * never reaches the target. The identifier probe
 * (search/keyword-identifier-probe.ts) matches the AND of the query's
 * identifier tokens under the same scope and filters, and its rows vote like
 * strict rows.
 *
 * PGLite here, PostgreSQL through test/e2e/identifier-probe-postgres.test.ts.
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
import type { SearchOpts } from '../../src/core/types.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
/** The query embeds to e0; template pages sit closer to it than the target. */
const QUERY_VEC = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0));
const vec = (spread: number) => '[' + Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : j === 1000 ? spread : 0)).join(',') + ']';
const CLOSE = vec(0.05);
const FAR = vec(0.6);

const DIGEST_Q = 'What did the latest weekly digest (#412) say?';
const REPORT_Q = 'What did digest report #412 say?';
const TARGET = 'digests/weekly-digest-412';
const REPORT_TARGET = 'reports/digest-412';
const REMOTE: SearchOpts = { requireSafeChunks: true, excludePrivate: true, sourceId: 'default' };

let prevHome: string | undefined;
let home: string;

beforeAll(() => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-identifier-probe-'));
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
  describe('identifier probe (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

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
    }, 120_000);

    afterAll(async () => {
      await close?.();
    });

    async function page(slug: string, title: string, body: string, embedding: string, extra: { sourceId?: string; frontmatter?: Record<string, unknown> } = {}) {
      const sourceId = extra.sourceId ?? 'default';
      await engine.putPage(slug, { type: 'note', title, compiled_truth: body, frontmatter: extra.frontmatter ?? {} } as never, { sourceId } as never);
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { sourceId });
      await engine.executeRaw(
        'UPDATE content_chunks SET embedding = $1::vector, model = $4, embedded_text_hash = md5(chunk_text) WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = $3)',
        [embedding, slug, sourceId, MODEL],
      );
    }

    const slugs = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug);

    describe('template digests: strict empty, relaxed row demoted (shape 1)', () => {
      beforeAll(async () => {
        await engine.executeRaw('DELETE FROM pages');
        for (let n = 300; n < 420; n++) {
          if (n === 412) continue;
          await page('digests/weekly-digest-' + n, 'Weekly digest (#' + n + ')', 'Weekly digest #' + n + ': channel summary for the week, items reviewed and owners noted.', CLOSE);
        }
        await page(TARGET, 'Weekly digest (#412)', 'Weekly digest #412: channel summary for the week, items reviewed and owners noted.', FAR);
      }, 300_000);

      test('the keyword arm returns the target first, as a row that votes like a strict row', async () => {
        const rows = await engine.searchKeyword(DIGEST_Q, { limit: 20, orFallback: true });
        expect(rows[0]?.slug).toBe(TARGET);
        expect(rows[0]?.keyword_relaxed).toBeUndefined();
      });

      test('hybrid search ranks the target first while the vector arm is healthy', async () => {
        const results = await hybridSearch(engine, DIGEST_Q, { limit: 10, expansion: false });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.slug).toBe(TARGET);
      });

      test('a query of the identifier and template words alone still ranks the target first', async () => {
        const results = await hybridSearch(engine, 'weekly digest #412', { limit: 10, expansion: false });
        expect(results[0]?.slug).toBe(TARGET);
      });

      test('without an identifier the relaxed rows are still dropped from fusion', async () => {
        const q = 'What did the latest weekly digest say?';
        const relaxed = await engine.searchKeyword(q, { limit: 20, orFallback: true });
        expect(relaxed.length).toBeGreaterThan(0);
        expect(relaxed.every((r) => r.keyword_relaxed === true)).toBe(true);
        const results = await hybridSearch(engine, q, { limit: 10, expansion: false });
        expect(results.every((r) => r.keyword_relaxed !== true)).toBe(true);
      });

      test('precision callers (no orFallback) keep the strict-AND contract', async () => {
        expect(await engine.searchKeyword(DIGEST_Q, { limit: 20 })).toHaveLength(0);
      });
    });

    describe('common-word chunks outrank the identifier chunk (shapes 2 and 3)', () => {
      const filler = 'They say the digest report was fine. The digest report says they say the report was fine and the digest was fine.';

      beforeAll(async () => {
        await engine.executeRaw('DELETE FROM pages');
        for (let i = 0; i < 60; i++) await page('reports/filler-' + i, 'Status note ' + i, filler + ' Note ' + i + '.', CLOSE);
        // The vector arm cannot tell these pages apart: every page ties with the target.
        await page(REPORT_TARGET, 'Channel summary', 'Digest 412 channel summary.', CLOSE);
      }, 300_000);

      test('shape 2: strict empty, the any-word retry alone leaves the target out', async () => {
        const rows = await engine.searchKeyword(REPORT_Q, { limit: 20, orFallback: true });
        expect(slugs(rows)).toContain(REPORT_TARGET);
        expect(rows[0]?.slug).toBe(REPORT_TARGET);
        const results = await hybridSearch(engine, REPORT_Q, { limit: 10, expansion: false });
        expect(slugs(results).slice(0, 5)).toContain(REPORT_TARGET);
      });

      test('shape 3: a strict hit on an unrelated chunk does not hide the target', async () => {
        await page('reports/filler-412', 'Status note 412', filler + ' Ticket 412.', CLOSE);
        try {
          const strict = await engine.searchKeyword(REPORT_Q, { limit: 20 });
          expect(slugs(strict)).toEqual(['reports/filler-412']);
          const rows = await engine.searchKeyword(REPORT_Q, { limit: 20, orFallback: true });
          expect(slugs(rows)).toEqual(['reports/filler-412', REPORT_TARGET]);
          expect(rows.every((r) => r.keyword_relaxed !== true)).toBe(true);
          const results = await hybridSearch(engine, REPORT_Q, { limit: 10, expansion: false });
          expect(slugs(results).slice(0, 5)).toContain(REPORT_TARGET);
        } finally {
          await engine.executeRaw("DELETE FROM pages WHERE slug = 'reports/filler-412'");
        }
      });

    });

    describe('scope and visibility (remote caller)', () => {
      beforeAll(async () => {
        await engine.executeRaw('DELETE FROM pages');
        for (let n = 300; n < 330; n++) {
          await page('digests/weekly-digest-' + n, 'Weekly digest (#' + n + ')', 'Weekly digest #' + n + ': channel summary for the week.', CLOSE);
        }
        await page(TARGET, 'Weekly digest (#412)', 'Weekly digest #412: channel summary for the week.', FAR);
        await page('digests/other-source-412', 'Weekly digest (#412) mirror', 'Weekly digest #412: mirrored channel summary for the week.', FAR, { sourceId: 'other' });
        await page('digests/private-412', 'Weekly digest (#412) draft', 'Weekly digest #412: private draft of the channel summary.', FAR, { frontmatter: { visibility: 'private' } });
        await page('digests/unsealed-412', 'Weekly digest (#412) pending', 'Weekly digest #412: pending copy of the channel summary.', FAR);
        await engine.executeRaw("UPDATE pages SET text_projection_revision = NULL WHERE slug = 'digests/unsealed-412'");
      }, 300_000);

      test('a local unscoped read sees the other-source and private copies (the fixture can leak)', async () => {
        const rows = await engine.searchKeyword(DIGEST_Q, { limit: 20, orFallback: true });
        expect(slugs(rows)).toEqual(expect.arrayContaining([TARGET, 'digests/other-source-412', 'digests/private-412']));
      });

      test('a remote read gets the target and no cross-source, private or unsealed row', async () => {
        const rows = await engine.searchKeyword(DIGEST_Q, { ...REMOTE, limit: 20, orFallback: true });
        expect(rows[0]?.slug).toBe(TARGET);
        for (const leaked of ['digests/other-source-412', 'digests/private-412', 'digests/unsealed-412']) expect(slugs(rows)).not.toContain(leaked);
        const results = await hybridSearch(engine, DIGEST_Q, { ...REMOTE, limit: 10, expansion: false });
        expect(results[0]?.slug).toBe(TARGET);
        for (const leaked of ['digests/other-source-412', 'digests/private-412', 'digests/unsealed-412']) expect(slugs(results)).not.toContain(leaked);
      });
    });
  });
}
