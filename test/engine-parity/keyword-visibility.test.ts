/**
 * BrainEngine parity — `excludePrivate` and the safe-chunk fence on the keyword members (searchKeyword,
 * searchKeywordChunks, countKeywordPages, searchKeywordPages, searchTitles).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: under `excludePrivate` each keyword member drops the pages the page policy
 *    (`privatePagesFilterForCaller('p')`, src/core/search/private-visibility.ts) hides, and under
 *    `requiresSafeChunks` (which `excludePrivate` implies unless the read says otherwise) the pages short of the
 *    chunker-version fence, before it ranks, limits or counts (`buildVisibilityClause`, search/sql-ranking.ts). A
 *    safe-chunk searchTitles matches and ranks title lexemes only (`buildSearchTitlesStatement`). Every engine arm
 *    returns the same rows.
 *  - Regression: an engine that ignores the flag (a private page ranks first in remote keyword search, a hidden page
 *    is counted by the keyword pager), that skips the fence, that applies the fence without `excludePrivate`, or that
 *    lets a safe-chunk title search match a page on its timeline.
 *  - Why existing coverage misses it: search.test.ts never passes `excludePrivate` or `requireSafeChunks`, and
 *    private-page-reads.test.ts covers the salience, anomaly and chunk reads, not keyword search.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchOpts, SearchResult } from '../../src/core/types.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

/** One page per rule, each named after what it tests. `weight` repeats the shared word so the hidden pages rank first. */
const PAGES: Array<[slug: string, type: string, frontmatter: Record<string, unknown>, weight: number]> = [
  ['notes/private', 'note', { visibility: 'private' }, 6],
  ['notes/readers', 'note', { readable_by: ['alice-example'] }, 5],
  ['notes/access-alias', 'note', { access: 'Restricted' }, 5],
  ['atoms/no-visibility', 'atom', {}, 4],
  ['atoms/origin-private', 'atom', { visibility: 'world', source_slug: 'notes/private' }, 4],
  ['notes/lineage-private', 'note', { derived_from: 'notes/private.md' }, 4],
  ['notes/fence-short', 'note', {}, 3],
  ['notes/open', 'note', {}, 2],
  ['atoms/origin-open', 'atom', { visibility: 'world', source_slug: 'notes/open' }, 1],
  ['notes/access-plain', 'note', { access: 'team' }, 1],
];

async function fixture(engine: BrainEngine): Promise<void> {
  for (const [slug, type, frontmatter, weight] of PAGES) {
    const text = `${Array(weight).fill('zephyr').join(' ')} quartz notes about ${slug}.`;
    await engine.putPage(slug, { type: type as never, title: `Zephyr ${slug}`, compiled_truth: text, timeline: '', frontmatter });
    await installChunks(engine, slug, [chunk(0, text)]);
  }
  // Kept by the page policy, but the shared word is only in its timeline: a title-only (safe-chunk) search misses it.
  await engine.putPage('notes/timeline-only', { type: 'note', title: 'Harbor log', compiled_truth: 'Harbor log.', timeline: '- 2026-01-02: zephyr seen at the harbor' });
  await installChunks(engine, 'notes/timeline-only', [chunk(0, 'Harbor log.'), chunk(1, '- 2026-01-02: zephyr seen at the harbor', { chunk_source: 'timeline' })]);
  // Sealed text, but a chunker version short of the safe fence: only the safe-chunk reads drop it.
  await engine.setChunkerVersion('notes/fence-short', 3);
}

const view = (rows: SearchResult[]) => rows.map((r) => `${r.slug}:${r.chunk_index}${r.keyword_relaxed ? ':relaxed' : ''}`);

const SCOPES: Record<string, SearchOpts> = {
  off: {},
  private: { excludePrivate: true },
  privateNoFence: { excludePrivate: true, requireSafeChunks: false },
  fenceOnly: { requireSafeChunks: true },
};

