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
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { basisEmbedding, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks, seedPage } from './chunk-fixtures.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest, arms } = parityArms(testBackends());

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
  parityTest(
    'keyword pages and chunks agree on scores, phrase and handle boosts, where, dates, sources and boosts',
    { methods: ['countKeywordPages', 'searchKeywordPages', 'searchKeywordChunks'] },
    async (engine, backend) => {
      const day = (iso: string) => new Date(iso);
      await seedPage(engine, {
        slug: 'notes/nebula-drive',
        input: { type: 'note', title: 'Nebula drive', compiled_truth: 'x', timeline: '', frontmatter: { status: 'active', rank: 3 }, effective_date: day('2026-03-01T00:00:00Z'), effective_date_source: 'date' },
        chunks: [chunk(0, 'the nebula drive hums near the core'), chunk(1, 'drive nebula backwards for the drive test')],
      });
      await seedPage(engine, {
        slug: 'notes/drive-log',
        input: { type: 'note', title: 'Drive log', compiled_truth: 'x', timeline: '', frontmatter: { status: ['draft', 'active'] }, effective_date: day('2026-05-10T12:00:00Z'), effective_date_source: 'date' },
        chunks: [chunk(0, 'nebula readings and one drive entry', { chunk_source: 'timeline' })],
      });
      await seedPage(engine, {
        slug: 'archive/nebula-old',
        input: { type: 'concept', title: 'Old nebula', compiled_truth: 'x', timeline: '', frontmatter: { rank: '3' } },
        chunks: [chunk(0, 'nebula drive nebula drive nebula drive')],
      });
      await createSource(engine, backend, 'side');
      await seedPage(engine, {
        slug: 'notes/side-nebula',
        input: { type: 'note', title: 'Side nebula', compiled_truth: 'x', timeline: '' },
        chunks: [chunk(0, 'a nebula drive on the side')],
      }, { sourceId: 'side' });

      const view = (rows: SearchResult[]) => rows.map((r) => ({ slug: r.slug, score: round(r.score), source_id: r.source_id }));
      const q = 'nebula drive';
      const pages = view(await engine.searchKeywordPages(q, undefined, { limit: 10 }));
      const phrase = view(await engine.searchKeywordPages(q, { keywordPhrase: true }, { limit: 10 }));
      const handle = view(await engine.searchKeywordPages('drive-log', undefined, { limit: 10 }));
      const handleCount = await engine.countKeywordPages('drive-log');
      const where = view(await engine.searchKeywordPages(q, { where: { status: ['active'] } }, { limit: 10 }));
      const whereNumber = view(await engine.searchKeywordPages(q, { where: { rank: ['3'] } }, { limit: 10 }));
      const after = view(await engine.searchKeywordPages(q, { afterDate: '2026-04-01' }, { limit: 10 }));
      const before = view(await engine.searchKeywordPages(q, { beforeDate: '2026-03-01T00:00:00Z', beforeDateInclusive: true }, { limit: 10 }));
      const scoped = view(await engine.searchKeywordPages(q, { sourceIds: ['side'] }, { limit: 10 }));
      const boosted = view(await engine.searchKeywordPages(q, { source_boosts: { 'archive/': 0.5, 'notes/': 1.5 } }, { limit: 10 }));
      const excluded = await engine.countKeywordPages(q, { exclude_slug_prefixes: ['archive/'] });
      const chunks = view(await engine.searchKeywordChunks(q, { limit: 10 }));
      const lowDetail = view(await engine.searchKeywordChunks(q, { limit: 10, detail: 'low' }));
      const offset = view(await engine.searchKeywordChunks(q, { limit: 2, offset: 1 }));
      expect(handleCount).toBe(1);
      expect(handle.map((r) => r.slug)).toEqual(['notes/drive-log']);
      expect(lowDetail.some((r) => r.slug === 'notes/drive-log')).toBe(false);
      return { pages, phrase, handle, handleCount, where, whereNumber, after, before, scoped, boosted, excluded, chunks, lowDetail, offset };
    },
  );

  parityTest(
    'searchKeyword serves the hybrid arm options: OR retry by rarity, identifier probe, handles, phrase, rank query and windows',
    { methods: ['searchKeyword'] },
    async (engine) => {
      const day = (iso: string) => new Date(iso);
      await seedPage(engine, {
        slug: 'notes/nebula-drive',
        input: { type: 'note', title: 'Nebula drive', compiled_truth: 'x', timeline: '', frontmatter: { status: 'active' }, effective_date: day('2026-03-01T00:00:00Z'), effective_date_source: 'date' },
        chunks: [chunk(0, 'the nebula drive hums near the core'), chunk(1, 'drive nebula backwards for the drive test')],
      });
      await seedPage(engine, {
        slug: 'notes/drive-log',
        input: { type: 'note', title: 'Drive log', compiled_truth: 'x', timeline: '', frontmatter: { status: 'draft' }, effective_date: day('2026-05-10T12:00:00Z'), effective_date_source: 'date' },
        chunks: [chunk(0, 'nebula readings and one drive entry')],
      });
      await seedPage(engine, {
        slug: 'notes/weekly-digest-412',
        input: { type: 'note', title: 'Weekly digest', compiled_truth: 'x', timeline: '' },
        chunks: [chunk(0, 'digest 412 covered the quokka census')],
      });
      for (const n of [1, 2, 3]) {
        await seedPage(engine, {
          slug: `notes/weekly-digest-${n}`,
          input: { type: 'note', title: `Weekly digest ${n}`, compiled_truth: 'x', timeline: '' },
          chunks: [chunk(0, `the weekly digest said the latest news was about nebula drive work, week ${n}, and more weekly digest news`)],
        });
      }

      const view = (rows: SearchResult[]) => rows.map((r) => ({
        slug: r.slug, chunk_index: r.chunk_index, score: round(r.score),
        relaxed: r.keyword_relaxed ?? false, fill: (r as { keyword_fill?: boolean }).keyword_fill ?? false,
      }));
      const incomplete: string[] = [];
      // What hybridSearch passes the keyword arm (search/hybrid/request.ts, arms.ts): knobs PGLite does not read included.
      const hybrid = {
        limit: 5, detail: undefined, embeddingColumn: { name: 'embedding', dims: 1536 } as never, cjkKeyword: { deadlineMs: 1000, onMeta: () => undefined } as never,
        keywordTimeoutCache: true, vectorLegacyGuard: undefined, hnswIterativeScan: undefined, onVectorPoolMeta: () => undefined,
        onKeywordIncomplete: (reason: string) => { incomplete.push(reason); }, orFallback: true,
      } as Parameters<BrainEngine['searchKeyword']>[1];
      const search = async (q: string, opts: Parameters<BrainEngine['searchKeyword']>[1]) => view(await engine.searchKeyword(q, opts));
      const out = {
        strict: await search('nebula drive', hybrid),
        relaxed: await search('nebula quokka census', hybrid),
        probe: await search('what did the latest weekly digest (#412) say', hybrid),
        handles: await search('drive-log readings nebula', hybrid),
        phrase: await search('nebula drive', { ...hybrid, keywordPhrase: true }),
        rankQuery: await search('nebula drive', { ...hybrid, rankQuery: 'core' }),
        where: await search('nebula drive', { ...hybrid, where: { status: ['active'] } }),
        after: await search('nebula drive', { ...hybrid, afterDate: '2026-04-01' }),
        window: await search('nebula or digest or drive', { limit: 2, offset: 1 }),
        windowPastInner: await search('nebula or digest or drive', { limit: 1, offset: 4 }),
        fill: await search('nebula quokka', { ...hybrid, orFill: true }),
        fillPaged: await search('nebula quokka', { ...hybrid, orFill: true, offset: 1 }),
        strictOnly: await search('nebula quokka', { limit: 5 }),
        empty: await search('', hybrid),
        stopwords: await search('the and of', hybrid),
      };
      expect(out.strict.length).toBeGreaterThan(0);
      expect(out.relaxed.every((r) => r.relaxed)).toBe(true);
      expect(out.relaxed[0]!.slug).toBe('notes/weekly-digest-412');
      expect(out.probe[0]!.slug).toBe('notes/weekly-digest-412');
      expect(out.handles[0]!.slug).toBe('notes/drive-log');
      expect(out.fill.every((r) => r.fill)).toBe(true);
      expect(out.fillPaged).toEqual([]);
      expect(out.strictOnly).toEqual([]);
      expect(incomplete).toEqual([]);
      return out;
    },
  );

  parityTest(
    'searchKeyword with excludePrivate hides the pages the private-page policy hides and a limit counts only visible pages',
    { methods: ['searchKeyword'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      // The pages the policy hides repeat the term, so they outrank every visible page: a limit that counted them would
      // return fewer visible pages than it asks for.
      const hot = 'lanternfish lanternfish lanternfish lanternfish ledger';
      const plain = 'lanternfish ledger entry';
      const page = (title: string, compiled_truth: string, extra: Record<string, unknown> = {}) =>
        ({ type: 'note' as const, title, compiled_truth, timeline: '', ...extra });
      const put = (slug: string, input: ReturnType<typeof page>, sourceId?: string) =>
        seedPage(engine, { slug, input, chunks: [chunk(0, input.compiled_truth)] }, sourceId ? { sourceId } : undefined);
      await put('notes/open-a', page('Open A', plain));
      await put('notes/open-b', page('Open B', `${plain} again`));
      await put('notes/visibility-private', page('Visibility private', hot, { frontmatter: { visibility: 'private' } }));
      await put('notes/access-private', page('Access private', hot, { frontmatter: { access: 'private' } }));
      await put('notes/confidentiality-secret', page('Confidentiality secret', hot, { frontmatter: { confidentiality: 'secret' } }));
      await put('notes/public-wins', page('Public wins', hot, { frontmatter: { visibility: 'public', access: 'private' } }));
      await put('notes/named-readers', page('Named readers', hot, { frontmatter: { readable_by: ['someone'] } }));
      await put('atoms/derived-atom', page('Derived atom', hot, { type: 'atom' }));
      await put('notes/handle-secret', page('Handle secret', 'unrelated words only', { frontmatter: { visibility: 'private' } }));
      await put('notes/work-open', page('Work open', plain), 'work');
      await put('notes/work-private', page('Work private', hot, { frontmatter: { visibility: 'private' } }), 'work');

      const q = 'lanternfish ledger';
      type Opts = Parameters<BrainEngine['searchKeyword']>[1];
      const slugs = async (query: string, opts?: Opts) =>
        (await engine.searchKeyword(query, opts)).map((r) => `${r.source_id}:${r.slug}`);
      const out = {
        omitted: await slugs(q, { limit: 20 }),
        off: await slugs(q, { limit: 20, excludePrivate: false }),
        on: await slugs(q, { limit: 20, excludePrivate: true }),
        onOneRow: await slugs(q, { limit: 1, excludePrivate: true }),
        onSecondRow: await slugs(q, { limit: 1, offset: 1, excludePrivate: true }),
        onDefaultSource: await slugs(q, { limit: 20, excludePrivate: true, sourceId: 'default' }),
        onWorkSource: await slugs(q, { limit: 20, excludePrivate: true, sourceIds: ['work'] }),
        onTyped: await slugs(q, { limit: 20, excludePrivate: true, type: 'atom' }),
        onRelaxed: await slugs('lanternfish nonesuchword', { limit: 20, excludePrivate: true, orFallback: true }),
        handleOff: await slugs('handle-secret lanternfish', { limit: 20, orFallback: true }),
        handleOn: await slugs('handle-secret lanternfish', { limit: 20, orFallback: true, excludePrivate: true }),
      };
      // The policy hides pages: the visible ones, and no others, answer.
      expect(out.omitted).toEqual(out.off);
      expect(out.off.length).toBe(10);
      expect(sorted(out.on)).toEqual(['default:notes/open-a', 'default:notes/open-b', 'default:notes/public-wins', 'work:notes/work-open']);
      expect(out.onOneRow.length).toBe(1);
      expect(out.onSecondRow.length).toBe(1);
      expect(out.onOneRow).not.toEqual(out.onSecondRow);
      expect(sorted(out.onWorkSource)).toEqual(['work:notes/work-open']);
      expect(out.onTyped).toEqual([]);
      expect(out.handleOff).toContain('default:notes/handle-secret');
      expect(out.handleOn).not.toContain('default:notes/handle-secret');
      return out;
    },
  );

  // The harness counts a typed refusal as an acceptable Rust outcome for a case, so the case above would also pass on a Rust
  // arm that still refused excludePrivate (the arm's tally says how many cases ended on a refusal). This test fails on that
  // arm: it reads the answer, and it asserts the options the store still cannot answer. A refusal caught inside a parity
  // case would fail the arm's check, so both are asserted here on the Rust arm's own engine.
  test('the Rust arm answers excludePrivate and still refuses the options it cannot answer beside it', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    const engine = rust.engine;
    await seedPage(engine, { slug: 'notes/refusal-probe', input: { type: 'note', title: 'Refusal probe', compiled_truth: 'periwinkle ledger', timeline: '' }, chunks: [chunk(0, 'periwinkle ledger')] });
    await seedPage(engine, {
      slug: 'notes/refusal-hidden',
      input: { type: 'note', title: 'Refusal hidden', compiled_truth: 'periwinkle periwinkle periwinkle ledger', timeline: '', frontmatter: { visibility: 'private' } },
      chunks: [chunk(0, 'periwinkle periwinkle periwinkle ledger')],
    });
    const slugs = async (opts: Parameters<BrainEngine['searchKeyword']>[1]) => (await engine.searchKeyword('periwinkle ledger', opts)).map((r) => r.slug);
    expect(await slugs({ limit: 5 })).toEqual(['notes/refusal-hidden', 'notes/refusal-probe']);
    expect(await slugs({ limit: 5, excludePrivate: true })).toEqual(['notes/refusal-probe']);
    expect(await slugs({ limit: 1, excludePrivate: true })).toEqual(['notes/refusal-probe']);
    const refusal = async (run: () => Promise<unknown>) => {
      const error = await run().then(() => null, (e: unknown) => e as { code?: string; message?: string });
      return { code: error?.code, message: error?.message };
    };
    for (const extra of [{ minTrust: 'medium' }, { suppressFlagged: true }, { notAnOption: true }]) {
      const got = await refusal(() => engine.searchKeyword('periwinkle', { excludePrivate: true, ...extra } as never));
      expect(got.code).toBe('engine_capability_missing');
      expect(got.message).toContain(Object.keys(extra)[0]!);
    }
    // The title arm answers excludePrivate too (its own parity case reads the rows); the other keyword members refuse it.
    expect((await engine.searchTitles('refusal probe', { limit: 5, excludePrivate: true })).map((r) => r.slug)).toEqual(['notes/refusal-probe']);
    expect((await engine.searchTitles('refusal', { limit: 5 })).map((r) => r.slug).sort()).toEqual(['notes/refusal-hidden', 'notes/refusal-probe']);
    for (const extra of [{ minTrust: 'medium' }, { suppressFlagged: true }, { notAnOption: true }]) {
      const got = await refusal(() => engine.searchTitles('refusal', { excludePrivate: true, ...extra } as never));
      expect(got.code).toBe('engine_capability_missing');
      expect(got.message).toContain(Object.keys(extra)[0]!);
    }
    const others: Array<[string, () => Promise<unknown>]> = [
      ['searchKeywordChunks', () => engine.searchKeywordChunks('periwinkle', { excludePrivate: true })],
      ['countKeywordPages', () => engine.countKeywordPages('periwinkle', { excludePrivate: true })],
      ['searchKeywordPages', () => engine.searchKeywordPages('periwinkle', { excludePrivate: true }, { limit: 5, offset: 0 })],
    ];
    for (const [member, run] of others) {
      const got = await refusal(run);
      expect({ member, code: got.code, message: got.message }).toMatchObject({ code: 'engine_capability_missing', message: expect.stringContaining('option excludePrivate') });
    }
  });

  parityTest(
    'searchTitles with excludePrivate hides the pages the private-page policy hides, matches titles only and counts only visible pages',
    { methods: ['searchTitles'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const put = (slug: string, title: string, frontmatter?: Record<string, unknown>, sourceId?: string, type: 'note' | 'atom' = 'note', timeline = '') =>
        seedPage(engine, {
          slug,
          input: { type, title, compiled_truth: `${title} body`, timeline, ...(frontmatter ? { frontmatter } : {}) },
          chunks: [chunk(0, `${title} body`)],
        }, sourceId ? { sourceId } : undefined);
      // The hidden pages repeat the term in the title, so they outrank every visible page: a limit that counted them would
      // return fewer visible pages than it asks for.
      await put('notes/open-a', 'Pelican ledger');
      await put('notes/open-b', 'Pelican ledger again and again');
      await put('notes/visibility-private', 'Pelican pelican pelican ledger', { visibility: 'private' });
      await put('notes/access-private', 'Pelican pelican pelican ledger access', { access: 'private' });
      await put('notes/public-wins', 'Pelican public ledger', { visibility: 'public', access: 'private' });
      await put('notes/named-readers', 'Pelican pelican named ledger', { readable_by: ['someone'] });
      await put('atoms/derived-atom', 'Pelican pelican derived ledger', undefined, undefined, 'atom');
      await put('notes/work-open', 'Pelican work ledger', undefined, 'work');
      await put('notes/work-private', 'Pelican pelican work ledger', { visibility: 'private' }, 'work');
      // The word is in the timeline only: the whole-vector match finds the page, the title-only match (the safe-chunks rule) does not.
      await put('notes/sealed-timeline', 'Heron notes', undefined, undefined, 'note', 'kingfisher sighted');
      await put('notes/sealed-timeline-private', 'Heron private notes', { visibility: 'private' }, undefined, 'note', 'kingfisher sighted');

      const q = 'pelican ledger';
      type Opts = Parameters<BrainEngine['searchTitles']>[1];
      const slugs = async (query: string, opts?: Opts) =>
        (await engine.searchTitles(query, opts)).map((r) => `${r.source_id}:${r.slug}`);
      const out = {
        omitted: await slugs(q, { limit: 20 }),
        off: await slugs(q, { limit: 20, excludePrivate: false }),
        on: await slugs(q, { limit: 20, excludePrivate: true }),
        onOneRow: await slugs(q, { limit: 1, excludePrivate: true }),
        onSecondRow: await slugs(q, { limit: 1, offset: 1, excludePrivate: true }),
        onDefaultSource: await slugs(q, { limit: 20, excludePrivate: true, sourceId: 'default' }),
        onWorkSource: await slugs(q, { limit: 20, excludePrivate: true, sourceIds: ['work'] }),
        onTyped: await slugs(q, { limit: 20, excludePrivate: true, type: 'atom' }),
        onRelaxed: await slugs('pelican ledger nonesuchword', { limit: 20, excludePrivate: true }),
        timelineOff: await slugs('kingfisher', { limit: 20 }),
        timelineOn: await slugs('kingfisher', { limit: 20, excludePrivate: true }),
        timelineOnSafeOff: await slugs('kingfisher', { limit: 20, excludePrivate: true, requireSafeChunks: false }),
      };
      expect(out.omitted).toEqual(out.off);
      expect(out.off.length).toBe(9);
      expect(sorted(out.on)).toEqual(['default:notes/open-a', 'default:notes/open-b', 'default:notes/public-wins', 'work:notes/work-open']);
      expect(out.onOneRow.length).toBe(1);
      expect(out.onSecondRow.length).toBe(1);
      expect(out.onOneRow).not.toEqual(out.onSecondRow);
      expect(sorted(out.onWorkSource)).toEqual(['work:notes/work-open']);
      expect(out.onTyped).toEqual([]);
      expect(sorted(out.onRelaxed)).toEqual(sorted(out.on));
      // excludePrivate turns the safe-chunks rule on, which matches titles alone; requireSafeChunks: false keeps the whole-vector match.
      expect(sorted(out.timelineOff)).toEqual(['default:notes/sealed-timeline', 'default:notes/sealed-timeline-private']);
      expect(out.timelineOn).toEqual([]);
      expect(out.timelineOnSafeOff).toEqual(['default:notes/sealed-timeline']);
      return out;
    },
  );

  parityTest(
    'searchTitles: sealed timelines, timeline entries, the candidate cut, the OR retry by rarity, identifiers and paging',
    { methods: ['searchTitles'] },
    async (engine) => {
      const { __setTitleWholeVectorCandidatesForTests, titleWholeVectorCandidates } = await import('../../src/core/search/title-statement.ts');
      const put = (slug: string, title: string, timeline: string, sealed = true) =>
        seedPage(engine, {
          slug,
          input: { type: 'note', title, compiled_truth: `${title} body`, timeline },
          chunks: sealed ? [chunk(0, `${title} body`)] : undefined,
        });
      await put('notes/flight-log', 'Flight Log', 'quokka sighted near the hangar');
      await put('notes/comet-tally', 'Comet Tally', '');
      await put('notes/comet-vault', 'Comet Vault', 'atlas mention');
      await put('notes/vault-atlas', 'Vault Atlas', '');
      await put('notes/weekly-digest', 'Weekly Digest 412', '');
      await put('people/matthew-example', 'Matthew Example', '');
      // A page never sealed is not served (servedTextProjectionFilter), even with a timeline entry in its trigger vector.
      await put('notes/walrus-page', 'Walrus Page', 'first', false);
      await engine.addTimelineEntry('notes/walrus-page', { date: '2026-01-02', summary: 'pinniped migration', detail: 'tundra' });
      await put('notes/walrus-page', 'Walrus Page', 'second', false);
      // An entry added after the seal is not in the sealed vector.
      await engine.addTimelineEntry('notes/flight-log', { date: '2026-01-03', summary: 'zebra crossing', detail: '' });

      const incomplete: string[] = [];
      const view = (rows: SearchResult[]) =>
        rows.map((r) => ({ slug: r.slug, relaxed: r.keyword_relaxed === true, score: round(r.score), chunk: r.chunk_text }));
      const search = async (q: string, opts: Parameters<BrainEngine['searchTitles']>[1] = {}) =>
        view(await engine.searchTitles(q, { limit: 5, onKeywordIncomplete: (r) => incomplete.push(r), ...opts }));
      const out = {
        timeline: await search('quokka hangar'),
        pinniped: await search('pinniped tundra'),
        zebra: await search('zebra'),
        comet: await search('comet'),
        paged: await search('comet', { limit: 1, offset: 1 }),
        rarity: await search('comet atlas quokka'),
        rarityPaged: await search('comet atlas quokka', { offset: 1 }),
        ident: await search('what did digest #412 say'),
        variant: await search('Matt Example'),
        cut: [] as ReturnType<typeof view>,
        cutRelaxed: [] as ReturnType<typeof view>,
        incomplete,
      };
      const cap = titleWholeVectorCandidates();
      __setTitleWholeVectorCandidatesForTests(1);
      try {
        out.cut = await search('comet');
        out.cutRelaxed = await search('comet atlas quokka');
      } finally {
        __setTitleWholeVectorCandidatesForTests(cap);
      }
      expect(out.timeline.map((r) => r.slug)).toEqual(['notes/flight-log']);
      expect(out.zebra).toEqual([]);
      expect(out.pinniped).toEqual([]);
      expect(out.comet.length).toBe(2);
      expect(out.rarity.every((r) => r.relaxed)).toBe(true);
      expect(out.ident[0]!.slug).toBe('notes/weekly-digest');
      expect(out.variant[0]!.slug).toBe('people/matthew-example');
      expect(out.incomplete).toContain('candidate_budget');
      return out;
    },
  );

  parityTest(
    'searchTitles: a re-put of an unchanged sealed page reads the trigger vector (title, raw timeline, every entry)',
    { methods: ['searchTitles'] },
    async (engine) => {
      const page = { type: 'note' as const, title: 'Harbor Log', compiled_truth: 'Harbor Log body', timeline: 'ferry arrived at dawn' };
      await seedPage(engine, { slug: 'notes/harbor-log', input: page, chunks: [chunk(0, 'Harbor Log body')] });
      // An entry added after the seal is not in the sealed vector.
      await engine.addTimelineEntry('notes/harbor-log', { date: '2026-01-04', summary: 'narwhal surfaced', detail: 'fjord' });
      const view = (rows: SearchResult[]) => rows.map((r) => ({ slug: r.slug, score: round(r.score), chunk: r.chunk_text }));
      const search = async (q: string) => view(await engine.searchTitles(q, { limit: 5 }));
      const sealed = { entry: await search('narwhal fjord'), timeline: await search('ferry dawn') };
      // The same input again: the page keeps its revision and seal, and the trigger rewrites the vector.
      await seedPage(engine, { slug: 'notes/harbor-log', input: page });
      const reput = { entry: await search('narwhal fjord'), timeline: await search('ferry dawn'), title: await search('harbor') };
      expect(sealed.entry).toEqual([]);
      expect(sealed.timeline.map((r) => r.slug)).toEqual(['notes/harbor-log']);
      expect(reput.entry.map((r) => r.slug)).toEqual(['notes/harbor-log']);
      return { sealed, reput };
    },
  );
});
