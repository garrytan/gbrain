/**
 * BrainEngine parity — the page policy of `excludePrivate` on the salience and anomaly reads (getRecentSalience,
 * getSalienceScores, findAnomalies) and on the chunk reads (getChunkPage, getChunkWindows), with the safe-chunk fence
 * an `excludePrivate` chunk read implies.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: under `excludePrivate`, each read drops exactly the pages `pageReadFilter`'s page policy
 *    (`privatePagesFilterForCaller('p')`, src/core/search/private-visibility.ts) hides, before it ranks, limits or
 *    counts, on every engine arm; without it the same pages come back.
 *  - Regression: an engine that ignores the flag (a private page ranks first in `get_recent_salience`, a hidden page
 *    feeds hybrid search's salience boost, a private page's tag shows up as an anomaly), or that judges only
 *    `visibility` and misses readers, aliases, pinned questions, derived atoms and concepts, declared lineage or Life
 *    Chronicle origins.
 *  - Why existing coverage misses it: code-eval-salience.test.ts and stats.test.ts never pass `excludePrivate`, and the
 *    fact privacy cases in facts.test.ts judge fact rows, not the pages a page read returns.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, pick, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

/** One page per rule of the page policy, each named after what it tests. */
const PAGES: Array<[string, string, Record<string, unknown>]> = [
  ['notes/open', 'note', {}],
  ['notes/private', 'note', { visibility: 'private' }],
  ['notes/readers', 'note', { readable_by: ['alice-example'] }],
  ['notes/access-alias', 'note', { access: '\u00a0Restricted\u3000' }],
  ['notes/access-plain', 'note', { access: 'team' }],
  ['notes/alias-with-visibility', 'note', { confidentiality: 'secret', visibility: 'world' }],
  ['notes/pinned', 'note', { pinned_question: true, visibility: 'world' }],
  ['atoms/no-visibility', 'atom', {}],
  ['atoms/origin-private', 'atom', { visibility: 'world', source_slug: 'notes/private' }],
  ['atoms/origin-readers', 'atom', { visibility: 'world', source_slug: 'notes/readers' }],
  ['atoms/origin-open', 'atom', { visibility: 'world', source_slug: 'notes/open' }],
  ['concepts/private-input', 'concept', { visibility: 'world', synthesized_by: 'dream' }],
  ['concepts/readers-input', 'concept', { visibility: 'world', synthesized_by: 'dream' }],
  ['concepts/open-input', 'concept', { visibility: 'world', synthesized_by: 'dream' }],
  ['concepts/plain', 'concept', {}],
  ['notes/lineage-md', 'note', { derived_from: 'notes/private.md' }],
  ['notes/lineage-readers', 'note', { derived_from: ['notes/open', 'notes/readers'] }],
  ['notes/lineage-open', 'note', { derived_from: ['notes/open.md', 'notes/none'] }],
  ['events/chronicle-missing', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'meetings/none' } }],
  ['events/chronicle-private', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'notes/private' } }],
  ['events/chronicle-open', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'notes/open' } }],
  ['events/plain', 'event', { event: { depth: 'meetings/none' } }],
  ['people/open-person', 'person', {}],
];

/** The pages the page policy keeps; every other fixture page is hidden under `excludePrivate`. */
const KEPT = [
  'atoms/origin-open', 'concepts/open-input', 'concepts/plain', 'events/chronicle-open', 'events/plain',
  'notes/access-plain', 'notes/alias-with-visibility', 'notes/lineage-open', 'notes/open', 'people/open-person',
];

/** Writes the fixture in `default`, a private page in `other`, and the concept-provenance links. */
async function fixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'other');
  for (const [slug, type, frontmatter] of PAGES) {
    await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter });
  }
  await engine.putPage('notes/private', { type: 'note', title: 'Other private', compiled_truth: 'Other.', timeline: '', frontmatter: { visibility: 'private' } }, { sourceId: 'other' });
  await engine.putPage('notes/open', { type: 'note', title: 'Other open', compiled_truth: 'Other.', timeline: '' }, { sourceId: 'other' });
  await engine.addLink('concepts/private-input', 'atoms/no-visibility', '', 'synthesized_from', 'concept-provenance');
  await engine.addLink('concepts/readers-input', 'notes/readers', '', 'synthesized_from', 'concept-provenance');
  await engine.addLink('concepts/open-input', 'notes/open', '', 'synthesized_from', 'concept-provenance');
  await engine.addLink('concepts/open-input', 'notes/private', '', 'mentions', 'manual');
}

