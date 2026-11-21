/**
 * #9922: the legacy page-grain keyword arm must retain the skipped prefix
 * before applying OFFSET, including the operator's mcp_keyword_only route.
 * Existing keyword-paging tests exercise searchKeywordPages (match: keyword),
 * not this arm. A limit-only inner pool loses page four and truncates page
 * three. Real indexed corpora exercise ASCII/CJK, chunk dedup and scoped
 * remote filtering on both engines; no new production seam is needed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { callSearch, seedPage } from '../helpers/keyword-paging-fixture.ts';
import { searchKeyword as rustKeyword } from '../../src/core/rust-engine/store-members/keyword.ts';

const LIMIT = 4;
const COUNT = 35;
const shape = (rows: Array<{ slug: string; chunk_id?: number; score: number }>) => rows.map(r => [r.slug, r.chunk_id, Number(r.score)]);

test('Rust adapter retains the offset prefix without raising the per-call result cap', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const brain = {
    async searchKeywordArm(_match: string, _rank: string, options: Record<string, unknown>) {
      calls.push(options);
      return [];
    },
  } as unknown as Parameters<typeof rustKeyword>[0];
  for (const [limit, offset, expectedLimit, expectedInner] of [[4, 0, 4, 12], [4, 350, 4, 362], [1000, 350, 100, 650]]) {
    expect(await rustKeyword(brain, 'zebrafish', { limit, offset })).toEqual([]);
    expect(calls.at(-1)).toMatchObject({ limit: expectedLimit, offset, innerLimit: expectedInner });
  }
  expect(calls.length).toBe(3);
});

for (const kind of testBackends()) {
  describe(`legacy keyword offset window (${kind}, #9922)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      for (let i = 0; i < COUNT; i++) {
        await seedPage(engine, `notes/window-${i}`, 'Zebrafish survey 血糖 observations.', { type: i % 2 ? 'meeting' : 'note' });
      }
      await seedPage(engine, 'notes/private-window', 'Zebrafish survey 血糖 observations.', { frontmatter: { visibility: 'private' } });
      await seedPage(engine, 'notes/deleted-window', 'Zebrafish survey 血糖 observations.');
      await engine.softDeletePage('notes/deleted-window', { sourceId: 'default' });
      // Hundreds of chunks must not consume the distinct-page prefix.
      await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality)
        SELECT cc.page_id, cc.chunk_index + g, cc.chunk_text, cc.chunk_source, cc.modality
        FROM content_chunks cc JOIN pages p ON p.id = cc.page_id, generate_series(1, 40) g
        WHERE p.slug = 'notes/window-0' AND cc.chunk_index = 0`);
      await engine.setConfig('search.mcp_keyword_only', 'true');
    }, 180_000);
    afterAll(async () => { await close?.(); });

    for (const query of ['zebrafish', '血糖']) {
      test(`${query}: all offset windows equal slices of the unpaged ranking`, async () => {
        const opts = { sourceId: 'default', excludePrivate: true, requireSafeChunks: true };
        const all = await engine.searchKeyword(query, { ...opts, limit: 100 });
        expect(all.length).toBe(COUNT);
        const walked: string[] = [];
        for (let offset = 0; offset <= COUNT + LIMIT; offset += LIMIT) {
          const rows = await engine.searchKeyword(query, { ...opts, limit: LIMIT, offset });
          expect(shape(rows)).toEqual(shape(all.slice(offset, offset + LIMIT)));
          walked.push(...rows.map(r => r.slug));
        }
        expect(new Set(walked).size).toBe(COUNT);
        expect(walked).toEqual(all.map(r => r.slug));
      });

      test(`${query}: keyword-only operation returns later scoped/type-filtered pages`, async () => {
        const opts = { sourceId: 'default', types: ['meeting'], excludePrivate: true, requireSafeChunks: true };
        const all = await engine.searchKeyword(query, { ...opts, limit: 100 });
        expect(all.length).toBe(Math.floor(COUNT / 2));
        for (const offset of [0, LIMIT * 2, LIMIT * 3, LIMIT * 4, 100]) {
          const result = await callSearch(engine, { query, limit: LIMIT, offset, types: ['meeting'] });
          expect(result.rows.map(r => r.slug)).toEqual(all.slice(offset, offset + LIMIT).map(r => r.slug));
          expect(result.rows.every(r => r.type === 'meeting')).toBe(true);
          expect(result.retrieval.keyword_total).toBe(all.length);
        }
      });
    }
  });
}