async function eachScope<T>(read: (scope: SearchOpts) => Promise<T>): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const [name, scope] of Object.entries(SCOPES)) out[name] = await read(scope);
  return out;
}

/** The pages the page policy keeps (the fence-short page passes the policy). */
const KEPT = ['atoms/origin-open', 'notes/access-plain', 'notes/fence-short', 'notes/open', 'notes/timeline-only'];

describe('engine parity: excludePrivate and the safe-chunk fence on keyword search', () => {
  parityTest(
    'searchKeyword and searchKeywordChunks drop hidden and fence-short pages before they rank and limit',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'searchKeyword', 'searchKeywordChunks'] },
    async (engine) => {
      await fixture(engine);
      const keyword = await eachScope(async (scope) => view(await engine.searchKeyword('zephyr', { limit: 3, ...scope })));
      const all = await eachScope(async (scope) => sorted(view(await engine.searchKeyword('zephyr', { limit: 20, ...scope }))));
      const chunks = await eachScope(async (scope) => view(await engine.searchKeywordChunks('zephyr', { limit: 3, ...scope })));
      const relaxed = await eachScope(async (scope) => view(await engine.searchKeyword('zephyr qqqqzzzz', { limit: 3, orFallback: true, ...scope })));
      // The hidden pages rank first without the flag, so the limited read must filter before it limits.
      expect(keyword.off![0]!.startsWith('notes/private:')).toBe(true);
      expect(keyword.private).toEqual(['notes/open:0', 'atoms/origin-open:0', 'notes/access-plain:0']);
      expect(all.private!.map((r) => r.split(':')[0])).toEqual(KEPT.filter((s) => s !== 'notes/fence-short'));
      expect(all.privateNoFence!.map((r) => r.split(':')[0])).toEqual(KEPT);
      expect(all.fenceOnly!).not.toContain('notes/fence-short:0');
      expect(all.fenceOnly!).toContain('notes/private:0');
      return { keyword, all, chunks, relaxed };
    },
  );

  parityTest(
    'countKeywordPages and searchKeywordPages count and page only the pages the scope keeps',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'countKeywordPages', 'searchKeywordPages'] },
    async (engine) => {
      await fixture(engine);
      const counts = await eachScope((scope) => engine.countKeywordPages('zephyr', scope));
      const pages = await eachScope(async (scope) => view(await engine.searchKeywordPages('zephyr', scope, { limit: 2, offset: 1 })));
      expect(counts.off).toBe(PAGES.length + 1);
      expect(counts.private).toBe(KEPT.length - 1);
      expect(counts.privateNoFence).toBe(KEPT.length);
      expect(counts.fenceOnly).toBe(PAGES.length);
      return { counts, pages };
    },
  );

  parityTest(
    'searchTitles under the safe-chunk fence matches titles only and drops hidden pages, on the strict and the OR attempts',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'searchTitles'] },
    async (engine) => {
      await fixture(engine);
      const strict = await eachScope(async (scope) => sorted(view(await engine.searchTitles('zephyr', { limit: 20, ...scope }))));
      const limited = await eachScope(async (scope) => view(await engine.searchTitles('zephyr', { limit: 2, offset: 1, ...scope })));
      const anyWord = await eachScope(async (scope) => sorted(view(await engine.searchTitles('zephyr qqqqzzzz', { limit: 20, ...scope }))));
      const slugs = (rows: string[]) => rows.map((r) => r.split(':')[0]);
      expect(slugs(strict.off!)).toContain('notes/timeline-only');
      expect(slugs(strict.privateNoFence!)).toEqual(KEPT);
      // Title-only: the timeline match is gone, and so is the fence-short page.
      expect(slugs(strict.private!)).toEqual(['atoms/origin-open', 'notes/access-plain', 'notes/open']);
      expect(slugs(strict.fenceOnly!)).not.toContain('notes/timeline-only');
      expect(slugs(anyWord.private!)).toEqual(['atoms/origin-open', 'notes/access-plain', 'notes/open']);
      return { strict, limited, anyWord };
    },
  );
});
