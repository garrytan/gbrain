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
 *  - Caller policy: the last group reads as a member whose identity a page's readers name, then with a private-readable
 *    grant on the source; the Rust store reads both from the policy the TypeScript member sends.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, pick, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

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

/**
 * Two callers: member alice-example of group team-a, whose identity opens the page whose readers name it, and the
 * same member with a private-readable grant on `default`, which also opens that source's private pages that are not
 * pinned questions. Derived pages whose origin names readers stay hidden from both, as the page policy keeps them.
 */
const CALLERS = {
  member: { identity: ['member:alice-example', 'group:team-a'], hidePrivate: true },
  granted: { identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true },
} as const;
const asCaller = async <T>(read: () => Promise<T>) => ({
  member: await withCallerAccess(CALLERS.member, read),
  granted: await withCallerAccess(CALLERS.granted, read),
});
/** The pages each caller reads in `default`. */
const CALLER_KEPT = {
  member: sorted([...KEPT, 'notes/readers']),
  granted: sorted(PAGES.map(([slug]) => slug)
    .filter((slug) => !['notes/pinned', 'atoms/origin-readers', 'concepts/readers-input', 'notes/lineage-readers'].includes(slug))),
};

const ids = (rows: Array<{ source_id: string; slug: string }>) => sorted(rows.map((r) => `${r.source_id}:${r.slug}`));