const ids = (rows: Array<{ source_id: string; slug: string }>) => sorted(rows.map((r) => `${r.source_id}:${r.slug}`));

describe('engine parity: excludePrivate on page reads', () => {
  parityTest(
    'getRecentSalience under excludePrivate drops the pages the page policy hides before it ranks and limits',
    { methods: ['putPage', 'addLink', 'setEmotionalWeightBatch', 'getRecentSalience'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      // The private page carries the top weight, so a read that ignores the flag ranks it first.
      await engine.setEmotionalWeightBatch([
        { slug: 'notes/private', source_id: 'default', weight: 1 },
        { slug: 'notes/private', source_id: 'other', weight: 0.9 },
        { slug: 'notes/open', source_id: 'default', weight: 0.5 },
      ]);
      const off = await engine.getRecentSalience({ days: 7, limit: 100 });
      const on = await engine.getRecentSalience({ days: 7, limit: 100, excludePrivate: true });
      const top = await engine.getRecentSalience({ days: 7, limit: 1, excludePrivate: true });
      const scoped = await engine.getRecentSalience({ days: 7, sourceId: 'other', excludePrivate: true });
      expect(off[0]!.slug).toBe('notes/private');
      expect(ids(on)).toEqual(sorted([...KEPT.map((s) => `default:${s}`), 'other:notes/open']));
      return {
        off: ids(off), on: ids(on), top: ids(top), scoped: ids(scoped),
        weights: sorted(on.map((r) => `${r.source_id}:${r.slug}=${Math.round(r.emotional_weight * 100) / 100}`)),
      };
    },
  );

  parityTest(
    'getSalienceScores under excludePrivate scores only the pages the page policy keeps',
    { methods: ['putPage', 'addLink', 'setEmotionalWeightBatch', 'getSalienceScores'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      await engine.setEmotionalWeightBatch([{ slug: 'notes/private', source_id: 'default', weight: 1 }]);
      const refs = [...PAGES.map(([slug]) => ({ slug, source_id: 'default' })), { slug: 'notes/private', source_id: 'other' }];
      const view = (scores: Map<string, number>) => sorted([...scores].map(([key, score]) => `${key}=${Math.round(score * 1000) / 1000}`));
      const off = await engine.getSalienceScores(refs, { sourceIds: ['default', 'other'] });
      const on = await engine.getSalienceScores(refs, { sourceIds: ['default', 'other'], excludePrivate: true });
      expect(off.get('default::notes/private')).toBe(5);
      expect(sorted([...on.keys()])).toEqual(sorted(KEPT.map((s) => `default::${s}`)));
      return { off: view(off), on: view(on) };
    },
  );

  parityTest(
    'findAnomalies under excludePrivate counts only the pages the page policy keeps, per tag and per type',
    { methods: ['putPage', 'addLink', 'addTag', 'getPage', 'findAnomalies'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      for (const [slug] of PAGES) await engine.addTag(slug, 'probe');
      // A cohort is an anomaly only above its baseline mean + 1 here, so the hidden-only tag needs three pages.
      for (const slug of ['notes/private', 'notes/readers', 'atoms/no-visibility']) await engine.addTag(slug, 'secret-only');
      const today = new Date((await engine.getPage('notes/private'))!.updated_at).toISOString().slice(0, 10);
      const view = (rows: Awaited<ReturnType<typeof engine.findAnomalies>>) =>
        sorted(rows.map((r) => ({ ...pick(r, ['cohort_kind', 'cohort_value', 'count'] as const), page_slugs: sorted(r.page_slugs) })),
          (r) => `${r.cohort_kind}:${r.cohort_value}`);
      const off = view(await engine.findAnomalies({ since: today, lookback_days: 1 }));
      const on = view(await engine.findAnomalies({ since: today, lookback_days: 1, excludePrivate: true }));
      const scoped = view(await engine.findAnomalies({ since: today, lookback_days: 1, sourceId: 'other', excludePrivate: true }));
      expect(off.find((r) => r.cohort_value === 'secret-only')?.page_slugs).toEqual(['atoms/no-visibility', 'notes/private', 'notes/readers']);
      expect(on.find((r) => r.cohort_value === 'secret-only')).toBeUndefined();
      expect(on.find((r) => r.cohort_value === 'probe')?.page_slugs).toEqual(KEPT);
      return { off, on, scoped };
    },
  );
});

describe('engine parity: excludePrivate and the safe-chunk fence on chunk reads', () => {
  parityTest(
    'getChunkPage and getChunkWindows under excludePrivate read only the pages the page policy keeps and the safe fence passes',
    { methods: ['putPage', 'addLink', 'sealChunks', 'setChunkerVersion', 'getPage', 'getChunkPage', 'getChunkWindows'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      for (const [slug] of PAGES) await installChunks(engine, slug, [chunk(0, `About ${slug}.`)]);
      await installChunks(engine, 'notes/private', [chunk(0, 'Other.')], { sourceId: 'other' });
      await installChunks(engine, 'notes/open', [chunk(0, 'Other.')], { sourceId: 'other' });
      // Sealed text, but a chunker version short of the safe fence: only the safe-chunk read drops it.
      await engine.putPage('notes/fence-short', { type: 'note', title: 'Fence short', compiled_truth: 'Short.', timeline: '' });
      await installChunks(engine, 'notes/fence-short', [chunk(0, 'Short.')]);
      await engine.setChunkerVersion('notes/fence-short', 3);
      const slugs = [...PAGES.map(([slug]) => slug), 'notes/fence-short'];

      type Scope = { excludePrivate?: boolean; requireSafeChunks?: boolean };
      const pageRead = async (scope: Scope, sourceId = 'default') => {
        const seen: string[] = [];
        for (const slug of slugs) {
          const page = await engine.getChunkPage(slug, { sourceId, fromIndex: 0, limit: 10, ...scope });
          if (page.total_chunks > 0) seen.push(`${slug}:${page.total_chunks}:${page.max_chunk_index}:${page.chunks.map((c) => c.chunk_text).join('|')}`);
        }
        return seen;
      };
      const slugOf = new Map<number, string>();
      for (const slug of slugs) slugOf.set((await engine.getPage(slug))!.id, `default:${slug}`);
      slugOf.set((await engine.getPage('notes/private', { sourceId: 'other' }))!.id, 'other:notes/private');
      const requests = [...slugOf.keys()].map((page_id, i) => ({ page_id, from_index: 0, to_index: 5, priority: i % 3 }));
      const windowRead = async (scope: Scope) => sorted((await engine.getChunkWindows(requests, {
        chunkSources: ['compiled_truth'], maxRows: 100, sourceIds: ['default', 'other'], ...scope,
      })).map((p) => `${slugOf.get(p.page_id)}:${p.sealed}:${p.chunks.map((c) => c.chunk_text).join('|')}`));

      const pageOn = await pageRead({ excludePrivate: true });
      const windowOn = await windowRead({ excludePrivate: true });
      expect(sorted(pageOn.map((row) => row.split(':')[0]!))).toEqual(KEPT);
      expect(windowOn.map((row) => row.split(':').slice(0, 2).join(':'))).toEqual(KEPT.map((s) => `default:${s}`));
      return {
        pageOff: await pageRead({}),
        pageOn,
        pageNoFence: await pageRead({ excludePrivate: true, requireSafeChunks: false }),
        pageFenceOnly: await pageRead({ requireSafeChunks: true }),
        pageOther: await pageRead({ excludePrivate: true }, 'other'),
        windowOff: await windowRead({}),
        windowOn,
        windowNoFence: await windowRead({ excludePrivate: true, requireSafeChunks: false }),
        windowFenceOnly: await windowRead({ requireSafeChunks: true }),
      };
    },
  );
});
