/**
 * Engine parity — CJK keyword parity pins (test-gap plan D4).
 *
 * HISTORY: this suite originally pinned a DOCUMENTED DEGRADATION — the
 * Postgres engine had no CJK branch (websearch_to_tsquery can't segment
 * unsegmented CJK) while PGLite's ILIKE + term-frequency branch found the
 * pages. Master's #3986 closed the gap exactly as the pins anticipated:
 * both engines now route hasCJK() queries through the SHARED SQL builder
 * (src/core/search/cjk-keyword-sql.ts; engine wrappers in each engine's
 * cjk-search.ts). Per the original pins' own flip instructions, the
 * PINNED-GAP assertions are now PARITY assertions, and the locale-regime
 * probe is gone — the ILIKE branch is locale-independent.
 *
 *   - If someone breaks either engine's CJK branch, its arm goes red.
 *   - If the branches drift apart (ranking, AND semantics, chunk-grain
 *     routing), the cross-engine comparisons go red.
 *
 * NOT duplicated from test/cjk.test.ts (pure helpers), test/e2e/
 * cjk-roundtrip.test.ts (PGLite-only pipeline), sync-cjk-git.test.ts (sync
 * path), or engine-parity.test.ts's #3986 block (top-slug parity on its own
 * corpus). The delta here is the richer CROSS-ENGINE matrix on an identical
 * corpus: per-query top-slug agreement, chunk-grain parity, mixed-query AND
 * semantics, and the nonexistent-term strictness pin.
 *
 * Gated by DATABASE_URL like engine-parity.test.ts — skips without a real
 * Postgres (the PGLite-only half is already covered by cjk-roundtrip).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

const JA_SLUG = 'originals/cjk-parity-ja';
const ZH_SLUG = 'originals/cjk-parity-zh';
const MIXED_SLUG = 'originals/cjk-parity-mixed';
const ASCII_SLUG = 'originals/cjk-parity-ascii';

// Seeding shape reused from test/e2e/cjk-roundtrip.test.ts (importFromContent
// with noEmbed — exercises the real chunker + search_vector population).
//
// CORPUS SHAPE (kept from the pre-#3986 pin): the pure-CJK queries are
// substrings of unsegmented bodies, never standalone whitespace-delimited
// tokens — so parity here proves the SHARED ILIKE branch, not accidental
// FTS tokenization. The mixed page deliberately uses a different CJK term
// (検索) for the same reason.
const SEED_PAGES: Array<{ slug: string; title: string; body: string }> = [
  {
    slug: JA_SLUG,
    title: 'JA note',
    body: '多言語対応のシステムを再度検証します。今日は晴れです。明日は雨です。',
  },
  {
    slug: ZH_SLUG,
    title: 'ZH note',
    body: '这是一个测试文档。测试内容很重要。我们再次测试一下系统。',
  },
  {
    slug: MIXED_SLUG,
    title: 'Mixed note',
    body: 'The system uses 検索 framework for validation.',
  },
  {
    slug: ASCII_SLUG,
    title: 'ASCII note',
    body: 'NovaMind builds enterprise automation agents for production deployments.',
  },
];

async function seedEngine(eng: BrainEngine) {
  for (const p of SEED_PAGES) {
    const md = `---\ntype: concept\ntitle: ${p.title}\n---\n\n${p.body}`;
    const result = await importFromContent(eng, p.slug, md, { noEmbed: true });
    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(0);
  }
}

const slugsOf = (rs: SearchResult[]) => rs.map(r => r.slug);

// Pure-CJK queries: substrings of seeded bodies, never standalone tokens.
const CJK_QUERIES: Array<{ query: string; expectSlug: string }> = [
  { query: '多言語', expectSlug: JA_SLUG }, // Han (JA)
  { query: '晴れ', expectSlug: JA_SLUG },   // Han + Hiragana
  { query: '测试', expectSlug: ZH_SLUG },   // Han (ZH)
];

describeBoth('Engine parity — CJK keyword parity (#3986 shared branch)', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = await setupDB();
    await seedEngine(pgEngine);

    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
    await seedEngine(pgliteEngine);

  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  test('positive control: PGLite CJK branch finds the seeded pages (searchKeyword)', async () => {
    for (const { query, expectSlug } of CJK_QUERIES) {
      const hits = await pgliteEngine.searchKeyword(query, { limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].slug).toBe(expectSlug);
    }
  });

  test('positive control: PGLite CJK branch also serves searchKeywordChunks', async () => {
    const hits = await pgliteEngine.searchKeywordChunks('测试', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(slugsOf(hits)).toContain(ZH_SLUG);
  });

  test('PARITY (ex-pinned gap, closed by #3986): Postgres finds the same CJK pages (searchKeyword)', async () => {
    // The shared CJK branch (cjk-keyword-sql.ts) now serves both engines —
    // Postgres must agree with the PGLite positive controls per query.
    for (const { query, expectSlug } of CJK_QUERIES) {
      const pgHits = await pgEngine.searchKeyword(query, { limit: 5 });
      const pgliteHits = await pgliteEngine.searchKeyword(query, { limit: 5 });
      expect(pgHits.length).toBeGreaterThan(0);
      expect(pgHits[0].slug).toBe(expectSlug);
      expect(new Set(slugsOf(pgHits))).toEqual(new Set(slugsOf(pgliteHits)));
    }
  });

  test('PARITY (ex-pinned gap): chunk-grain searchKeywordChunks agrees across engines', async () => {
    const pgHits = await pgEngine.searchKeywordChunks('测试', { limit: 5 });
    const pgliteHits = await pgliteEngine.searchKeywordChunks('测试', { limit: 5 });
    expect(pgHits.length).toBeGreaterThan(0);
    expect(slugsOf(pgHits)).toContain(ZH_SLUG);
    expect(new Set(slugsOf(pgHits))).toEqual(new Set(slugsOf(pgliteHits)));
  });

  test('parity where parity exists: ASCII queries return the same results on both engines', async () => {
    // Includes an ASCII query that lands on a CJK-containing page — CJK
    // content must not break ASCII retrieval of the same page on either
    // engine.
    const asciiQueries: Array<{ query: string; expectSlug: string }> = [
      { query: 'enterprise automation', expectSlug: ASCII_SLUG },
      { query: 'framework validation', expectSlug: MIXED_SLUG },
    ];
    for (const { query, expectSlug } of asciiQueries) {
      const pgHits = await pgEngine.searchKeyword(query, { limit: 5 });
      const pgliteHits = await pgliteEngine.searchKeyword(query, { limit: 5 });
      expect(pgHits.length).toBeGreaterThan(0);
      expect(pgHits[0].slug).toBe(expectSlug);
      expect(pgliteHits[0].slug).toBe(expectSlug);
      expect(new Set(slugsOf(pgHits))).toEqual(new Set(slugsOf(pgliteHits)));
    }
  });

  test('mixed CJK+ASCII query: both engines find the mixed page (different mechanisms)', async () => {
    // PGLite: hasCJK('framework 検索') is true → CJK branch → AND-of-ILIKE
    // over whitespace terms ['framework', '検索'] → the mixed page contains
    // both substrings.
    const pgliteHits = await pgliteEngine.searchKeyword('framework 検索', { limit: 5 });
    expect(slugsOf(pgliteHits)).toEqual([MIXED_SLUG]);

    // Postgres now routes the same query through the shared CJK branch —
    // real support, same mechanism as PGLite (not the pre-#3986 coincidence
    // of locale-dependent tsquery behavior).
    const pgHits = await pgEngine.searchKeyword('framework 検索', { limit: 5 });
    expect(slugsOf(pgHits)).toEqual([MIXED_SLUG]);
  });

  test('PARITY (ex-pinned gap): strict AND semantics — a nonexistent CJK term empties BOTH engines', async () => {
    // '存在しない語' appears nowhere in the corpus. The shared CJK branch
    // has strict AND semantics over every whitespace term on both engines,
    // locale-independent (pre-#3986 Postgres diverged BY LOCALE REGIME here
    // — silently dropping the CJK term under the C locale and returning a
    // false positive; that divergence is the gap #3986 closed).
    const pgliteHits = await pgliteEngine.searchKeyword('framework 存在しない語', { limit: 5 });
    expect(pgliteHits).toEqual([]);
    const pgHits = await pgEngine.searchKeyword('framework 存在しない語', { limit: 5 });
    expect(pgHits).toEqual([]);
  });
});