describe('engine parity: excludePrivate on page reads', () => {
  parityTest(
    'a remote read under the brain policy alone (serve --http, a token bound to nobody) reads the same pages as without it',
    { methods: ['putPage', 'addLink', 'readPageSnapshot'] },
    async (engine) => {
      // The open member-access form holds only on a brain where no page names readers (access.restrictions_present
      // unset), so this fixture leaves out the pages whose readers or origins name a member.
      const named = new Set(['notes/readers', 'atoms/origin-readers', 'concepts/readers-input', 'notes/lineage-readers']);
      const pages = PAGES.filter(([slug]) => !named.has(slug));
      for (const [slug, type, frontmatter] of pages) {
        await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter });
      }
      await engine.addLink('concepts/private-input', 'atoms/no-visibility', '', 'synthesized_from', 'concept-provenance');
      await engine.addLink('concepts/open-input', 'notes/open', '', 'synthesized_from', 'concept-provenance');
      // The access serve --http gives a token bound to nobody: no identity, the open member-access form, and the brain's
      // remote policy, whose schema version (a current brain's, as serve --http reads it) picks the owner-only form.
      const remote = {
        identity: [], hidePrivate: true, restricted: false,
        remotePolicy: { privacyRelaxed: false, restricted: false, ownerMember: null, ownerReadsRestricted: false, membersReadLineage: false,
          schemaVersion: LATEST_VERSION },
      };
      const read = async (slug: string) => (await engine.readPageSnapshot(slug, { excludePrivate: true, sourceId: 'default' }))?.page.slug ?? null;
      const slugs = pages.map(([slug]) => slug);
      const local = await withCallerAccess({ identity: [], hidePrivate: true, restricted: false }, async () => Promise.all(slugs.map(read)));
      const viaRemote = await withCallerAccess(remote, async () => Promise.all(slugs.map(read)));
      expect(sorted(viaRemote.filter((s): s is string => s !== null))).toContain('notes/open');
      expect(viaRemote).not.toContain('notes/private');
      expect(viaRemote).toEqual(local);
      return { kept: sorted(viaRemote.filter((s): s is string => s !== null)) };
    },
  );

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

  parityTest(
    'findAnomalies ignores a takes-holder allow-list, as the SQL reads none, and still applies excludePrivate',
    { methods: ['putPage', 'addLink', 'addTag', 'getPage', 'findAnomalies'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      for (const [slug] of PAGES) await engine.addTag(slug, 'probe');
      const today = new Date((await engine.getPage('notes/private'))!.updated_at).toISOString().slice(0, 10);
      const view = (rows: Awaited<ReturnType<typeof engine.findAnomalies>>) =>
        sorted(rows.map((r) => ({ ...pick(r, ['cohort_kind', 'cohort_value', 'count'] as const), page_slugs: sorted(r.page_slugs) })),
          (r) => `${r.cohort_kind}:${r.cohort_value}`);
      // An MCP caller's read policy carries its takes-holder allow-list into every read, this one included: the op
      // spreads the policy, so the key arrives although AnomaliesOpts does not name it.
      const policy = { excludePrivate: true, takesHoldersAllowList: ['alice-example'] };
      const held = view(await engine.findAnomalies({ since: today, lookback_days: 1, ...policy }));
      const plain = view(await engine.findAnomalies({ since: today, lookback_days: 1, excludePrivate: true }));
      expect(held.find((r) => r.cohort_value === 'probe')?.page_slugs).toEqual(KEPT);
      expect(held).toEqual(plain);
      return { held };
    },
  );

  parityTest(
    'getSalienceScores ignores the whoknows options it is handed (topic, explain, onMeta) and still applies excludePrivate',
    { methods: ['putPage', 'addLink', 'setEmotionalWeightBatch', 'getSalienceScores'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      await engine.setEmotionalWeightBatch([{ slug: 'notes/private', source_id: 'default', weight: 1 }]);
      const refs = PAGES.map(([slug]) => ({ slug, source_id: 'default' }));
      const view = (scores: Map<string, number>) => sorted([...scores].map(([key, score]) => `${key}=${Math.round(score * 1000) / 1000}`));
      // whoknows passes its whole options object: the topic, the explain flag and the meta callback ride along.
      const whoknows = { topic: 'probe', limit: 5, explain: true, types: ['person' as never], onMeta: () => {}, sourceId: 'default', excludePrivate: true };
      const asWhoknows = await engine.getSalienceScores(refs, whoknows as never);
      const plain = await engine.getSalienceScores(refs, { sourceId: 'default', excludePrivate: true });
      expect(sorted([...asWhoknows.keys()])).toEqual(sorted(KEPT.map((s) => `default::${s}`)));
      expect(view(asWhoknows)).toEqual(view(plain));
      return { asWhoknows: view(asWhoknows) };
    },
  );

  parityTest(
    'getEffectiveDates ignores the whoknows options it is handed and still applies excludePrivate',
    { methods: ['putPage', 'addLink', 'getEffectiveDates'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      const refs = PAGES.map(([slug]) => ({ slug, source_id: 'default' }));
      // whoknows passes its whole options object, with the remote read policy's holder list and safe-chunk flag.
      const whoknows = {
        topic: 'probe', limit: 5, explain: true, types: ['person' as never], onMeta: () => {},
        sourceId: 'default', excludePrivate: true, requireSafeChunks: true, takesHoldersAllowList: ['world'],
      };
      const asWhoknows = sorted([...(await engine.getEffectiveDates(refs, whoknows as never)).keys()]);
      const plain = sorted([...(await engine.getEffectiveDates(refs, { sourceId: 'default', excludePrivate: true })).keys()]);
      expect(asWhoknows).toEqual(sorted(KEPT.map((s) => `default::${s}`)));
      expect(asWhoknows).toEqual(plain);
      return { asWhoknows };
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

  parityTest(
    'getChunkPage ignores a takes-holder allow-list, as the SQL reads none, and still applies excludePrivate',
    { methods: ['putPage', 'addLink', 'getChunkPage'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      for (const slug of ['notes/open', 'notes/private', 'notes/readers']) await installChunks(engine, slug, [chunk(0, `About ${slug}.`)]);
      // An MCP caller's read policy carries its takes-holder allow-list into get_chunks.
      const read = async (scope: Record<string, unknown>) => {
        const seen: string[] = [];
        for (const slug of ['notes/open', 'notes/private', 'notes/readers']) {
          const page = await engine.getChunkPage(slug, { sourceId: 'default', fromIndex: 0, limit: 10, ...scope });
          seen.push(`${slug}:${page.total_chunks}:${page.chunks.map((c) => c.chunk_text).join('|')}`);
        }
        return seen;
      };
      const held = await read({ excludePrivate: true, takesHoldersAllowList: ['alice-example'] });
      const heldOpen = await read({ takesHoldersAllowList: [] });
      expect(held).toEqual(['notes/open:1:About notes/open.', 'notes/private:0:', 'notes/readers:0:']);
      expect(held).toEqual(await read({ excludePrivate: true }));
      expect(heldOpen).toEqual(await read({}));
      return { held, heldOpen };
    },
  );
});

describe('engine parity: excludePrivate for a caller with a reader identity and a private-readable grant', () => {
  parityTest(
    'getRecentSalience and getSalienceScores under excludePrivate apply a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'setEmotionalWeightBatch', 'getRecentSalience', 'getSalienceScores'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      await engine.setEmotionalWeightBatch([{ slug: 'notes/private', source_id: 'default', weight: 1 }]);
      const refs = [...PAGES.map(([slug]) => ({ slug, source_id: 'default' })), { slug: 'notes/private', source_id: 'other' }];
      const recent = await asCaller(async () => ids(await engine.getRecentSalience({ days: 7, limit: 100, sourceId: 'default', excludePrivate: true })));
      const scores = await asCaller(async () =>
        sorted([...(await engine.getSalienceScores(refs, { sourceIds: ['default', 'other'], excludePrivate: true })).keys()]));
      expect(recent.member).toEqual(CALLER_KEPT.member.map((s) => `default:${s}`));
      expect(recent.granted).toEqual(CALLER_KEPT.granted.map((s) => `default:${s}`));
      expect(scores.member).toEqual(CALLER_KEPT.member.map((s) => `default::${s}`));
      expect(scores.granted).toEqual(CALLER_KEPT.granted.map((s) => `default::${s}`));
      return { recent, scores };
    },
  );

  parityTest(
    'findAnomalies under excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'addTag', 'getPage', 'findAnomalies'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      for (const [slug] of PAGES) await engine.addTag(slug, 'probe');
      const today = new Date((await engine.getPage('notes/open'))!.updated_at).toISOString().slice(0, 10);
      const probe = await asCaller(async () => sorted((await engine.findAnomalies({ since: today, lookback_days: 1, excludePrivate: true }))
        .find((r) => r.cohort_value === 'probe')?.page_slugs ?? []));
      expect(probe).toEqual(CALLER_KEPT);
      return probe;
    },
  );

  parityTest(
    'getChunkPage and getChunkWindows under excludePrivate apply a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'sealChunks', 'getPage', 'getChunkPage', 'getChunkWindows'] },
    async (engine, backend) => {
      await fixture(engine, backend);
      for (const [slug] of PAGES) await installChunks(engine, slug, [chunk(0, `About ${slug}.`)]);
      const slugOf = new Map<number, string>();
      for (const [slug] of PAGES) slugOf.set((await engine.getPage(slug))!.id, slug);
      const pages = await asCaller(async () => {
        const seen: string[] = [];
        for (const [slug] of PAGES) {
          const page = await engine.getChunkPage(slug, { sourceId: 'default', fromIndex: 0, limit: 10, excludePrivate: true });
          if (page.total_chunks > 0) seen.push(slug);
        }
        return sorted(seen);
      });
      const requests = [...slugOf.keys()].map((page_id) => ({ page_id, from_index: 0, to_index: 5, priority: 0 }));
      const windows = await asCaller(async () => sorted((await engine.getChunkWindows(requests, {
        chunkSources: ['compiled_truth'], maxRows: 100, sourceIds: ['default'], excludePrivate: true,
      })).map((p) => slugOf.get(p.page_id)!)));
      expect(pages).toEqual(CALLER_KEPT);
      expect(windows).toEqual(CALLER_KEPT);
      return { pages, windows };
    },
  );
});

describe('engine parity: excludePrivate on tags and takes', () => {
  /** One tag per fixture page, named after the page, plus the same slug's tags in `other`. */
  async function tagged(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await fixture(engine, backend);
    for (const [slug] of PAGES) await engine.addTag(slug, `tag-${slug.replace('/', '-')}`);
    await engine.addTag('notes/private', 'other-private-tag', { sourceId: 'other' });
    await engine.addTag('notes/open', 'other-open-tag', { sourceId: 'other' });
  }
  /** The fixture pages whose tags `getTags` returns under `opts`. */
  const tagsSeen = async (engine: BrainEngine, opts: Parameters<BrainEngine['getTags']>[1]) => {
    const seen: string[] = [];
    for (const [slug] of PAGES) if ((await engine.getTags(slug, opts)).length > 0) seen.push(slug);
    return sorted(seen);
  };

  parityTest(
    'getTags under excludePrivate returns no tag of a page the page policy hides, in one source or across a grant',
    { methods: ['putPage', 'addLink', 'addTag', 'getTags'] },
    async (engine, backend) => {
      await tagged(engine, backend);
      const all = await tagsSeen(engine, undefined);
      const kept = await tagsSeen(engine, { excludePrivate: true });
      const keptLive = await tagsSeen(engine, { excludePrivate: true, liveOnly: true });
      const privateTags = await engine.getTags('notes/private', { excludePrivate: true });
      const privateOff = await engine.getTags('notes/private');
      const federatedPrivate = await engine.getTags('notes/private', { sourceIds: ['default', 'other'], excludePrivate: true });
      const federatedOpen = await engine.getTags('notes/open', { sourceIds: ['default', 'other'], excludePrivate: true });
      const otherPrivate = await engine.getTags('notes/private', { sourceId: 'other', excludePrivate: true });
      const otherOpen = await engine.getTags('notes/open', { sourceId: 'other', excludePrivate: true });
      expect(all).toEqual(sorted(PAGES.map(([slug]) => slug)));
      expect(kept).toEqual(KEPT);
      expect(keptLive).toEqual(KEPT);
      expect(privateOff).toEqual(['tag-notes-private']);
      expect(privateTags).toEqual([]);
      expect(federatedPrivate).toEqual([]);
      expect(federatedOpen).toEqual(['other-open-tag', 'tag-notes-open']);
      expect(otherPrivate).toEqual([]);
      return { all, kept, keptLive, privateTags, privateOff, federatedPrivate, federatedOpen, otherPrivate, otherOpen };
    },
  );

  parityTest(
    'getTags under excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'addTag', 'getTags'] },
    async (engine, backend) => {
      await tagged(engine, backend);
      const seen = await asCaller(() => tagsSeen(engine, { excludePrivate: true }));
      const otherPrivate = await asCaller(() => engine.getTags('notes/private', { sourceId: 'other', excludePrivate: true }));
      expect(seen).toEqual(CALLER_KEPT);
      // The grant names `default` only: the private page in `other` stays hidden.
      expect(otherPrivate).toEqual({ member: [], granted: [] });
      return { seen, otherPrivate };
    },
  );

  /** One resolved bet per fixture page (claim `probe claim <slug>`), plus a private page's bet in `other`. */
  async function withTakes(engine: BrainEngine, backend: Parameters<typeof createSource>[1], resolvedBy = 'garry') {
    await fixture(engine, backend);
    const slugOf = new Map<number, string>();
    let n = 0;
    for (const [slug] of PAGES) {
      const id = Number((await engine.getPage(slug))!.id);
      slugOf.set(id, slug);
      const weight = [0.15, 0.35, 0.55, 0.75, 0.95][n % 5]!;
      await engine.addTakesBatch([{ page_id: id, row_num: 1, claim: `probe claim ${slug}`, kind: 'bet', holder: 'garry', weight }]);
      await engine.resolveTake(id, 1, { quality: n % 3 === 0 ? 'incorrect' : 'correct', resolvedBy });
      n++;
    }
    const other = Number((await engine.getPage('notes/private', { sourceId: 'other' }))!.id);
    slugOf.set(other, 'other:notes/private');
    await engine.addTakesBatch([{ page_id: other, row_num: 1, claim: 'probe claim other private', kind: 'bet', holder: 'garry', weight: 0.9 }]);
    await engine.resolveTake(other, 1, { quality: 'correct', resolvedBy });
    return slugOf;
  }
  type Reads = { list: string[]; search: string[]; card: unknown; curve: unknown };
  const takesRead = async (engine: BrainEngine, slugOf: Map<number, string>, opts: { excludePrivate?: boolean; sourceId?: string }): Promise<Reads> => {
    const card = await engine.getScorecard({ ...opts }, undefined);
    const curve = (await engine.getCalibrationCurve({ ...opts }, undefined))
      .map((b) => ({ lo: round(b.bucket_lo), hi: round(b.bucket_hi), n: b.n, observed: round(b.observed), predicted: round(b.predicted) }));
    return {
      list: sorted((await engine.listTakes({ ...opts, limit: 500 })).map((t) => slugOf.get(t.page_id)!)),
      search: sorted((await engine.searchTakes('probe claim', { ...opts, limit: 100 })).map((t) => slugOf.get(t.page_id)!)),
      card: { ...card, brier: round(card.brier), accuracy: round(card.accuracy), partial_rate: round(card.partial_rate) },
      curve,
    };
  };
  const round = (n: number | null | undefined) => (n == null ? n : Number(n.toFixed(4)));

  parityTest(
    'listTakes, searchTakes, getScorecard and getCalibrationCurve under excludePrivate read only takes on pages the page policy keeps',
    { methods: ['putPage', 'addLink', 'getPage', 'addTakesBatch', 'resolveTake', 'listTakes', 'searchTakes', 'getScorecard', 'getCalibrationCurve'] },
    async (engine, backend) => {
      const slugOf = await withTakes(engine, backend);
      const off = await takesRead(engine, slugOf, {});
      const on = await takesRead(engine, slugOf, { excludePrivate: true });
      const other = await takesRead(engine, slugOf, { excludePrivate: true, sourceId: 'other' });
      expect(off.list).toHaveLength(PAGES.length + 1);
      expect(on.list).toEqual(KEPT);
      expect(on.search).toEqual(KEPT);
      expect(other.list).toEqual([]);
      expect(other.search).toEqual([]);
      expect((on.card as { total_bets: number }).total_bets).toBe(KEPT.length);
      expect((other.card as { total_bets: number }).total_bets).toBe(0);
      expect(other.curve).toEqual([]);
      expect(on.curve).not.toEqual(off.curve);
      return { off, on, other };
    },
  );

  parityTest(
    'the takes reads under excludePrivate apply a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'getPage', 'addTakesBatch', 'resolveTake', 'listTakes', 'searchTakes', 'getScorecard', 'getCalibrationCurve'] },
    async (engine, backend) => {
      const slugOf = await withTakes(engine, backend);
      const reads = await asCaller(() => takesRead(engine, slugOf, { excludePrivate: true }));
      expect(reads.member.list).toEqual(CALLER_KEPT.member);
      expect(reads.granted.list).toEqual(CALLER_KEPT.granted);
      expect(reads.granted.search).toEqual(CALLER_KEPT.granted);
      expect((reads.granted.card as { total_bets: number }).total_bets).toBe(CALLER_KEPT.granted.length);
      return reads;
    },
  );

  parityTest(
    'getScorecard and getCalibrationCurve under a remote read policy filter holders by the allow-list argument',
    { methods: ['putPage', 'addLink', 'getPage', 'addTakesBatch', 'resolveTake', 'getScorecard', 'getCalibrationCurve'] },
    async (engine, backend) => {
      await withTakes(engine, backend);
      // `readPolicyOpts` (ops/context.ts) also copies the holder allow-list into the options; the ops pass it as the
      // second argument too, and that argument is the one the SQL reads.
      const read = async (holders: string[]) => {
        const opts = { excludePrivate: true as const, takesHoldersAllowList: holders };
        const card = await engine.getScorecard(opts, holders);
        const curve = await engine.getCalibrationCurve(opts, holders);
        return {
          bets: card.total_bets,
          brier: round(card.brier),
          curve: curve.map((b) => ({ lo: round(b.bucket_lo), n: b.n, observed: round(b.observed) })),
        };
      };
      const plain = await engine.getScorecard({ excludePrivate: true }, undefined);
      const garry = await read(['garry']);
      const nobody = await read(['nobody']);
      expect(garry.bets).toBe(KEPT.length);
      expect(garry.brier).toBe(round(plain.brier));
      expect(nobody).toEqual({ bets: 0, brier: null, curve: [] });
      return { garry, nobody };
    },
  );

  parityTest(
    'countMcpResolvedTakes under excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'getPage', 'addTakesBatch', 'resolveTake', 'countMcpResolvedTakes'] },
    async (engine, backend) => {
      // takes_scorecard adds this count to its answer: a caller the scorecard serves must be served here too.
      await withTakes(engine, backend, 'mcp:probe-client');
      const count = (sourceIds: string[] | null, excludePrivate: boolean) =>
        engine.countMcpResolvedTakes({ sourceIds, holders: ['garry'], excludePrivate });
      const all = await count(null, false);
      const plain = await count(['default'], true);
      const caller = await asCaller(() => count(['default'], true));
      const callerFederated = await asCaller(() => count(['default', 'other'], true));
      expect(all).toBe(PAGES.length + 1);
      expect(plain).toBe(KEPT.length);
      expect(caller).toEqual({ member: CALLER_KEPT.member.length, granted: CALLER_KEPT.granted.length });
      // The grant names `default` only: the private page's take in `other` stays out of the count.
      expect(callerFederated).toEqual(caller);
      return { all, plain, caller, callerFederated };
    },
  );
});

describe('engine parity: excludePrivate on raw data, versions and wanted pages', () => {
  /** The fixture pages whose rows `read(slug)` returns, in `default`. */
  const seenIn = async (read: (slug: string) => Promise<unknown[]>) => {
    const seen: string[] = [];
    for (const [slug] of PAGES) if ((await read(slug)).length > 0) seen.push(slug);
    return sorted(seen);
  };

  /** One raw-data row per fixture page, plus one on each page of `other`. */
  async function withRawData(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await fixture(engine, backend);
    for (const [slug] of PAGES) await engine.putRawData(slug, 'probe', { slug });
    await engine.putRawData('notes/private', 'probe', { slug: 'other:notes/private' }, { sourceId: 'other' });
    await engine.putRawData('notes/open', 'probe', { slug: 'other:notes/open' }, { sourceId: 'other' });
  }

  parityTest(
    'getRawData under excludePrivate returns no raw data of a page the page policy hides, in one source or across a grant',
    { methods: ['putPage', 'addLink', 'putRawData', 'getRawData'] },
    async (engine, backend) => {
      await withRawData(engine, backend);
      const all = await seenIn((slug) => engine.getRawData(slug));
      const kept = await seenIn((slug) => engine.getRawData(slug, undefined, { excludePrivate: true }));
      const keptNamed = await seenIn((slug) => engine.getRawData(slug, 'probe', { excludePrivate: true, sourceId: 'default' }));
      const federated = (slug: string) => engine.getRawData(slug, undefined, { sourceIds: ['default', 'other'], excludePrivate: true })
        .then((rows) => sorted(rows.map((r) => String((r.data as { slug: string }).slug))));
      const privateAcross = await federated('notes/private');
      const openAcross = await federated('notes/open');
      expect(all).toEqual(sorted(PAGES.map(([slug]) => slug)));
      expect(kept).toEqual(KEPT);
      expect(keptNamed).toEqual(KEPT);
      expect(privateAcross).toEqual([]);
      expect(openAcross).toEqual(['notes/open', 'other:notes/open']);
      return { all, kept, keptNamed, privateAcross, openAcross };
    },
  );

  parityTest(
    'getRawData under excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'putRawData', 'getRawData'] },
    async (engine, backend) => {
      await withRawData(engine, backend);
      const seen = await asCaller(() => seenIn((slug) => engine.getRawData(slug, undefined, { excludePrivate: true })));
      const otherPrivate = await asCaller(async () =>
        (await engine.getRawData('notes/private', undefined, { sourceId: 'other', excludePrivate: true })).length);
      expect(seen).toEqual(CALLER_KEPT);
      expect(otherPrivate).toEqual({ member: 0, granted: 0 });
      return { seen, otherPrivate };
    },
  );

  /**
   * One version per fixture page, plus a page whose first version was private and whose second names readers, and
   * whose page is open now: the page policy keeps the page, the version policy judges each version on its own fields.
   */
  async function withVersions(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await fixture(engine, backend);
    for (const [slug] of PAGES) await engine.createVersion(slug);
    await engine.createVersion('notes/private', { sourceId: 'other' });
    const flip = (frontmatter: Record<string, unknown>) =>
      engine.putPage('notes/flipped', { type: 'note', title: 'Flipped', compiled_truth: 'Flipped.', timeline: '', frontmatter });
    await flip({ visibility: 'private' });
    await engine.createVersion('notes/flipped');
    await flip({ readable_by: ['alice-example'] });
    await engine.createVersion('notes/flipped');
    await flip({ access: 'restricted' });
    await engine.createVersion('notes/flipped');
    await flip({ pinned_question: true, visibility: 'world' });
    await engine.createVersion('notes/flipped');
    await flip({});
    await engine.createVersion('notes/flipped');
  }
  /** The frontmatter of each version of `notes/flipped` a read returns, newest first. */
  const flipped = async (engine: BrainEngine, opts: Parameters<BrainEngine['getVersions']>[1]) =>
    (await engine.getVersions('notes/flipped', opts))
      // Keys sorted: jsonb reorders object keys and the Rust store keeps them as written; the order is no contract.
      .map((v) => JSON.stringify(Object.fromEntries(Object.entries(v.frontmatter ?? {}).sort(([a], [b]) => a.localeCompare(b)))));

  parityTest(
    'getVersions under excludePrivate returns no version of a hidden page and no version whose own fields are private',
    { methods: ['putPage', 'addLink', 'createVersion', 'getVersions'] },
    async (engine, backend) => {
      await withVersions(engine, backend);
      const all = await seenIn((slug) => engine.getVersions(slug));
      const kept = await seenIn((slug) => engine.getVersions(slug, { excludePrivate: true }));
      const flippedAll = await flipped(engine, undefined);
      const flippedKept = await flipped(engine, { excludePrivate: true });
      const flippedTop = await flipped(engine, { excludePrivate: true, limit: 1, includeBody: false });
      const otherPrivate = (await engine.getVersions('notes/private', { sourceId: 'other', excludePrivate: true })).length;
      const federated = (await engine.getVersions('notes/private', { sourceIds: ['default', 'other'], excludePrivate: true })).length;
      expect(all).toEqual(sorted(PAGES.map(([slug]) => slug)));
      expect(kept).toEqual(KEPT);
      expect(flippedAll.length).toBeGreaterThanOrEqual(5);
      expect(flippedKept.every((fm) => !/private|readable_by|restricted|pinned_question/.test(fm))).toBe(true);
      expect(flippedKept.length).toBeGreaterThan(0);
      expect(otherPrivate).toBe(0);
      expect(federated).toBe(0);
      return { all, kept, flippedAll, flippedKept, flippedTop, otherPrivate, federated };
    },
  );

  parityTest(
    'getVersions under excludePrivate applies a caller\'s reader identity and private-readable grant to pages and versions',
    { methods: ['putPage', 'addLink', 'createVersion', 'getVersions'] },
    async (engine, backend) => {
      await withVersions(engine, backend);
      const seen = await asCaller(() => seenIn((slug) => engine.getVersions(slug, { excludePrivate: true })));
      const versions = await asCaller(() => flipped(engine, { excludePrivate: true }));
      expect(seen).toEqual(CALLER_KEPT);
      expect(versions.member.some((fm) => fm.includes('readable_by'))).toBe(true);
      expect(versions.member.some((fm) => fm.includes('"private"'))).toBe(false);
      expect(versions.granted.some((fm) => fm.includes('pinned_question'))).toBe(false);
      return { seen, versions };
    },
  );

  parityTest(
    'getRawData and getVersions ignore the rest of a remote caller\'s read policy and still apply excludePrivate',
    { methods: ['putPage', 'addLink', 'putRawData', 'createVersion', 'getRawData', 'getVersions'] },
    async (engine, backend) => {
      await withRawData(engine, backend);
      for (const [slug] of PAGES) await engine.createVersion(slug);
      // The MCP get_raw_data and get_versions tools pass the whole read policy: the safe-chunk flag and the
      // takes-holder allow-list ride along, and neither read uses them.
      const policy = { excludePrivate: true, requireSafeChunks: true, takesHoldersAllowList: ['world'] };
      const raw = await seenIn((slug) => engine.getRawData(slug, undefined, policy));
      const versions = await seenIn((slug) => engine.getVersions(slug, { ...policy, limit: 5 }));
      expect(raw).toEqual(KEPT);
      expect(versions).toEqual(KEPT);
      return { raw, versions };
    },
  );

  /** Each fixture page wants a missing page named after it, and wants the name `person` an open and a hidden page carry. */
  async function withWanted(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await fixture(engine, backend);
    await engine.putPage('people/hidden/person', { type: 'person', title: 'Hidden', compiled_truth: 'Hidden.', timeline: '', frontmatter: { visibility: 'private' } });
    await engine.putPage('people/open/person', { type: 'person', title: 'Open', compiled_truth: 'Open.', timeline: '', frontmatter: {} });
    for (const [slug] of PAGES) {
      const origin = await engine.getPage(slug, { sourceId: 'default' });
      const rows = [
        { producer: 'body' as const, ref_kind: 'slug' as const, target_source_id: 'default', target_ref: `missing/${slug.replace('/', '-')}`, link_type: '', context: '' },
        { producer: 'body' as const, ref_kind: 'name' as const, target_source_id: 'default', target_ref: 'person', link_type: 'mentions', context: '' },
      ];
      await engine.replaceWantedLinkRows({ pageId: Number(origin!.id), sourceId: 'default' }, { rows, producers: ['body'], readAt: '2026-01-02T03:04:05.678Z' });
    }
  }
  const wanted = async (engine: BrainEngine, opts: { excludePrivate?: boolean; limit?: number; offset?: number }) => {
    const { total, rows } = await engine.listWantedPages({ sourceId: 'default', limit: 100, offset: 0, ...opts });
    const person = rows.find((r) => r.target === 'person');
    return {
      total,
      targets: sorted(rows.filter((r) => r.target !== 'person').map((r) => r.target.replace('missing/', '').replace('-', '/'))),
      person: person && { referenced_by: person.referenced_by, origins: person.sample_origins.length, matches: person.existing_matches.map((m) => m.slug) },
    };
  };

  parityTest(
    'listWantedPages under excludePrivate counts no wanted link from a hidden page and names no hidden page as a match',
    { methods: ['putPage', 'addLink', 'getPage', 'replaceWantedLinkRows', 'listWantedPages'] },
    async (engine, backend) => {
      await withWanted(engine, backend);
      const all = await wanted(engine, {});
      const kept = await wanted(engine, { excludePrivate: true });
      const paged = await wanted(engine, { excludePrivate: true, limit: 2, offset: 1 });
      expect(all.targets).toEqual(sorted(PAGES.map(([slug]) => slug)));
      expect(all.person?.matches).toEqual(['people/hidden/person', 'people/open/person']);
      expect(kept.targets).toEqual(KEPT);
      expect(kept.total).toBe(KEPT.length + 1);
      expect(kept.person).toEqual({ referenced_by: KEPT.length, origins: 3, matches: ['people/open/person'] });
      return { all, kept, paged: { total: paged.total, n: paged.targets.length + (paged.person ? 1 : 0) } };
    },
  );

  parityTest(
    'listWantedPages under excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'getPage', 'replaceWantedLinkRows', 'listWantedPages'] },
    async (engine, backend) => {
      await withWanted(engine, backend);
      const seen = await asCaller(() => wanted(engine, { excludePrivate: true }));
      expect(seen.member.targets).toEqual(CALLER_KEPT.member);
      expect(seen.granted.targets).toEqual(CALLER_KEPT.granted);
      expect(seen.granted.person?.matches).toEqual(['people/hidden/person', 'people/open/person']);
      return seen;
    },
  );
});
