/**
 * BrainEngine parity — search family (keyword, keyword paging, title arm,
 * vector, embedding hydration, chunk-grain keyword).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every search method returns the same ranked slugs (and the same
 *    rounded scores where the score is a pure function of the data) on every
 *    engine arm (PGLite always; Postgres with DATABASE_URL; a Rust arm later
 *    through test/engine-parity/harness.ts).
 *  - Regression: an engine whose keyword/vector ranking, filters (type, slug
 *    excludes, soft delete, quarantine), paging or AND-to-OR fallback drifts:
 *    `query` and `search` return different pages depending on the backend.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    without Postgres and compares only top slugs; it never pins filters,
 *    paging windows or hydration.
 *  - Seam: none for the cases. Typed methods only (no executeRaw: D18); the
 *    sealed-projection fixture goes through chunk-fixtures.ts (see its header).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { basisEmbedding, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks, seedPage } from './chunk-fixtures.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

/** Order-significant, engine-independent view of a result row. */
function hit(r: SearchResult) {
  return { slug: r.slug, chunk_index: r.chunk_index, type: r.type, title: r.title, source_id: r.source_id };
}

/** Scores that are a pure function of the seeded data, rounded so float noise cannot split arms. */
const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Unit vector pair mix: `cos` on axis `a`, the rest on axis `b`. */
function mix(a: number, cos: number, b: number): Float32Array {
  const e = new Float32Array(1536);
  e[a] = cos;
  e[b] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return e;
}

async function seedCorpus(engine: BrainEngine): Promise<void> {
  await seedPage(engine, {
    slug: 'originals/talks/article-outline-fat-code',
    input: { type: 'writing', title: 'Fat Code Thin Harness — Part 3', compiled_truth: 'fat code thin harness pattern part 3 production case studies', timeline: '' },
    chunks: [chunk(0, 'fat code thin harness pattern part 3 production case studies', { embedding: basisEmbedding(7) })],
  });
  await seedPage(engine, {
    slug: 'concepts/fat-code-thin-harness',
    input: { type: 'concept', title: 'Fat Code Thin Harness', compiled_truth: 'reusable concept fat code thin harness architecture', timeline: '' },
    chunks: [chunk(0, 'reusable concept fat code thin harness architecture', { embedding: basisEmbedding(14) })],
  });
  const swamp = (day: string, axis: number) => ({
    slug: `openclaw/chat/2026-04-${day}`,
    input: {
      type: 'note' as const,
      title: `2026-04-${day} chat`,
      compiled_truth: 'fat code thin harness fat code thin harness discussion went on at length, fat code thin harness fat code thin harness.',
      timeline: '',
    },
    chunks: [chunk(0, 'fat code thin harness fat code thin harness discussion went on at length, fat code thin harness fat code thin harness.', { embedding: basisEmbedding(axis) })],
  });
  await seedPage(engine, swamp('15', 8));
  await seedPage(engine, swamp('16', 9));
  await seedPage(engine, {
    slug: 'people/example-founder',
    input: { type: 'person', title: 'Example Founder', compiled_truth: 'example founder unrelated content for distraction', timeline: '' },
    chunks: [chunk(0, 'example founder unrelated content for distraction', { embedding: basisEmbedding(50) })],
  });
  await seedPage(engine, {
    slug: 'notes/zephyr-handbook',
    input: { type: 'note', title: 'Zephyr Quartz Handbook', compiled_truth: 'plain words about nothing in particular', timeline: '' },
    chunks: [chunk(0, 'plain words about nothing in particular', { embedding: basisEmbedding(60) })],
  });
}

