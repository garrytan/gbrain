/**
 * Search `stale` parity: every search arm marks a result stale when its page
 * has a timeline entry created after the page was last updated, on both
 * engines (in-memory PGLite; Postgres too when DATABASE_URL is set).
 *
 * 1. Protects: the `stale` flag in search results (and so `gbrain search
 *    --json`) is the same on PGLite and Postgres for a page with no timeline,
 *    an older timeline entry and a newer one.
 * 2. Fails when: an engine hardcodes `false AS stale`, or a search arm drops
 *    the timeline probe or changes its rule
 *    (`p.updated_at < MAX(timeline_entries.created_at)`).
 * 3. Existing coverage: the CJK keyword arm already shares one builder
 *    (src/core/search/cjk-keyword-sql.ts); this file covers the keyword,
 *    keyword-chunks, keyword-pages, title and vector arms.
 * 4. Real seams: importFromContent, the engines' search methods; the page and
 *    timeline timestamps are pinned with SQL so no case depends on the clock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { testBackends, type TestBackend } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DIMS = 1536;
const WORD = 'quokkastale';
const PAGE_UPDATED = '2026-01-10T00:00:00Z';
/** slug -> created_at of its one timeline entry (null: no timeline). */
const PAGES: Record<string, string | null> = {
  'notes/stale-none': null,
  'notes/stale-older': '2026-01-05T00:00:00Z',
  'notes/stale-newer': '2026-01-20T00:00:00Z',
};
const EXPECTED = { 'notes/stale-newer': true, 'notes/stale-none': false, 'notes/stale-older': false };

function basis(): Float32Array {
  const v = new Float32Array(DIMS);
  v[0] = 1;
  return v;
}

/** slug -> stale, one entry per page (every arm returns one row per page here). */
function staleBySlug(rows: SearchResult[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of [...rows].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (r.slug in PAGES) out[r.slug] = r.stale === true;
  }
  return out;
}

const seen = new Map<TestBackend, Record<string, Record<string, boolean>>>();
const backends = testBackends();

for (const kind of backends) {
  describe(`search stale flag (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array.from(basis())) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const [slug, entryAt] of Object.entries(PAGES)) {
        const title = `${WORD} ${slug.split('/')[1]}`;
        await importFromContent(engine, slug, `---\ntype: note\ntitle: ${title}\n---\n# ${title}\n\nNotes about the ${WORD} plan.`, {});
        if (entryAt) {
          await engine.addTimelineEntry(slug, { date: '2026-01-01', summary: `${WORD} event` });
          await engine.executeRaw(
            `UPDATE timeline_entries SET created_at = $2::timestamptz WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')`,
            [slug, entryAt],
          );
        }
        await engine.executeRaw(`UPDATE pages SET updated_at = $2::timestamptz WHERE slug = $1 AND source_id = 'default'`, [slug, PAGE_UPDATED]);
      }
      const pinned = await engine.executeRaw<{ slug: string; updated_at: Date }>(
        `SELECT slug, updated_at FROM pages WHERE slug = ANY($1::text[]) ORDER BY slug`, [Object.keys(PAGES)],
      );
      expect(pinned.map((r) => new Date(r.updated_at).toISOString())).toEqual(Object.keys(PAGES).map(() => new Date(PAGE_UPDATED).toISOString()));
    }, 120_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('keyword, keyword-chunks, keyword-pages, title and vector search mark only the page with a newer timeline entry stale', async () => {
      const arms = {
        searchKeyword: staleBySlug(await engine.searchKeyword(WORD, { limit: 10 })),
        searchKeywordChunks: staleBySlug(await engine.searchKeywordChunks(WORD, { limit: 10 })),
        searchKeywordPages: staleBySlug(await engine.searchKeywordPages(WORD, undefined, { limit: 10 })),
        searchTitles: staleBySlug(await engine.searchTitles(WORD, { limit: 10 })),
        searchVector: staleBySlug(await engine.searchVector(basis(), { limit: 10 })),
      };
      seen.set(kind, arms);
      for (const [arm, got] of Object.entries(arms)) expect({ arm, got }).toEqual({ arm, got: EXPECTED });
    }, 60_000);
  });
}

describe('search stale flag: engines agree', () => {
  test('every engine arm that ran returned the same stale flags', () => {
    const runs = backends.filter((b) => seen.has(b)).map((b) => seen.get(b));
    expect(runs.length).toBe(backends.length);
    for (const run of runs) expect(run).toEqual(runs[0]);
  });
});
