/**
 * #4603 — keyword-arm tiebreaker (`ORDER BY score DESC, page_id ASC, chunk_id ASC`)
 * executed against a real PGLite. The structural regex test pins the line
 * shape; this pins that the aliases RESOLVE at every keyword ORDER BY level
 * (a bad alias is a runtime SQL error the regex cannot see) and that a
 * LIMIT / OFFSET cut into a score-tied group is a stable, page_id-ascending
 * prefix.
 *
 * Exercises: pglite-engine.ts searchKeyword (inner `ranked` CTE + the
 * best_per_page outer), searchKeywordChunks (plain path), and both branches
 * of the shared cjk-keyword-sql.ts builder via the PGLite CJK dispatch. The
 * postgres-engine.ts sites are the same SQL shape but only run under
 * DATABASE_URL (test/e2e/engine-parity.test.ts).
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// Slugs in REVERSE order of insertion so slug order (what the DISTINCT ON
// pool sorts by) and page_id order disagree — only the page_id tiebreaker
// yields ascending ids.
const SLUGS = ['tie/f', 'tie/e', 'tie/d', 'tie/c', 'tie/b', 'tie/a'];
const ASCII = 'quorumfrog gathers at dusk near the reservoir';
const CJK = '東京会議の議事録を共有します';

let engine: PGLiteEngine;
let sortedIds: number[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const chunks = [
    { chunk_index: 0, chunk_text: ASCII, chunk_source: 'compiled_truth' as const },
    { chunk_index: 1, chunk_text: CJK, chunk_source: 'compiled_truth' as const },
  ];
  for (const slug of SLUGS) {
    await engine.putPage(slug, { type: 'note', title: `Tie ${slug}`, compiled_truth: 'placeholder', timeline: '' });
    await engine.upsertChunks(slug, chunks);
  }
  // Re-upsert the two lowest-id pages so their chunk tuples move to the END
  // of the heap: a bare `ORDER BY score DESC` over a seqscan would emit them
  // last, not first.
  for (const slug of ['tie/f', 'tie/d']) await engine.upsertChunks(slug, chunks);

  const ids: number[] = [];
  for (const slug of SLUGS) ids.push((await engine.getPage(slug, { sourceId: 'default' }))!.id);
  sortedIds = [...ids].sort((a, b) => a - b);
  expect(new Set(sortedIds).size).toBe(SLUGS.length);
});

afterAll(async () => { await engine.disconnect(); }, 30_000);

const pageIds = (rows: { page_id: number }[]) => rows.map(r => r.page_id);
const expectTied = (rows: { score: number }[]) => expect(new Set(rows.map(r => r.score)).size).toBe(1);

// One test, both arms (ASCII ts_rank + CJK ILIKE), every keyword ORDER BY level.
test('#4603 keyword arms: score ties order by page_id ASC; LIMIT/OFFSET cuts are stable prefixes', async () => {
  for (const query of ['quorumfrog', '東京会議']) {
    // searchKeyword: inner `ranked` CTE + best_per_page outer.
    const rows = await engine.searchKeyword(query, { limit: 50 });
    expectTied(rows);
    expect(pageIds(rows)).toEqual(sortedIds);
    // limit 1 → innerLimit 3 < 6 tied chunks, so the inner CTE cut is exercised too.
    expect(pageIds(await engine.searchKeyword(query, { limit: 1 }))).toEqual(sortedIds.slice(0, 1));
    expect(pageIds(await engine.searchKeyword(query, { limit: 4 }))).toEqual(sortedIds.slice(0, 4));
    const paged: number[] = [];
    for (let offset = 0; offset < SLUGS.length; offset += 2) {
      paged.push(...pageIds(await engine.searchKeyword(query, { limit: 2, offset })));
    }
    expect(paged).toEqual(sortedIds);
    // searchKeywordChunks: plain (un-pooled) path.
    const all = await engine.searchKeywordChunks(query, { limit: 50 });
    expectTied(all);
    expect(pageIds(all)).toEqual(sortedIds);
    expect(pageIds(await engine.searchKeywordChunks(query, { limit: 3 }))).toEqual(sortedIds.slice(0, 3));
    expect(pageIds(await engine.searchKeywordChunks(query, { limit: 3, offset: 3 }))).toEqual(sortedIds.slice(3));
  }
});
