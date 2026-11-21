/**
 * BrainEngine parity — keyword search over a CJK query (the substring fallback).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a query with CJK characters skips full-text search on every arm. searchKeyword and
 *    searchKeywordChunks run engine-sql/cjk-search.ts (strict AND of the match terms, the OR fallback,
 *    the term-count + raw-query bonus + position score, best chunk per page), and countKeywordPages,
 *    searchKeywordPages and searchTitles match the same terms. Every arm returns the same rows and scores.
 *  - Regression: an engine that refuses a CJK query, ranks it by a different formula, folds case
 *    differently, keeps Korean particles, or drops the filters returns other pages for a Japanese,
 *    Chinese or Korean search depending on the backend.
 *  - Why existing coverage misses it: test/cjk-keyword-fallback.test.ts and test/cjk-keyword-sql.test.ts
 *    run PGLite only; search.test.ts uses English queries.
 *  - Seam: none. Typed methods only; seeding goes through chunk-fixtures.ts. The bounded arm
 *    (`cjkKeyword`) stays in the Rust unit tests and test/cjk-keyword-fallback.test.ts: Postgres bounds
 *    it by a deadline, PGLite and Rust by a chunk count.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const view = (rows: SearchResult[]) => rows.map((r) => ({ slug: r.slug, chunk_index: r.chunk_index, type: r.type, score: round(r.score) }));

async function seedCorpus(engine: BrainEngine): Promise<void> {
  const page = (slug: string, type: 'note' | 'concept', title: string, texts: string[]) =>
    seedPage(engine, {
      slug,
      input: { type, title, compiled_truth: texts.join('\n\n'), timeline: '' },
      chunks: texts.map((t, i) => chunk(i, t)),
    });
  await page('notes/tokyo-osaka', 'note', '東京と大阪', ['東京と大阪の旅行。東京は大きい。', '大阪の食べ物']);
  await page('notes/tokyo', 'note', '東京タワー', ['東京タワーの話。東京 大阪 の比較はない。']);
  await page('notes/osaka', 'note', '大阪城', ['大阪城の話', '大阪 大阪 大阪']);
  await page('concepts/tokyo-guide', 'concept', '東京ガイド', ['東京 大阪 ガイド']);
  await page('notes/seoul', 'note', '서울 회의', ['서울 회의 메모', '혈당 수치 기록']);
  await page('notes/mixed-case', 'note', 'Tokyo東京', ['Tokyo東京 guide', 'tokyo東京 notes']);
  await page('notes/english', 'note', 'English only', ['plain words about nothing']);
}

describe('engine parity: CJK keyword search', () => {
  parityTest(
    'searchKeyword ranks CJK queries with the strict AND, the score formula and best chunk per page',
    { methods: ['searchKeyword'] },
    async (engine) => {
      await seedCorpus(engine);
      const out: Record<string, unknown> = {};
      for (const q of ['東京', '東京 大阪', '大阪', '城', '存在しない']) {
        out[q] = view(await engine.searchKeyword(q, { limit: 10 }));
      }
      expect((out['東京 大阪'] as { slug: string }[]).map((r) => r.slug)).not.toContain('notes/osaka');
      expect(out['存在しない']).toEqual([]);
      return out;
    },
  );

  parityTest(
    'searchKeyword honors limit, offset, type and slug excludes on a CJK query',
    { methods: ['searchKeyword'] },
    async (engine) => {
      await seedCorpus(engine);
      const q = '東京';
      const slugs = async (opts: Parameters<BrainEngine['searchKeyword']>[1]) => (await engine.searchKeyword(q, opts)).map((r) => r.slug);
      const all = await slugs({ limit: 10 });
      const limited = await slugs({ limit: 2 });
      const offset = await slugs({ limit: 2, offset: 2 });
      expect([...limited, ...offset]).toEqual(all.slice(0, 4));
      const typed = await slugs({ limit: 10, type: 'concept' });
      expect(typed).toEqual(['concepts/tokyo-guide']);
      const excluded = await slugs({ limit: 10, exclude_slugs: ['notes/tokyo'] });
      expect(excluded).not.toContain('notes/tokyo');
      const prefixExcluded = await slugs({ limit: 10, exclude_slug_prefixes: ['notes/'] });
      return { all, limited, offset, typed, excluded, prefixExcluded };
    },
  );

  parityTest(
    'searchKeyword takes the OR fallback only when asked and the strict rows fall short',
    { methods: ['searchKeyword'] },
    async (engine) => {
      await seedCorpus(engine);
      const q = '大阪城 タワー';
      const strict = view(await engine.searchKeyword(q, { limit: 10 }));
      expect(strict).toEqual([]);
      const any = view(await engine.searchKeyword(q, { limit: 10, orFallback: true }));
      expect(sorted(any.map((r) => r.slug))).toEqual(['notes/osaka', 'notes/tokyo']);
      // One term: no fallback, even when asked.
      const single = view(await engine.searchKeyword('城タワー', { limit: 10, orFallback: true }));
      expect(single).toEqual([]);
      const filled = view(await engine.searchKeyword('東京 大阪', { limit: 10, orFallback: true }));
      return { strict, any, single, filled };
    },
  );

  parityTest(
    'searchKeyword strips Korean particles and folds the case of a mixed-script term',
    { methods: ['searchKeyword'] },
    async (engine) => {
      await seedCorpus(engine);
      const korean = view(await engine.searchKeyword('혈당에서', { limit: 10 }));
      expect(korean.map((r) => r.slug)).toEqual(['notes/seoul']);
      const mixed = view(await engine.searchKeyword('TOKYO東京', { limit: 10 }));
      expect(mixed.map((r) => r.slug)).toEqual(['notes/mixed-case']);
      return { korean, mixed };
    },
  );

  parityTest(
    'searchKeywordChunks returns every matching chunk of a CJK query',
    { methods: ['searchKeywordChunks'] },
    async (engine) => {
      await seedCorpus(engine);
      const out: Record<string, unknown> = {};
      for (const q of ['大阪', '東京 大阪', 'tokyo東京']) {
        out[q] = view(await engine.searchKeywordChunks(q, { limit: 20 }));
      }
      const osaka = (out['大阪'] as { slug: string }[]).filter((r) => r.slug === 'notes/osaka');
      expect(osaka.length).toBe(2);
      out.window = view(await engine.searchKeywordChunks('大阪', { limit: 2, offset: 1 }));
      return out;
    },
  );

  parityTest(
    'countKeywordPages and searchKeywordPages match every CJK term',
    { methods: ['countKeywordPages', 'searchKeywordPages'] },
    async (engine) => {
      await seedCorpus(engine);
      const out: Record<string, unknown> = {};
      for (const q of ['東京', '東京 大阪', '혈당에서', '存在しない']) {
        out[q] = {
          count: await engine.countKeywordPages(q),
          pages: view(await engine.searchKeywordPages(q, undefined, { limit: 10 })),
        };
      }
      expect((out['存在しない'] as { count: number }).count).toBe(0);
      out.window = view(await engine.searchKeywordPages('東京', undefined, { limit: 2, offset: 1 }));
      out.typed = await engine.countKeywordPages('東京', { type: 'concept' });
      return out;
    },
  );

  parityTest(
    'searchTitles finds CJK titles',
    { methods: ['searchTitles'] },
    async (engine) => {
      await seedCorpus(engine);
      const out: Record<string, unknown> = {};
      for (const q of ['東京', '大阪城', '서울']) {
        out[q] = sorted((await engine.searchTitles(q, { limit: 20 })).map((r) => r.slug));
      }
      return out;
    },
  );
});

