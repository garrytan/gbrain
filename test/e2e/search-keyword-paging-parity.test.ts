/**
 * Cat 40 Hard F2 engine parity: the strict keyword count and the keyword-mode
 * walk behave the same on PGLite and Postgres (Postgres arm runs when
 * DATABASE_URL is set; the PGLite arm always runs).
 *
 * Both engines delegate to src/core/engine-sql/keyword-pages.ts, but Postgres
 * runs it inside withScopedReadTransaction with a statement timeout and
 * returns float8 scores through postgres.js; a keyset cursor that does not
 * round-trip there would repeat or skip pages only on Postgres.
 *
 * Authoring gate: (1) every page `total` reports is reachable on both engines,
 * with a dominant page, mixed types, a mid-walk write and private fence text;
 * (2) fails if either engine's scores lose precision through the cursor, if
 * the count drifts from the rows, or if the OR retry leaks into the count;
 * (3) the unit suite runs PGLite only; (4) no seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { DOMINANT_SLUG, MIXED_TYPES, TERM, callSearch, seedKeywordCorpus, seedPage, walkKeyword } from '../helpers/keyword-paging-fixture.ts';

const backends = process.env.DATABASE_URL ? ['pglite', 'postgres'] as const : ['pglite'] as const;
const arms: Partial<Record<(typeof backends)[number], { engine: BrainEngine; matching: string[] }>> = {};
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  for (const backend of backends) {
    let engine: BrainEngine;
    if (backend === 'postgres') {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = isolated.engine;
      closers.push(isolated.close);
    } else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      closers.push(() => engine.disconnect());
    }
    arms[backend] = { engine, matching: await seedKeywordCorpus(engine) };
  }
}, 300_000);

afterAll(async () => { for (const close of closers) await close(); });

for (const backend of backends) {
  describe(`keyword paging on ${backend}`, () => {
    const arm = () => arms[backend]!;

    test('walk past 3 x limit recovers every page total reports, the dominant page once', async () => {
      const { pages, slugs } = await walkKeyword(arm().engine, { query: TERM, limit: 4 });
      expect(pages.length).toBeGreaterThan(3);
      expect(pages[0].retrieval.total).toBe(arm().matching.length);
      expect(new Set(slugs).size).toBe(slugs.length);
      expect([...slugs].sort()).toEqual([...arm().matching].sort());
      expect(slugs.filter(s => s === DOMINANT_SLUG).length).toBe(1);
    });

    test('a query only the OR retry matches: total 0', async () => {
      expect((await arm().engine.searchKeyword('zephyrine obsidianite', { orFallback: true })).length).toBe(2);
      const page = await callSearch(arm().engine, { query: 'zephyrine obsidianite', match: 'keyword' });
      expect(page.retrieval).toMatchObject({ total: 0, truncated: false });
      expect(page.rows).toEqual([]);
      expect((await callSearch(arm().engine, { query: 'zephyrine obsidianite' })).retrieval.keyword_total).toBe(0);
    });

    test('page boundaries and mixed types', async () => {
      const n = arm().matching.length;
      const exact = await walkKeyword(arm().engine, { query: TERM, limit: n / 4 });
      expect(exact.pages.map(p => p.retrieval.truncated)).toEqual([true, true, true, false]);
      expect(exact.pages[3].retrieval.next).toBeUndefined();
      const typed = await walkKeyword(arm().engine, { query: TERM, limit: 3, types: ['meeting'] });
      expect(typed.pages[0].retrieval.total).toBe(MIXED_TYPES);
      expect(typed.slugs.length).toBe(MIXED_TYPES);
    });

    test('a write mid-walk repeats nothing and loses no unchanged page', async () => {
      const { slugs } = await walkKeyword(arm().engine, { query: TERM, limit: 5 }, true, 50, async page => {
        if (page === 1) await seedPage(arm().engine, 'notes/zz-mid-walk', `A ${TERM} note written mid-walk.`);
      });
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const slug of arm().matching) expect(slugs).toContain(slug);
      await arm().engine.executeRaw(`DELETE FROM pages WHERE slug = 'notes/zz-mid-walk'`);
    });

    test('short, oversized, short under a small evidence budget keeps every row in order', async () => {
      const e = arm().engine;
      await seedPage(e, 'meetings/sos-1', `${TERM} ${TERM} ${TERM} sos short one.`, { type: 'meeting' });
      await seedPage(e, 'meetings/sos-2', `${TERM} sos oversized middle. ${'Filler sentence about logistics planning. '.repeat(400)}`, { type: 'meeting' });
      await seedPage(e, 'meetings/sos-3', `${TERM} sos short three.`, { type: 'meeting' });
      try {
        const page = await callSearch(e, { query: `${TERM} sos`, match: 'keyword', types: ['meeting'], return_unit: 'page', token_budget: 60 });
        expect(page.rows.map(r => r.slug)).toEqual(['meetings/sos-1', 'meetings/sos-2', 'meetings/sos-3']);
        expect(page.rows.filter(r => r.evidence_omitted).map(r => r.slug)).toEqual(['meetings/sos-2']);
      } finally {
        await e.executeRaw(`DELETE FROM pages WHERE slug LIKE 'meetings/sos-%'`);
      }
    });

    test('private fence text is not counted for remote callers', async () => {
      const e = arm().engine;
      await seedPage(e, 'notes/fenced', 'Public body.\n<!--- gbrain:takes:begin -->\nThe marmoset deal is risky.\n<!--- gbrain:takes:end -->');
      try {
        expect((await callSearch(e, { query: 'marmoset' }, true)).retrieval.keyword_total).toBe(0);
        expect((await callSearch(e, { query: 'marmoset', match: 'keyword' }, true)).retrieval.total).toBe(0);
      } finally {
        await e.executeRaw(`DELETE FROM pages WHERE slug = 'notes/fenced'`);
      }
    });
  });
}

if (backends.length === 2) {
  test('both engines enumerate the same pages in the same order', async () => {
    const [a, b] = await Promise.all(backends.map(k => walkKeyword(arms[k]!.engine, { query: TERM, limit: 6 })));
    expect(b.slugs).toEqual(a.slugs);
  });
}