describe('engine parity: search', () => {
  parityTest(
    'searchKeyword ranks the same pages for the same query',
    { methods: ['searchKeyword'] },
    async (engine) => {
      await seedCorpus(engine);
      const out: Record<string, unknown> = {};
      for (const q of ['fat code thin harness', 'fat code thin harness part 3', 'fat code production', 'distraction', 'nonexistentwordzzz']) {
        const rows = await engine.searchKeyword(q, { limit: 5 });
        out[q] = rows.map((r) => ({ ...hit(r), score: round(r.score) }));
      }
      const top = (out['fat code thin harness part 3'] as Array<{ slug: string }>)[0]!;
      expect(top.slug).toBe('originals/talks/article-outline-fat-code');
      expect(out['nonexistentwordzzz']).toEqual([]);
      expect((out['distraction'] as unknown[]).length).toBe(1);
      return out;
    },
  );

  parityTest(
    'searchKeyword honors limit, offset, type, types and slug excludes',
    { methods: ['searchKeyword'] },
    async (engine) => {
      await seedCorpus(engine);
      const q = 'fat code thin harness';
      const slugs = async (opts: Parameters<BrainEngine['searchKeyword']>[1]) => (await engine.searchKeyword(q, opts)).map((r) => r.slug);
      const all = await slugs({ limit: 10 });
      expect(all).toContain('concepts/fat-code-thin-harness');
      expect(all.length).toBe(4);
      const limited = await slugs({ limit: 2 });
      const offset = await slugs({ limit: 2, offset: 2 });
      expect([...limited, ...offset]).toEqual(all);
      const excluded = await slugs({ limit: 10, exclude_slugs: ['concepts/fat-code-thin-harness'] });
      expect(excluded).not.toContain('concepts/fat-code-thin-harness');
      const prefixExcluded = await slugs({ limit: 10, exclude_slug_prefixes: ['openclaw/'] });
      expect(prefixExcluded.some((s) => s.startsWith('openclaw/'))).toBe(false);
      const typed = (await engine.searchKeyword(q, { limit: 10, type: 'concept' })).map((r) => r.type);
      expect(typed).toEqual(['concept']);
      const multiType = sorted((await engine.searchKeyword(q, { limit: 10, types: ['concept', 'writing'] })).map((r) => r.type));
      expect(multiType).toEqual(['concept', 'writing']);
      return { all, limited, offset, excluded, prefixExcluded, typed, multiType };
    },
  );

  parityTest(
    'searchKeyword hides the prefixes GBRAIN_SEARCH_EXCLUDE names; include_slug_prefixes opts back in',
    { methods: ['searchKeyword'] },
    async (engine) => {
      await seedCorpus(engine);
      const q = 'fat code thin harness';
      const slugs = async (opts: Parameters<BrainEngine['searchKeyword']>[1]) => sorted((await engine.searchKeyword(q, opts)).map((r) => r.slug));
      const plain = await slugs({ limit: 10 });
      expect(plain.some((s) => s.startsWith('openclaw/'))).toBe(true);
      return withEnv({ GBRAIN_SEARCH_EXCLUDE: ' openclaw/ ,' }, async () => {
        const hidden = await slugs({ limit: 10 });
        expect(hidden.some((s) => s.startsWith('openclaw/'))).toBe(false);
        const optedIn = await slugs({ limit: 10, include_slug_prefixes: ['openclaw/'] });
        expect(optedIn).toEqual(plain);
        return { plain, hidden, optedIn };
      });
    },
  );

  parityTest(
    'searchKeyword hides soft-deleted, quarantined and hard-excluded pages; include_slug_prefixes opts back in',
    { methods: ['searchKeyword', 'softDeletePage', 'restorePage'] },
    async (engine) => {
      const body = 'glimmerwort marker phrase';
      const page = (title: string, frontmatter?: Record<string, unknown>) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '', ...(frontmatter ? { frontmatter } : {}) });
      await seedPage(engine, { slug: 'notes/visible', input: page('Visible'), chunks: [chunk(0, body)] });
      await seedPage(engine, { slug: 'notes/gone', input: page('Gone'), chunks: [chunk(0, body)] });
      await seedPage(engine, { slug: 'notes/quarantined', input: page('Quarantined', { quarantine: { reason: 'junk' } }), chunks: [chunk(0, body)] });
      await seedPage(engine, { slug: 'test/hard-excluded', input: page('Hard excluded'), chunks: [chunk(0, body)] });
      await engine.softDeletePage('notes/gone');

      const slugs = async (opts?: Parameters<BrainEngine['searchKeyword']>[1]) => sorted((await engine.searchKeyword('glimmerwort', opts)).map((r) => r.slug));
      const defaults = await slugs();
      const optedIn = await slugs({ include_slug_prefixes: ['test/'] });
      await engine.restorePage('notes/gone');
      // A restored page's text projection is unsealed until it is re-indexed: search skips it, then serves it again.
      const restoredUnsealed = await slugs();
      await installChunks(engine, 'notes/gone', [chunk(0, body)]);
      const restored = await slugs();
      expect(defaults).toEqual(['notes/visible']);
      expect(optedIn).toEqual(['notes/visible', 'test/hard-excluded']);
      expect(restoredUnsealed).toEqual(['notes/visible']);
      expect(restored).toEqual(['notes/gone', 'notes/visible']);
      return { defaults, optedIn, restoredUnsealed, restored };
    },
  );

  parityTest(
    'searchKeyword scopes by sourceId and sourceIds',
    { methods: ['searchKeyword'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const body = 'tangerine ledger entry';
      await seedPage(engine, { slug: 'notes/ledger-default', input: { type: 'note', title: 'Ledger default', compiled_truth: body, timeline: '' }, chunks: [chunk(0, body)] });
      await seedPage(engine, { slug: 'notes/ledger-work', input: { type: 'note', title: 'Ledger work', compiled_truth: body, timeline: '' }, chunks: [chunk(0, body)] }, { sourceId: 'work' });
      const view = async (opts?: Parameters<BrainEngine['searchKeyword']>[1]) => sorted((await engine.searchKeyword('tangerine', opts)).map((r) => `${r.source_id}:${r.slug}`));
      const unscoped = await view();
      const defaultOnly = await view({ sourceId: 'default' });
      const workOnly = await view({ sourceId: 'work' });
      const federated = await view({ sourceIds: ['default', 'work'] });
      const none = await view({ sourceId: 'no-such-source' });
      expect(unscoped).toEqual(['default:notes/ledger-default', 'work:notes/ledger-work']);
      expect(defaultOnly).toEqual(['default:notes/ledger-default']);
      expect(workOnly).toEqual(['work:notes/ledger-work']);
      expect(none).toEqual([]);
      return { unscoped, defaultOnly, workOnly, federated, none };
    },
  );

  parityTest(
    'searchKeyword orFallback retries with OR terms and tags the rows keyword_relaxed',
    { methods: ['searchKeyword'] },
    async (engine) => {
      await seedCorpus(engine);
      // 'studies' lives only in the article page, 'distraction' only in the founder page: no chunk has both.
      const q = 'studies distraction';
      const strict = await engine.searchKeyword(q, { limit: 5 });
      const relaxed = await engine.searchKeyword(q, { limit: 5, orFallback: true });
      expect(strict).toEqual([]);
      expect(relaxed.length).toBe(2);
      expect(relaxed.every((r) => r.keyword_relaxed === true)).toBe(true);
      // A strict hit wins: no relaxed rows when the AND query matches.
      const strictWins = await engine.searchKeyword('fat code', { limit: 5, orFallback: true });
      expect(strictWins.length).toBeGreaterThan(0);
      expect(strictWins.some((r) => r.keyword_relaxed === true)).toBe(false);
      return { strict: strict.length, relaxed: sorted(relaxed.map((r) => r.slug)), strictWins: strictWins.map((r) => r.slug) };
    },
  );

  parityTest(
    'countKeywordPages and searchKeywordPages page through strict keyword matches',
    { methods: ['countKeywordPages', 'searchKeywordPages'] },
    async (engine) => {
      await seedCorpus(engine);
      const q = 'fat code thin harness';
      const count = await engine.countKeywordPages(q);
      const miss = await engine.countKeywordPages('nonexistentwordzzz');
      const typedCount = await engine.countKeywordPages(q, { type: 'concept' });
      expect({ count, miss, typedCount }).toEqual({ count: 4, miss: 0, typedCount: 1 });

      const everything = await engine.searchKeywordPages(q, undefined, { limit: 10 });
      const slugsOf = (rows: SearchResult[]) => rows.map((r) => r.slug);
      expect(everything.length).toBe(4);
      // Keyset order is (score DESC, page_id ASC): offset windows partition it, `after` resumes from a row.
      const first = await engine.searchKeywordPages(q, undefined, { limit: 2 });
      const second = await engine.searchKeywordPages(q, undefined, { limit: 2, offset: 2 });
      expect([...slugsOf(first), ...slugsOf(second)]).toEqual(slugsOf(everything));
      const resumed = await engine.searchKeywordPages(q, undefined, { limit: 10, after: { score: first[1]!.score, page_id: first[1]!.page_id } });
      expect(slugsOf(resumed)).toEqual(slugsOf(everything).slice(2));
      const typed = await engine.searchKeywordPages(q, { type: 'writing' }, { limit: 10 });
      expect(slugsOf(typed)).toEqual(['originals/talks/article-outline-fat-code']);
      return { count, miss, typedCount, everything: slugsOf(everything), first: slugsOf(first), second: slugsOf(second), resumed: slugsOf(resumed), typed: slugsOf(typed) };
    },
  );

  parityTest(
    'searchKeywordChunks returns chunk-grain rows where searchKeyword returns one row per page',
    { methods: ['searchKeyword', 'searchKeywordChunks'] },
    async (engine) => {
      await seedPage(engine, {
        slug: 'notes/many-chunks',
        input: { type: 'note', title: 'Many chunks', compiled_truth: 'x', timeline: '' },
        chunks: [chunk(0, 'quasar one in the first chunk'), chunk(1, 'nothing relevant here'), chunk(2, 'quasar two in the third chunk')],
      });
      await seedPage(engine, {
        slug: 'notes/one-chunk',
        input: { type: 'note', title: 'One chunk', compiled_truth: 'x', timeline: '' },
        chunks: [chunk(0, 'a lone quasar')],
      });
      const pageGrain = await engine.searchKeyword('quasar', { limit: 10 });
      const chunkGrain = await engine.searchKeywordChunks('quasar', { limit: 10 });
      const key = (rows: SearchResult[]) => sorted(rows.map((r) => `${r.slug}#${r.chunk_index}`));
      expect(key(chunkGrain)).toEqual(['notes/many-chunks#0', 'notes/many-chunks#2', 'notes/one-chunk#0']);
      expect(sorted(pageGrain.map((r) => r.slug))).toEqual(['notes/many-chunks', 'notes/one-chunk']);
      return { pageGrain: sorted(pageGrain.map((r) => r.slug)), chunkGrain: key(chunkGrain) };
    },
  );

  parityTest(
    'searchTitles finds pages by title, falls back to relaxed OR, and honors filters',
    { methods: ['searchTitles'] },
    async (engine) => {
      await seedCorpus(engine);
      const view = (rows: SearchResult[]) => rows.map((r) => ({ slug: r.slug, relaxed: r.keyword_relaxed === true }));
      const exact = view(await engine.searchTitles('Zephyr Quartz Handbook', { limit: 5 }));
      expect(exact).toEqual([{ slug: 'notes/zephyr-handbook', relaxed: false }]);
      const strictTitle = sorted(view(await engine.searchTitles('fat code thin harness', { limit: 5 })), (r) => r.slug);
      expect(strictTitle.map((r) => r.slug)).toEqual(['concepts/fat-code-thin-harness', 'originals/talks/article-outline-fat-code']);
      // Title tokens that never share a title: strict recall is zero, the always-on OR fallback fires and tags rows.
      const relaxed = sorted(view(await engine.searchTitles('outline founder', { limit: 5 })), (r) => r.slug);
      expect(relaxed.length).toBeGreaterThan(0);
      expect(relaxed.every((r) => r.relaxed)).toBe(true);
      const typed = view(await engine.searchTitles('fat code thin harness', { limit: 5, type: 'concept' }));
      expect(typed.map((r) => r.slug)).toEqual(['concepts/fat-code-thin-harness']);
      const excluded = view(await engine.searchTitles('fat code thin harness', { limit: 5, exclude_slugs: ['concepts/fat-code-thin-harness'] }));
      const none = await engine.searchTitles('qqqqzzzz', { limit: 5 });
      expect(none).toEqual([]);
      return { exact, strictTitle, relaxed, typed, excluded, none };
    },
  );

  parityTest(
    'searchVector ranks by cosine similarity and applies filters and paging',
    { methods: ['searchVector'] },
    async (engine) => {
      await seedCorpus(engine);
      const rank = async (query: Float32Array, opts?: Parameters<BrainEngine['searchVector']>[1]) =>
        (await engine.searchVector(query, { limit: 5, ...opts })).map((r) => ({ slug: r.slug, score: round(r.score) }));
      const article = await rank(basisEmbedding(7));
      expect(article[0]!.slug).toBe('originals/talks/article-outline-fat-code');
      // 0.8 on the article axis, 0.6 on the concept axis: article first, concept second, in that exact order.
      const blended = await rank(mix(7, 0.8, 14));
      expect(blended.slice(0, 2).map((r) => r.slug)).toEqual(['originals/talks/article-outline-fat-code', 'concepts/fat-code-thin-harness']);
      const limited = await rank(mix(7, 0.8, 14), { limit: 1 });
      const paged = await rank(mix(7, 0.8, 14), { limit: 1, offset: 1 });
      expect(paged.map((r) => r.slug)).toEqual([blended[1]!.slug]);
      const typed = await rank(mix(7, 0.8, 14), { type: 'concept' });
      expect(typed.map((r) => r.slug)).toEqual(['concepts/fat-code-thin-harness']);
      const excluded = await rank(basisEmbedding(7), { exclude_slugs: ['originals/talks/article-outline-fat-code'] });
      expect(excluded.some((r) => r.slug === 'originals/talks/article-outline-fat-code')).toBe(false);
      const detail = (await engine.searchVector(basisEmbedding(14), { limit: 3, detail: 'high' })).map((r) => r.slug);
      expect(detail[0]).toBe('concepts/fat-code-thin-harness');
      return { article, blended, limited, paged, typed, excluded, detail };
    },
  );

  parityTest(
    'searchVector: a dense page cannot starve the page-grain result',
    { methods: ['searchVector'] },
    async (engine) => {
      // One page with 120 chunks nearest the query plus 8 sparse pages behind it: the page-grain collapse
      // must still return `limit` distinct pages.
      const denseDim = 900;
      await seedPage(engine, {
        slug: 'notes/parity-dense',
        input: { type: 'note', title: 'Parity Dense', compiled_truth: 'd.', timeline: '' },
        chunks: Array.from({ length: 120 }, (_, i) => chunk(i, `pd ${i}`, { embedding: mix(denseDim, 0.99 - i * 0.0005, 1000 + i), token_count: 2 })),
      });
      for (let p = 0; p < 8; p++) {
        await seedPage(engine, {
          slug: `notes/parity-sparse-${p}`,
          input: { type: 'note', title: `Parity Sparse ${p}`, compiled_truth: 's.', timeline: '' },
          chunks: [chunk(0, `ps ${p}`, { embedding: mix(denseDim, 0.6 - p * 0.001, 1200 + p), token_count: 2 })],
        });
      }
      const rows = await engine.searchVector(basisEmbedding(denseDim), { limit: 6, detail: 'high' });
      const slugs = rows.map((r) => r.slug);
      expect(new Set(slugs).size).toBe(6);
      expect(slugs[0]).toBe('notes/parity-dense');
      return { slugs };
    },
  );

  parityTest(
    'getEmbeddingsByChunkIds returns stored vectors keyed by chunk id',
    { methods: ['putPage', 'getChunks', 'getEmbeddingsByChunkIds'] },
    async (engine) => {
      await engine.putPage('notes/hydrate', { type: 'note', title: 'Hydrate', compiled_truth: 'x', timeline: '' });
      await installChunks(engine, 'notes/hydrate', [
        chunk(0, 'hydrate zero', { embedding: basisEmbedding(21) }),
        chunk(1, 'hydrate one'),
        chunk(2, 'hydrate two', { embedding: basisEmbedding(23) }),
      ]);
      const chunks = await engine.getChunks('notes/hydrate');
      const indexOf = new Map(chunks.map((c) => [c.id, c.chunk_index]));
      const vectors = await engine.getEmbeddingsByChunkIds(chunks.map((c) => c.id));
      const hotAxis = (v: Float32Array) => v.findIndex((x) => x === 1);
      const byIndex = sorted([...vectors].map(([id, v]) => ({ chunk_index: indexOf.get(id)!, axis: hotAxis(v), dims: v.length })), (r) => String(r.chunk_index));
      expect(byIndex).toEqual([{ chunk_index: 0, axis: 21, dims: 1536 }, { chunk_index: 2, axis: 23, dims: 1536 }]);
      const named = await engine.getEmbeddingsByChunkIds([chunks[0]!.id], 'embedding');
      expect(named.size).toBe(1);
      const empty = await engine.getEmbeddingsByChunkIds([]);
      expect(empty.size).toBe(0);
      return { byIndex, namedSize: named.size, emptySize: empty.size };
    },
  );
});
