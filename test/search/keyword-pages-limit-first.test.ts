/**
 * #7082: the keyword-mode page query pages each page's best (page_id,
 * chunk_id, score) row first and reads the page and chunk rows only for the
 * rows it returns. Before, it joined `pages` and `content_chunks` for every
 * matching page and only then applied ORDER BY and LIMIT, so a broad term
 * fetched one chunk row per matching page on every page of a cursor walk.
 *
 * Pinned on the executed plan on both engines (the Postgres arm runs through
 * test/e2e/keyword-pages-limit-first-postgres.test.ts): the output's chunk
 * read sits outside the statement's one Limit, and every join outside it
 * handles at most `limit` rows (which access path reads them is the
 * planner's choice on a fixture this small); and every offset and cursor
 * window returns the rows of the unpaged ordering.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildKeywordPagesStatement } from '../../src/core/search/keyword-statement.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { TERM, seedKeywordCorpus } from '../helpers/keyword-paging-fixture.ts';

type PlanNode = {
  'Node Type': string; 'Relation Name'?: string; Filter?: string; 'Index Cond'?: string; 'Recheck Cond'?: string;
  'Actual Rows'?: number; 'Actual Loops'?: number; Plans?: PlanNode[];
};
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];
const LIMIT = 3;
const shape = (rows: SearchResult[]) => rows.map(r => [r.slug, r.page_id, r.chunk_id, r.chunk_text, r.score]);

for (const kind of testBackends()) {
  describe(`keyword pages read page and chunk rows after the limit (${kind}, #7082)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let matching: string[];
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      matching = await seedKeywordCorpus(engine);
      await engine.executeRaw('ANALYZE content_chunks');
      await engine.executeRaw('ANALYZE pages');
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('pages and content_chunks are joined for the output outside the Limit, on at most `limit` rows', async () => {
      expect(matching.length).toBeGreaterThan(LIMIT * 5);
      const stmt = buildKeywordPagesStatement(TERM, undefined, { limit: LIMIT })!;
      const [row] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${stmt.sql}`, stmt.params);
      const plan = row!['QUERY PLAN'][0]!.Plan;
      const limits = planNodes(plan).filter(node => node['Node Type'] === 'Limit');
      expect(limits.length).toBe(1);
      const limited = new Set(planNodes(limits[0]!));
      const keyed = (node: PlanNode) => node['Relation Name'] === 'content_chunks'
        && ![node.Filter, node['Index Cond'], node['Recheck Cond']].some(cond => cond?.includes('search_vector'));
      const outside = planNodes(plan).filter(node => !limited.has(node));
      expect(limits[0]!['Actual Rows']).toBe(LIMIT);
      expect(outside.filter(keyed).length).toBe(1);
      expect(planNodes(limits[0]!).filter(keyed)).toEqual([]);
      const outputJoins = outside.filter(node => ['Nested Loop', 'Hash Join', 'Merge Join'].includes(node['Node Type']));
      expect(outputJoins.length).toBeGreaterThan(0);
      for (const join of outputJoins) expect((join['Actual Rows'] ?? 0) * (join['Actual Loops'] ?? 1)).toBeLessThanOrEqual(LIMIT);
    });

    test('every offset and cursor window returns the rows of the unpaged ordering', async () => {
      const all = await engine.searchKeywordPages(TERM, undefined, { limit: 1000 });
      expect(all.map(r => r.slug).sort()).toEqual([...matching].sort());
      for (let offset = 0; offset < all.length; offset += LIMIT) {
        expect(shape(await engine.searchKeywordPages(TERM, undefined, { limit: LIMIT, offset }))).toEqual(shape(all.slice(offset, offset + LIMIT)));
      }
      for (let at = 0; at + 1 < all.length; at += LIMIT) {
        const after = { score: Number(all[at]!.score), page_id: Number(all[at]!.page_id) };
        expect(shape(await engine.searchKeywordPages(TERM, undefined, { limit: LIMIT, after }))).toEqual(shape(all.slice(at + 1, at + 1 + LIMIT)));
      }
    });
  });
}
