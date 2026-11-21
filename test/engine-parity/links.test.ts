/**
 * BrainEngine parity — links family (edges, derived-link replacement, graph
 * traversal, relational fan-out, backlink/adjacency signals, page-id signal
 * reads, orphans).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every link write, link read, traversal and page-id signal read
 *    returns the same observable result on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts).
 *  - Regression: an engine that drifts on edge dedup, removal counts, link
 *    provenance, traversal order/cycle handling, source isolation, backlink
 *    counts or orphan detection — the graph layer search ranking, `gbrain
 *    graph-query` and `gbrain orphans` read from.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    entirely without Postgres and its graph cases hand-roll each engine; the
 *    per-engine unit tests never compare two engines on one scenario.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 *    Page ids come from putPage's returned Page and are mapped back to slugs
 *    before anything is returned (sequences are not reset on Postgres).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, LinkBatchInput } from '../../src/core/engine.ts';
import type { Link, PageInput, PageType, RelationalFanoutOpts, SearchResult } from '../../src/core/types.ts';
import { linkFamily } from '../../src/core/search/relational-chain.ts';
import { createSource, parityArms, pick, sorted } from './harness.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { runPostFusionStages, type PostFusionOpts } from '../../src/core/search/hybrid.ts';

const { parityTest } = parityArms(testBackends());

const LINK_KEYS = ['from_slug', 'from_source_id', 'to_slug', 'to_source_id', 'link_type', 'context', 'link_source', 'origin_slug', 'origin_source_id', 'origin_field'] as const;

const linkView = (l: Link) => pick(l, LINK_KEYS);
const linkViews = (rows: Link[]) => rows.map(linkView);
const linkKey = (l: { from_slug: string; to_slug: string; link_type: string; link_source?: string | null }) =>
  `${l.from_slug}>${l.to_slug}:${l.link_type}:${l.link_source ?? ''}`;
const sortedLinks = (rows: Link[]) => sorted(linkViews(rows), (l) => `${linkKey(l)}|${l.origin_slug ?? ''}`);

function page(title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra };
}

async function seedPages(engine: BrainEngine, slugs: string[], type: PageType = 'note', opts?: { sourceId?: string }) {
  const ids = new Map<string, number>();
  for (const slug of slugs) ids.set(slug, (await engine.putPage(slug, page(slug, { type }), opts)).id);
  return ids;
}

/** Map a page-id keyed Map back to slug keys, sorted. */
function bySlug<V>(ids: Map<string, number>, m: Map<number, V>): Array<[string, V]> {
  const slugOf = new Map([...ids].map(([slug, id]) => [id, slug]));
  return sorted([...m].map(([id, v]) => [slugOf.get(id) ?? `<unknown ${id}>`, v] as [string, V]), ([s]) => s);
}

/** Seed: a -> b -> a (cycle), b -> c -> d chain. */
async function seedChain(engine: BrainEngine) {
  await seedPages(engine, ['tg/a', 'tg/b', 'tg/c', 'tg/d']);
  await engine.addLink('tg/a', 'tg/b', 'fwd-ctx', 'cycle-fwd', 'manual');
  await engine.addLink('tg/b', 'tg/a', 'back-ctx', 'cycle-back', 'manual');
  await engine.addLink('tg/b', 'tg/c', 'step-ctx', 'step', 'manual');
  await engine.addLink('tg/c', 'tg/d', 'deep-ctx', 'deep', 'manual');
}

describe('engine parity: links', () => {
  parityTest(
    'addLink then getLinks/getBacklinks round-trip with provenance; duplicates are idempotent',
    { methods: ['addLink', 'getLinks', 'getBacklinks', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['people/alice', 'companies/acme', 'notes/memo']);
      await engine.addLink('people/alice', 'companies/acme', 'Alice works at Acme', 'works_at', 'manual');
      await engine.addLink('people/alice', 'companies/acme', 'Alice works at Acme', 'works_at', 'manual');
      await engine.addLink('people/alice', 'companies/acme', 'invested', 'invested_in', 'manual');
      // Defaults: link_type '' and link_source 'markdown'.
      await engine.addLink('notes/memo', 'people/alice', 'memo mentions alice');
      await engine.addLink('companies/acme', 'people/alice', 'fm', 'key_people', 'frontmatter', 'companies/acme', 'key_people');

      const out = sortedLinks(await engine.getLinks('people/alice'));
      const back = sortedLinks(await engine.getBacklinks('people/alice'));
      expect(out.map(linkKey)).toEqual(['people/alice>companies/acme:invested_in:manual', 'people/alice>companies/acme:works_at:manual']);
      expect(back.map((l) => l.from_slug)).toEqual(['companies/acme', 'notes/memo']);
      const fm = back.find((l) => l.link_source === 'frontmatter');
      expect(fm).toMatchObject({ origin_slug: 'companies/acme', origin_field: 'key_people' });
      const memo = back.find((l) => l.from_slug === 'notes/memo');
      expect(memo?.link_source).toBe('markdown');
      expect(await engine.getLinks('companies/nobody')).toEqual([]);
      return { out, back, none: await engine.getBacklinks('notes/memo') };
    },
  );

  parityTest(
    'addLinksBatch inserts new edges, dedups conflicts and drops edges to missing pages',
    { methods: ['addLinksBatch', 'getLinks', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['b/one', 'b/two', 'b/three']);
      const batch: LinkBatchInput[] = [
        { from_slug: 'b/one', to_slug: 'b/two', link_type: 'cites', context: 'c1', link_source: 'manual' },
        { from_slug: 'b/one', to_slug: 'b/three', link_type: 'cites', context: 'c2', link_source: 'manual' },
        { from_slug: 'b/one', to_slug: 'b/missing', link_type: 'cites', link_source: 'manual' },
        { from_slug: 'b/two', to_slug: 'b/three' },
      ];
      const first = await engine.addLinksBatch(batch);
      const replay = await engine.addLinksBatch(batch);
      const empty = await engine.addLinksBatch([]);
      expect(first).toBe(3);
      expect(replay).toBe(0);
      expect(empty).toBe(0);
      const one = sortedLinks(await engine.getLinks('b/one'));
      const two = sortedLinks(await engine.getLinks('b/two'));
      return { first, replay, empty, one, two };
    },
  );

  parityTest(
    'removeLink honors link type and provenance and returns the deleted row count',
    { methods: ['removeLink', 'addLink', 'getLinks', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['r/from', 'r/to']);
      const seed = async () => {
        await engine.addLink('r/from', 'r/to', 'x', 'cites', 'manual');
        await engine.addLink('r/from', 'r/to', 'y', 'cites', 'markdown');
        await engine.addLink('r/from', 'r/to', 'z', 'mentions', 'manual');
      };
      await seed();
      const typo = await engine.removeLink('r/from', 'r/typo');
      const wrongType = await engine.removeLink('r/from', 'r/to', 'nope');
      const wrongSource = await engine.removeLink('r/from', 'r/to', 'cites', 'frontmatter');
      expect(typo).toBe(0);
      expect(wrongType).toBe(0);
      expect(wrongSource).toBe(0);
      const typed = await engine.removeLink('r/from', 'r/to', 'cites', 'manual');
      expect(typed).toBe(1);
      const afterTyped = sortedLinks(await engine.getLinks('r/from')).map(linkKey);
      const allTypes = await engine.removeLink('r/from', 'r/to');
      expect(allTypes).toBe(2);
      const afterAll = await engine.getLinks('r/from');
      expect(afterAll).toEqual([]);
      const again = await engine.removeLink('r/from', 'r/to');
      await seed();
      const bySource = await engine.removeLink('r/from', 'r/to', undefined, 'manual');
      const left = sortedLinks(await engine.getLinks('r/from')).map(linkKey);
      return { typo, wrongType, wrongSource, typed, afterTyped, allTypes, again, bySource, left };
    },
  );

  parityTest(
    'removeLinksByPagesAndSource deletes only the named provenance for the named pages',
    { methods: ['removeLinksByPagesAndSource', 'addLink', 'getLinks', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['m/a', 'm/b', 'm/c']);
      await engine.addLink('m/a', 'm/b', '', 'mentions', 'mentions');
      await engine.addLink('m/a', 'm/c', '', 'mentions', 'mentions');
      await engine.addLink('m/a', 'm/c', '', 'cites', 'manual');
      await engine.addLink('m/b', 'm/c', '', 'mentions', 'mentions');
      const none = await engine.removeLinksByPagesAndSource([], { linkSource: 'mentions' });
      const wrongSource = await engine.removeLinksByPagesAndSource([{ slug: 'm/a', source_id: 'nope' }], { linkSource: 'mentions' });
      expect(none).toBe(0);
      expect(wrongSource).toBe(0);
      // A keep list only protects typed_ner rows; mentions rows are removed regardless.
      const removed = await engine.removeLinksByPagesAndSource(
        [{ slug: 'm/a', source_id: 'default' }],
        { linkSource: 'mentions', keepTypedNerPairs: [{ from_slug: 'm/a', from_source_id: 'default', to_slug: 'm/b', to_source_id: 'default' }] },
      );
      expect(removed).toBe(2);
      return {
        none, wrongSource, removed,
        a: sortedLinks(await engine.getLinks('m/a')).map(linkKey),
        b: sortedLinks(await engine.getLinks('m/b')).map(linkKey),
      };
    },
  );

  parityTest(
    'listLinkSources counts edges per provenance, count DESC then name ASC',
    { methods: ['listLinkSources', 'addLink', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['ls/a', 'ls/b', 'ls/c']);
      await engine.addLink('ls/a', 'ls/b', '', 'cites', 'citation-graph');
      await engine.addLink('ls/a', 'ls/c', '', 'cites', 'citation-graph');
      await engine.addLink('ls/b', 'ls/c', '', 'rel', 'manual');
      await engine.addLink('ls/c', 'ls/a', '', 'rel', 'markdown');
      const scoped = await engine.listLinkSources({ sourceId: 'default' });
      const federated = await engine.listLinkSources({ sourceIds: ['default'] });
      const other = await engine.listLinkSources({ sourceId: 'no-such-source' });
      expect(scoped.map((r) => r.link_source)).toEqual(['citation-graph', 'manual', 'markdown']);
      expect(other).toEqual([]);
      return { scoped, federated, other };
    },
  );

  parityTest(
    'findByTitleFuzzy returns the best title match above the threshold, honoring prefix and source',
    { methods: ['findByTitleFuzzy', 'putPage'] },
    async (engine) => {
      await engine.putPage('people/alice-example', page('Alice Example', { type: 'person' }));
      await engine.putPage('people/alicia-example', page('Alicia Exampel', { type: 'person' }));
      await engine.putPage('companies/acme-example', page('Acme Example', { type: 'company' }));
      const exact = await engine.findByTitleFuzzy('Alice Example');
      const typo = await engine.findByTitleFuzzy('Alice Exmple', 'people');
      const wrongPrefix = await engine.findByTitleFuzzy('Alice Example', 'companies', 0.9);
      const none = await engine.findByTitleFuzzy('Totally Unrelated Zebra');
      const scoped = await engine.findByTitleFuzzy('Acme Example', 'companies', 0.55, 'default');
      const otherSource = await engine.findByTitleFuzzy('Acme Example', undefined, 0.55, 'no-such-source');
      expect(exact?.slug).toBe('people/alice-example');
      expect(exact?.similarity).toBeGreaterThan(0.9);
      expect(none).toBeNull();
      expect(otherSource).toBeNull();
      return {
        exact: exact && { slug: exact.slug, similarity: Math.round(exact.similarity * 1000) / 1000 },
        typo: typo?.slug,
        wrongPrefix: wrongPrefix?.slug ?? null,
        none,
        scoped: scoped?.slug,
        otherSource,
      };
    },
  );

  parityTest(
    'replaceDerivedLinks swaps one origin\'s derived edges and leaves manual edges alone',
    { methods: ['replaceDerivedLinks', 'readPageSnapshot', 'addLink', 'getLinks', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['d/origin', 'd/one', 'd/two', 'd/three']);
      await engine.addLink('d/origin', 'd/three', 'manual keep', 'cites', 'manual');
      const origin = async () => {
        const snap = await engine.readPageSnapshot('d/origin', { sourceId: 'default' });
        expect(snap).not.toBeNull();
        return { slug: 'd/origin', sourceId: 'default', expectedRevision: snap!.revision, sourceIncarnation: snap!.sourceIncarnation };
      };
      const first = await engine.replaceDerivedLinks(await origin(), [
        { from_slug: 'd/origin', to_slug: 'd/one', link_type: 'cites', context: 'one', link_source: 'markdown' },
        { from_slug: 'd/origin', to_slug: 'd/two', link_type: 'cites', context: 'two', link_source: 'markdown' },
        { from_slug: 'd/origin', to_slug: 'd/two', link_type: 'cites', context: 'dup', link_source: 'markdown' },
      ]);
      const afterFirst = sortedLinks(await engine.getLinks('d/origin')).map(linkKey);
      const second = await engine.replaceDerivedLinks(await origin(), [
        { from_slug: 'd/origin', to_slug: 'd/one', link_type: 'cites', context: 'one', link_source: 'markdown' },
      ]);
      const afterSecond = sortedLinks(await engine.getLinks('d/origin')).map(linkKey);
      const cleared = await engine.replaceDerivedLinks(await origin(), []);
      const afterClear = sortedLinks(await engine.getLinks('d/origin')).map(linkKey);
      expect(first).toEqual({ created: 2, removed: 0 });
      expect(afterClear).toEqual(['d/origin>d/three:cites:manual']);
      return { first, afterFirst, second, afterSecond, cleared, afterClear };
    },
  );

  parityTest(
    'replaceDerivedLinksBatch replaces many origins in one call',
    { methods: ['replaceDerivedLinksBatch', 'readPageSnapshot', 'getLinks', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['e/a', 'e/b', 'e/t1', 'e/t2']);
      const origin = async (slug: string) => {
        const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
        return { slug, sourceId: 'default', expectedRevision: snap!.revision, sourceIncarnation: snap!.sourceIncarnation };
      };
      const items = [
        { origin: await origin('e/a'), links: [{ from_slug: 'e/a', to_slug: 'e/t1', link_type: 'cites', link_source: 'markdown' }] },
        { origin: await origin('e/b'), links: [
          { from_slug: 'e/b', to_slug: 'e/t1', link_type: 'cites', link_source: 'markdown' },
          { from_slug: 'e/b', to_slug: 'e/t2', link_type: 'cites', link_source: 'markdown' },
        ] },
      ];
      const results = await engine.replaceDerivedLinksBatch(items);
      const empty = await engine.replaceDerivedLinksBatch([]);
      expect(results).toEqual([{ created: 1, removed: 0 }, { created: 2, removed: 0 }]);
      const rerun = await engine.replaceDerivedLinksBatch([{ origin: await origin('e/b'), links: [] }]);
      return {
        results, empty, rerun,
        a: sortedLinks(await engine.getLinks('e/a')).map(linkKey),
        b: sortedLinks(await engine.getLinks('e/b')).map(linkKey),
      };
    },
  );

  parityTest(
    'getLinks/getBacklinks hide soft-deleted endpoints and respect source scope',
    { methods: ['getLinks', 'getBacklinks', 'addLink', 'softDeletePage', 'restorePage', 'putPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'alt');
      await seedPages(engine, ['s/from', 's/to']);
      await seedPages(engine, ['s/alt-doc'], 'note', { sourceId: 'alt' });
      await engine.addLink('s/from', 's/to', 'ctx', 'wikilink');
      await engine.addLink('s/from', 's/alt-doc', 'cross', 'cites', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'alt' });
      const unscoped = sortedLinks(await engine.getLinks('s/from')).map(linkKey);
      const scalar = sortedLinks(await engine.getLinks('s/from', { sourceId: 'default' })).map(linkKey);
      // A federated grant constrains BOTH endpoints: the alt target must not leak.
      const grant = sortedLinks(await engine.getLinks('s/from', { sourceIds: ['default'] })).map(linkKey);
      const altBack = linkViews(await engine.getBacklinks('s/alt-doc', { sourceId: 'alt' }));
      const grantBack = await engine.getBacklinks('s/alt-doc', { sourceIds: ['alt'] });
      expect(grant).toEqual(['s/from>s/to:wikilink:markdown']);
      expect(grantBack).toEqual([]);
      await engine.softDeletePage('s/from');
      const hiddenOut = await engine.getLinks('s/from');
      const hiddenBack = await engine.getBacklinks('s/to');
      expect(hiddenOut).toEqual([]);
      expect(hiddenBack).toEqual([]);
      await engine.restorePage('s/from');
      const restoredBack = (await engine.getBacklinks('s/to')).map(linkKey);
      return { unscoped, scalar, grant, altBack, grantBack, hiddenOut, hiddenBack, restoredBack };
    },
  );
});

describe('engine parity: graph traversal', () => {
  const nodeShape = (nodes: Awaited<ReturnType<BrainEngine['traverseGraph']>>) =>
    sorted(nodes.map((n) => `${n.source_id}:${n.slug}@${n.depth}[${n.links.map((l) => `${l.to_slug}:${l.link_type}`).sort().join(',')}]`));
  // Not sorted: ORDER BY depth, from_slug, to_slug is part of the traversePaths contract.
  const edgeShape = (paths: Awaited<ReturnType<BrainEngine['traversePaths']>>) =>
    paths.map((p) => `${p.from_slug}>${p.to_slug}:${p.link_type}@${p.depth}`);

  parityTest(
    'traverseGraph returns identical nodes for depth 1..3 and survives a cycle',
    { methods: ['traverseGraph'] },
    async (engine) => {
      await seedChain(engine);
      const byDepth: Record<number, string[]> = {};
      for (const depth of [1, 2, 3]) byDepth[depth] = nodeShape(await engine.traverseGraph('tg/a', depth));
      const deep = nodeShape(await engine.traverseGraph('tg/a', 10));
      const missing = await engine.traverseGraph('tg/nope', 3);
      expect(deep.map((n) => n.split('@')[0])).toEqual(['default:tg/a', 'default:tg/b', 'default:tg/c', 'default:tg/d']);
      expect(missing).toEqual([]);
      return { byDepth, deep, missing };
    },
  );

  parityTest(
    'traversePaths orders links of one edge pair by link type in byte order, then link id, past the small-sort size',
    { methods: ['traversePaths', 'traversePathsDetailed', 'addLink', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['tt/a', 'tt/b', ...Array.from({ length: 12 }, (_, k) => `tt/n${String(k).padStart(2, '0')}`)]);
      for (let k = 0; k < 12; k++) await engine.addLink('tt/a', `tt/n${String(k).padStart(2, '0')}`, 'n', 'mentions', 'manual');
      for (const t of ['b', 'c', 'a', 'D', 'd']) await engine.addLink('tt/a', 'tt/b', `ctx ${t}`, t, 'manual');
      await engine.addLink('tt/b', 'tt/a', 'back', 'mentions', 'manual');
      const pair = (paths: Awaited<ReturnType<BrainEngine['traversePaths']>>) =>
        edgeShape(paths).filter((e) => e.startsWith('tt/a>tt/b:') || e.startsWith('tt/b>tt/a:'));
      const out = pair(await engine.traversePaths('tt/a', { depth: 2, direction: 'out' }));
      const both = pair(await engine.traversePaths('tt/a', { depth: 2, direction: 'both' }));
      const into = pair(await engine.traversePaths('tt/b', { depth: 2, direction: 'in' }));
      const detailed = pair((await engine.traversePathsDetailed('tt/a', { depth: 2, direction: 'both' })).paths);
      expect(out).toEqual(['tt/a>tt/b:D@1', 'tt/a>tt/b:a@1', 'tt/a>tt/b:b@1', 'tt/a>tt/b:c@1', 'tt/a>tt/b:d@1', 'tt/b>tt/a:mentions@2']);
      expect(both).toEqual(['tt/a>tt/b:D@1', 'tt/a>tt/b:a@1', 'tt/a>tt/b:b@1', 'tt/a>tt/b:c@1', 'tt/a>tt/b:d@1', 'tt/b>tt/a:mentions@1']);
      expect(detailed).toEqual(both);
      return { out, both, into, detailed };
    },
  );

  parityTest(
    'traverseGraph source scope keeps cross-source nodes out of a scoped walk',
    { methods: ['traverseGraph', 'addLink', 'putPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'tg-alt');
      await seedChain(engine);
      await seedPages(engine, ['tg/x'], 'note', { sourceId: 'tg-alt' });
      await engine.addLink('tg/b', 'tg/x', 'x-ctx', 'xsrc', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'tg-alt' });
      const unscoped = nodeShape(await engine.traverseGraph('tg/a', 3));
      const scalar = nodeShape(await engine.traverseGraph('tg/a', 3, { sourceId: 'default' }));
      const federated = nodeShape(await engine.traverseGraph('tg/a', 3, { sourceIds: ['default'] }));
      const both = nodeShape(await engine.traverseGraph('tg/a', 3, { sourceIds: ['default', 'tg-alt'] }));
      expect(unscoped.some((n) => n.includes('tg-alt:tg/x'))).toBe(true);
      expect(scalar.some((n) => n.includes('tg/x'))).toBe(false);
      expect(federated).toEqual(scalar);
      return { unscoped, scalar, federated, both };
    },
  );

  parityTest(
    'traversePaths returns ordered edges across depth and direction, with link type filter',
    { methods: ['traversePaths'] },
    async (engine) => {
      await seedChain(engine);
      const out: Record<string, string[]> = {};
      for (const depth of [1, 2, 3]) {
        for (const direction of ['in', 'out', 'both'] as const) {
          out[`${direction}@${depth}`] = edgeShape(await engine.traversePaths('tg/b', { depth, direction }));
        }
      }
      const typed = edgeShape(await engine.traversePaths('tg/a', { depth: 5, direction: 'out', linkType: 'cycle-fwd' }));
      const typedMiss = await engine.traversePaths('tg/a', { depth: 5, direction: 'out', linkType: 'no-such-type' });
      const context = (await engine.traversePaths('tg/c', { depth: 1, direction: 'out' })).map((p) => pick(p, ['from_slug', 'to_slug', 'link_type', 'context', 'depth', 'from_source_id', 'to_source_id']));
      expect(out['out@1']).toEqual(['tg/b>tg/a:cycle-back@1', 'tg/b>tg/c:step@1']);
      expect(typed).toEqual(['tg/a>tg/b:cycle-fwd@1']);
      expect(typedMiss).toEqual([]);
      return { out, typed, typedMiss, context };
    },
  );

  parityTest(
    'traversePaths breaks a depth/from/to tie by link_type in byte order',
    { methods: ['traversePaths', 'addLink', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['tie/a', 'tie/b']);
      // Inserted out of byte order, with case and ASCII punctuation that a
      // locale collation would fold or skip.
      for (const type of ['mentions', 'Mentions', 'men_tions', 'founded', 'men-tions', 'MENTIONS.x']) {
        await engine.addLink('tie/a', 'tie/b', `${type}-ctx`, type, 'manual');
      }
      const byteOrder = ['MENTIONS.x', 'Mentions', 'founded', 'men-tions', 'men_tions', 'mentions'];
      const shapes: Record<string, string[]> = {};
      for (const [seed, direction] of [['tie/a', 'out'], ['tie/b', 'in'], ['tie/a', 'both']] as const) {
        const paths = await engine.traversePaths(seed, { depth: 1, direction });
        // Every row differs before the link id key, so the link id never decides.
        const keys = paths.map((p) => [p.depth, p.from_slug, p.to_slug, p.from_source_id, p.to_source_id, p.link_type].join('|'));
        expect(new Set(keys).size).toBe(keys.length);
        expect(paths.map((p) => p.link_type)).toEqual(byteOrder);
        shapes[`${direction}`] = edgeShape(paths);
      }
      return shapes;
    },
  );

  parityTest(
    'traversePaths source scope: scalar and federated grants stop at the source boundary',
    { methods: ['traversePaths', 'addLink', 'putPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'tg-alt');
      await seedChain(engine);
      await seedPages(engine, ['tg/x'], 'note', { sourceId: 'tg-alt' });
      await engine.addLink('tg/b', 'tg/x', 'x-ctx', 'xsrc', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'tg-alt' });
      const unscoped = edgeShape(await engine.traversePaths('tg/a', { depth: 3, direction: 'out' }));
      const scalar = edgeShape(await engine.traversePaths('tg/a', { depth: 3, direction: 'out', sourceId: 'default' }));
      const federated = edgeShape(await engine.traversePaths('tg/a', { depth: 3, direction: 'out', sourceIds: ['default'] }));
      expect(unscoped.some((e) => e.includes('tg/x'))).toBe(true);
      expect(scalar.some((e) => e.includes('tg/x'))).toBe(false);
      return { unscoped, scalar, federated };
    },
  );

  parityTest(
    'traversePathsDetailed reports the paths and an untruncated walk',
    { methods: ['traversePathsDetailed'] },
    async (engine) => {
      await seedChain(engine);
      const shallow = await engine.traversePathsDetailed('tg/a', { depth: 1, direction: 'both' });
      const deep = await engine.traversePathsDetailed('tg/a', { depth: 4, direction: 'out' });
      const scoped = await engine.traversePathsDetailed('tg/a', { depth: 4, direction: 'out', sourceIds: ['default'], linkType: 'step' });
      expect(shallow.truncated).toBe(false);
      expect(deep.truncated).toBe(false);
      return { shallow: edgeShape(shallow.paths), deep: edgeShape(deep.paths), scoped: edgeShape(scoped.paths), truncated: [shallow.truncated, deep.truncated, scoped.truncated] };
    },
  );

  parityTest(
    'traversal hides soft-deleted pages and recovers them after restore',
    { methods: ['traverseGraph', 'traversePaths', 'softDeletePage', 'restorePage'] },
    async (engine) => {
      await seedChain(engine);
      await engine.softDeletePage('tg/b');
      const graph = nodeShape(await engine.traverseGraph('tg/a', 3));
      const paths = edgeShape(await engine.traversePaths('tg/a', { depth: 3, direction: 'both' }));
      const fromDeleted = await engine.traversePaths('tg/b', { depth: 3, direction: 'out' });
      expect(paths).toEqual([]);
      expect(fromDeleted).toEqual([]);
      await engine.restorePage('tg/b');
      const restored = edgeShape(await engine.traversePaths('tg/a', { depth: 3, direction: 'out' }));
      expect(restored.length).toBeGreaterThan(0);
      return { graph, paths, fromDeleted, restored };
    },
  );
});

describe('engine parity: relational fan-out', () => {
  async function seedRelational(engine: BrainEngine) {
    const ids = new Map<string, number>();
    const pages: Array<[string, PageType]> = [
      ['companies/ep-widget', 'company'], ['companies/ep-other', 'company'],
      ['people/ep-inv-a', 'person'], ['people/ep-inv-b', 'person'], ['people/ep-emp-c', 'person'], ['people/ep-mentioner', 'person'],
    ];
    for (const [slug, type] of pages) ids.set(slug, (await engine.putPage(slug, page(slug, { type }))).id);
    await engine.addLink('people/ep-inv-a', 'companies/ep-widget', '', 'invested_in', 'manual');
    await engine.addLink('people/ep-inv-b', 'companies/ep-widget', '', 'invested_in', 'manual');
    await engine.addLink('people/ep-emp-c', 'companies/ep-widget', '', 'works_at', 'manual');
    await engine.addLink('people/ep-mentioner', 'companies/ep-widget', '', 'mentions', 'mentions');
    await engine.addLink('people/ep-inv-a', 'companies/ep-other', '', 'invested_in', 'manual');
    return ids;
  }
  // canonical_chunk_id is a serial id: compare its presence only.
  const shape = (rows: Awaited<ReturnType<BrainEngine['relationalFanout']>>) =>
    rows.map((r) => `${r.source_id}:${r.slug}:${r.hop}:${r.edge_count}:${r.via_link_types.join(',')}:${r.path.join('>')}:${r.canonical_chunk_id != null ? 'chunk' : 'nochunk'}`);

  parityTest(
    'relationalFanout walks typed edges, excludes mentions by default and orders deterministically',
    { methods: ['relationalFanout', 'upsertChunks'] },
    async (engine) => {
      await seedRelational(engine);
      await engine.upsertChunks('people/ep-inv-b', [{ chunk_index: 0, chunk_text: 'inv b chunk', chunk_source: 'compiled_truth', token_count: 3 }]);
      const typed = shape(await engine.relationalFanout(['companies/ep-widget'], { direction: 'in', linkTypes: ['invested_in'] }));
      const agnostic = shape(await engine.relationalFanout(['companies/ep-widget'], { direction: 'in' }));
      const withMentions = shape(await engine.relationalFanout(['companies/ep-widget'], { direction: 'in', includeMentions: true }));
      const connects = shape(await engine.relationalFanout(['companies/ep-widget', 'companies/ep-other'], { direction: 'both' }));
      const limited = shape(await engine.relationalFanout(['companies/ep-widget'], { direction: 'in', limit: 1 }));
      const scoped = shape(await engine.relationalFanout(['companies/ep-widget'], { direction: 'in', sourceIds: ['no-such-source'] }));
      expect(typed.map((r) => r.split(':')[1])).toEqual(['people/ep-inv-a', 'people/ep-inv-b']);
      expect(agnostic.some((r) => r.includes('ep-mentioner'))).toBe(false);
      expect(withMentions.some((r) => r.includes('ep-mentioner'))).toBe(true);
      expect(limited.length).toBe(1);
      expect(scoped).toEqual([]);
      return { typed, agnostic, withMentions, connects, limited, scoped };
    },
  );

  parityTest(
    'relationalChainHop orients and collapses edges from frontier page ids',
    { methods: ['relationalChainHop', 'addLink'] },
    async (engine) => {
      const ids = await seedRelational(engine);
      await engine.addLink('companies/ep-widget', 'people/ep-emp-c', 'founded by c', 'founded', 'markdown');
      const slugOf = new Map([...ids].map(([slug, id]) => [id, slug]));
      const edgeView = (edges: Awaited<ReturnType<BrainEngine['relationalChainHop']>>) => edges.map((e) => ({
        from: slugOf.get(e.from_page_id),
        to: e.to_slug,
        to_type: e.to_type,
        link_type: e.link_type,
        orientation: e.orientation,
        link_count: e.link_ids.length,
        stored_from: e.stored_from_slug,
        stored_to: e.stored_to_slug,
        context: e.context,
        from_degree: e.from_degree,
        neighbor_cap_hit: e.neighbor_cap_hit,
      }));
      const toObject = edgeView(await engine.relationalChainHop([ids.get('people/ep-inv-a')!], {
        linkTypes: linkFamily('invested_in'), toward: 'object', subjectTypes: ['company', 'person'],
        objectTypes: ['company', 'deal'], degreeLinkTypes: ['invested_in', 'founded'], neighborCap: 100,
      }));
      const toSubject = edgeView(await engine.relationalChainHop([ids.get('companies/ep-widget')!], {
        linkTypes: ['founded'], toward: 'subject', subjectTypes: ['person'], objectTypes: ['company'],
        degreeLinkTypes: ['founded'], neighborCap: 100,
      }));
      const capped = edgeView(await engine.relationalChainHop([ids.get('companies/ep-widget')!], {
        linkTypes: linkFamily('invested_in'), toward: 'subject', subjectTypes: ['person', 'company'],
        objectTypes: ['company', 'deal'], degreeLinkTypes: ['invested_in'], neighborCap: 1,
      }));
      const empty = await engine.relationalChainHop([], {
        linkTypes: ['founded'], toward: 'object', subjectTypes: ['person'], objectTypes: ['company'], degreeLinkTypes: ['founded'], neighborCap: 5,
      });
      expect(toObject.map((e) => e.to).sort()).toEqual(['companies/ep-other', 'companies/ep-widget']);
      expect(toSubject.map((e) => e.to)).toEqual(['people/ep-emp-c']);
      expect(empty).toEqual([]);
      return { toObject: sorted(toObject, (e) => e.to), toSubject, capped, empty };
    },
  );

  // Review finding specialist-batched#1 / targeted#1 and #5: with requireSafeChunks the SQL engines return an edge's
  // context only when its evidence page is sealed at the safe fence and holds no facts/takes fence (textGate), and a
  // canonical chunk only for a sealed page.
  parityTest(
    'requireSafeChunks withholds edge context and canonical chunks of unsealed or fenced pages',
    { methods: ['relationalChainHop', 'relationalFanout', 'sealChunks', 'upsertChunks', 'addLink'] },
    async (engine) => {
      const company = (await engine.putPage('companies/sf-co', page('companies/sf-co', { type: 'company' }))).id;
      const people: Array<[string, string]> = [
        ['people/sf-sealed', 'sealed plain body'],
        ['people/sf-unsealed', 'unsealed plain body'],
        ['people/sf-fenced', 'fenced body\n\n<!--- gbrain:facts:begin -->\n| 1 | owns the vault | fact |\n<!--- gbrain:facts:end -->'],
        ['people/sf-takes', 'takes body\n\n<!--- gbrain:takes:begin -->\n| 1 | thinks so | take |\n<!--- gbrain:takes:end -->'],
      ];
      for (const [slug, body] of people) {
        await engine.putPage(slug, page(slug, { type: 'person', compiled_truth: body }));
        const chunks = [{ chunk_index: 0, chunk_text: `${slug} chunk`, chunk_source: 'compiled_truth' as const }];
        if (slug === 'people/sf-unsealed') await engine.upsertChunks(slug, chunks);
        else await engine.sealChunks(slug, chunks);
        await engine.addLink(slug, 'companies/sf-co', `ctx ${slug}`, 'invested_in', 'manual');
      }
      const chain = async (opts: Partial<import('../../src/core/types.ts').ChainHopOpts>) =>
        sorted((await engine.relationalChainHop([company], {
          linkTypes: ['invested_in'], toward: 'subject', subjectTypes: ['person'], objectTypes: ['company'],
          degreeLinkTypes: ['invested_in'], neighborCap: 100, ...opts,
        })).map((e) => ({ to: e.to_slug, context: e.context, chunk: e.canonical_chunk_id != null })), (e) => e.to);
      const fanout = async (opts: RelationalFanoutOpts) =>
        (await engine.relationalFanout(['companies/sf-co'], { direction: 'in', ...opts }))
          .map((r) => `${r.slug}:${r.canonical_chunk_id != null ? 'chunk' : 'nochunk'}`).sort();
      const open = await chain({});
      const safe = await chain({ requireSafeChunks: true });
      const safeHolders = await chain({ requireSafeChunks: true, takesHoldersAllowList: ['people/sf-sealed'] });
      // GST-3058: the owner's own direct call reads the stored context; a holders list still skips takes-bearing evidence.
      const owner = <T>(fn: () => Promise<T>) => withCallerAccess({ owner: true, ownerReads: true }, fn);
      const ownerSafe = await owner(() => chain({ requireSafeChunks: true }));
      const ownerHolders = await owner(() => chain({ requireSafeChunks: true, takesHoldersAllowList: ['people/sf-sealed'] }));
      const fanOpen = await fanout({});
      const fanSafe = await fanout({ requireSafeChunks: true });
      expect(open.every((e) => e.context !== null && e.chunk)).toBe(true);
      expect(ownerSafe.map((e) => e.context === null)).toEqual([false, false, false, false]);
      expect(ownerHolders.map((e) => [e.to, e.context === null])).toEqual([
        ['people/sf-fenced', false], ['people/sf-sealed', false], ['people/sf-takes', true], ['people/sf-unsealed', true],
      ]);
      expect(safe).toEqual([
        { to: 'people/sf-fenced', context: null, chunk: true },
        { to: 'people/sf-sealed', context: 'ctx people/sf-sealed', chunk: true },
        { to: 'people/sf-takes', context: null, chunk: true },
        { to: 'people/sf-unsealed', context: null, chunk: false },
      ]);
      expect(safeHolders).toEqual(safe);
      expect(fanSafe).toContain('people/sf-unsealed:nochunk');
      return { open, safe, safeHolders, ownerSafe, ownerHolders, fanOpen, fanSafe };
    },
  );
});

describe('engine parity: backlink and page signal reads', () => {
  parityTest(
    'getBacklinkCounts counts distinct linkers per page id, excluding mentions',
    { methods: ['getBacklinkCounts', 'addLink'] },
    async (engine) => {
      const ids = await seedPages(engine, ['bc/hub', 'bc/leaf', 'bc/one', 'bc/two', 'bc/three']);
      await engine.addLink('bc/one', 'bc/hub', '', 'cites', 'manual');
      await engine.addLink('bc/two', 'bc/hub', '', 'cites', 'manual');
      await engine.addLink('bc/two', 'bc/hub', '', 'related', 'manual');
      await engine.addLink('bc/three', 'bc/hub', '', 'mentions', 'mentions');
      await engine.addLink('bc/hub', 'bc/leaf', '', 'cites', 'manual');
      const counts = await engine.getBacklinkCounts([...ids.values()]);
      const scoped = await engine.getBacklinkCounts([ids.get('bc/hub')!, ids.get('bc/leaf')!], { sourceIds: ['default'] });
      const none = await engine.getBacklinkCounts([]);
      expect(counts.get(ids.get('bc/hub')!)).toBe(2);
      expect(none.size).toBe(0);
      return { counts: bySlug(ids, counts), scoped: bySlug(ids, scoped), none: none.size };
    },
  );

  parityTest(
    'getAdjacencyBoosts aggregates in-set linkers only',
    { methods: ['getAdjacencyBoosts', 'addLink'] },
    async (engine) => {
      const ids = await seedPages(engine, ['adj/a', 'adj/b', 'adj/c', 'adj/outside']);
      await engine.addLink('adj/a', 'adj/c', '', 'cites', 'manual');
      await engine.addLink('adj/b', 'adj/c', '', 'cites', 'manual');
      await engine.addLink('adj/outside', 'adj/c', '', 'cites', 'manual');
      await engine.addLink('adj/a', 'adj/b', '', 'mentions', 'mentions');
      const inSet = [ids.get('adj/a')!, ids.get('adj/b')!, ids.get('adj/c')!];
      const boosts = await engine.getAdjacencyBoosts(inSet);
      const scoped = await engine.getAdjacencyBoosts(inSet, { sourceIds: ['default'] });
      const empty = await engine.getAdjacencyBoosts([]);
      expect(boosts.get(ids.get('adj/c')!)?.hits).toBe(2);
      expect(empty.size).toBe(0);
      return { boosts: bySlug(ids, boosts), scoped: bySlug(ids, scoped), empty: empty.size };
    },
  );

  parityTest(
    'getContentFlagsByPageIds and getUnverifiedExtractionPageIds read frontmatter markers',
    { methods: ['getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds', 'putPage'] },
    async (engine) => {
      const ids = new Map<string, number>();
      const put = async (slug: string, frontmatter: Record<string, unknown>) => {
        ids.set(slug, (await engine.putPage(slug, page(slug, { frontmatter }))).id);
      };
      await put('fm/flagged', { content_flag: { reason: 'markup_heavy', detail: '80% tags' } });
      await put('fm/stub', { provenance: 'auto-extracted', status: 'unverified' });
      await put('fm/verified', { provenance: 'auto-extracted', status: 'verified' });
      await put('fm/draft', { status: 'draft' });
      await put('fm/plain', {});
      const all = [...ids.values()];
      const flags = await engine.getContentFlagsByPageIds(all);
      const unverified = await engine.getUnverifiedExtractionPageIds(all);
      const emptyFlags = await engine.getContentFlagsByPageIds([]);
      const emptyUnverified = await engine.getUnverifiedExtractionPageIds([]);
      expect(flags.size).toBe(1);
      expect(emptyFlags.size).toBe(0);
      expect(emptyUnverified.size).toBe(0);
      return { flags: bySlug(ids, flags), unverified: bySlug(ids, unverified) };
    },
  );

  parityTest(
    'getContentFlagsByPageIds and getUnverifiedExtractionPageIds take the whole hybrid search options and read only the page policy',
    { methods: ['getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds', 'putPage'] },
    async (engine) => {
      const ids = new Map<string, number>();
      const marks = { content_flag: { reason: 'markup_heavy', detail: 'tags' }, provenance: 'auto-extracted', status: 'unverified' };
      for (const [slug, frontmatter] of [['hs/open', {}], ['hs/private', { visibility: 'private' }], ['hs/other', { type: 'person' }]] as const) {
        ids.set(slug, (await engine.putPage(slug, page(slug, { frontmatter: { ...frontmatter, ...marks } }))).id);
      }
      const all = [...ids.values()];
      // What stampContentFlags and stampUnverifiedExtractions pass (search/hybrid.ts): the caller's whole
      // HybridSearchOpts. The search filters already ran in the arms; the stamp reads apply only the page policy.
      const hybrid = {
        limit: 5, offset: 0, type: 'note', types: ['note'], exclude_slugs: ['hs/other'], exclude_slug_prefixes: ['hs/x'],
        include_slug_prefixes: ['hs/'], detail: 'medium', where: { status: ['active'] }, afterDate: '2020-01-01',
        expansion: true, mode: 'balanced', explain: true, onMeta: () => undefined, dedupOpts: { maxPerPage: 2 },
        takesHoldersAllowList: ['alice-example'], requireSafeChunks: true, excludePrivate: true,
      } as never;
      const out = {
        flags: bySlug(ids, await engine.getContentFlagsByPageIds(all, hybrid)).map(([slug]) => slug),
        unverified: bySlug(ids, await engine.getUnverifiedExtractionPageIds(all, hybrid)).map(([slug]) => slug),
      };
      const policy = {
        flags: bySlug(ids, await engine.getContentFlagsByPageIds(all, { excludePrivate: true })).map(([slug]) => slug),
        unverified: bySlug(ids, await engine.getUnverifiedExtractionPageIds(all, { excludePrivate: true })).map(([slug]) => slug),
      };
      expect(out).toEqual(policy);
      expect(out.flags).toEqual(['hs/open', 'hs/other']);
      return out;
    },
  );

  parityTest(
    'getContentFlagsByPageIds, getUnverifiedExtractionPageIds and getEffectiveDates under excludePrivate apply a caller\'s reader identity and private-readable grant',
    { methods: ['getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds', 'getEffectiveDates', 'putPage'] },
    async (engine) => {
      const ids = new Map<string, number>();
      const marks = { content_flag: { reason: 'markup_heavy', detail: 'tags' }, provenance: 'auto-extracted', status: 'unverified' };
      for (const [slug, frontmatter] of [
        ['pv/open', {}], ['pv/private', { visibility: 'private' }], ['pv/readers', { readable_by: ['alice-example'] }],
        ['pv/team', { readable_by: 'group:team-a' }], ['pv/bob-only', { readable_by: ['bob-example'] }],
        ['pv/pinned', { visibility: 'private', pinned_question: true }],
      ] as const) {
        ids.set(slug, (await engine.putPage(slug, page(slug, {
          frontmatter: { ...frontmatter, ...marks }, effective_date: new Date('2024-03-05T00:00:00Z'), effective_date_source: 'date',
        }))).id);
      }
      const all = [...ids.values()];
      const refs = [...ids.keys()].map((slug) => ({ slug, source_id: 'default' }));
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () => ({
        flags: bySlug(ids, await engine.getContentFlagsByPageIds(all, { excludePrivate: true })).map(([slug]) => slug),
        unverified: bySlug(ids, await engine.getUnverifiedExtractionPageIds(all, { excludePrivate: true })).map(([slug]) => slug),
        dates: sorted([...(await engine.getEffectiveDates(refs, { excludePrivate: true })).keys()]),
      }));
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const stranger = await read({ identity: ['member:carol-example'], hidePrivate: true });
      expect(stranger.flags).toEqual(['pv/open']);
      expect(sorted(member.flags)).toEqual(['pv/open', 'pv/readers', 'pv/team']);
      expect(sorted(granted.unverified)).toEqual(['pv/open', 'pv/private', 'pv/readers']);
      expect(member.dates).toEqual(['default::pv/open', 'default::pv/readers', 'default::pv/team']);
      return { member, granted, stranger };
    },
  );

  // Hybrid search hands its whole option object (limit, offset, detail, type...) to the two stamp reads as the read
  // policy; the read filter reads only the policy keys, and any object turns on the live filter.
  parityTest(
    'getContentFlagsByPageIds and getUnverifiedExtractionPageIds read only the policy keys of a search option object',
    { methods: ['getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds', 'putPage', 'softDeletePage'] },
    async (engine) => {
      const ids = new Map<string, number>();
      const marks = { content_flag: { reason: 'markup_heavy', detail: 'tags' }, provenance: 'auto-extracted', status: 'unverified' };
      for (const [slug, frontmatter] of [['so/open', {}], ['so/private', { visibility: 'private' }], ['so/gone', {}]] as const) {
        ids.set(slug, (await engine.putPage(slug, page(slug, { frontmatter: { ...frontmatter, ...marks } }))).id);
      }
      await engine.softDeletePage('so/gone');
      const all = [...ids.values()];
      const search = { limit: 10, offset: 0, detail: 'low' as const, type: 'concept' as PageType, exclude_slugs: ['x/y'], walkDepth: 0 };
      const read = async (opts?: Record<string, unknown>) => ({
        flags: bySlug(ids, await engine.getContentFlagsByPageIds(all, opts)).map(([slug]) => slug),
        unverified: bySlug(ids, await engine.getUnverifiedExtractionPageIds(all, opts)).map(([slug]) => slug),
      });
      const bare = await read();
      const paged = await read(search);
      const hidden = await read({ ...search, excludePrivate: true, sourceId: 'default' });
      const holders = await read({ ...search, takesHoldersAllowList: [] });
      expect(sorted(bare.flags)).toEqual(['so/gone', 'so/open', 'so/private']);
      expect(sorted(paged.flags)).toEqual(['so/open', 'so/private']);
      expect(hidden.unverified).toEqual(['so/open']);
      expect(holders).toEqual(paged);
      return { bare, paged, hidden, holders };
    },
  );

  parityTest(
    'getContentFlagsByPageIds, getUnverifiedExtractionPageIds and getEffectiveDates under excludePrivate hide every page while a source is owner-only, then only the owner-only source and its concepts',
    { methods: ['getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds', 'getEffectiveDates', 'putPage', 'addLink'] },
    async (engine, backend) => {
      const ids = new Map<string, number>();
      const refs: Array<{ slug: string; source_id: string }> = [];
      const marks = { content_flag: { reason: 'markup_heavy', detail: 'tags' }, provenance: 'auto-extracted', status: 'unverified' };
      const put = async (slug: string, type: PageType, sourceId: string) => {
        ids.set(`${sourceId}:${slug}`, (await engine.putPage(slug, page(slug, {
          type, frontmatter: marks, effective_date: new Date('2024-03-05T00:00:00Z'), effective_date_source: 'date',
        }), { sourceId })).id);
        refs.push({ slug, source_id: sourceId });
      };
      await put('oo/open', 'note', 'default');
      await put('oo/lineage', 'concept', 'default');
      await put('oo/plain', 'concept', 'default');
      const read = async () => {
        const all = [...ids.values()];
        const names = (m: Map<number, unknown>) => bySlug(ids, m).map(([key]) => key);
        return {
          flags: names(await engine.getContentFlagsByPageIds(all, { excludePrivate: true })),
          unverified: names(await engine.getUnverifiedExtractionPageIds(all, { excludePrivate: true })),
          dates: sorted([...(await engine.getEffectiveDates(refs, { excludePrivate: true })).keys()]),
        };
      };
      const before = await read();
      await createSource(engine, backend, 'oo-chat', { kind: 'imessage' });
      await put('oo/chat', 'note', 'oo-chat');
      // A concept in `default` synthesized from a page of the owner-only source.
      await engine.addLink('oo/lineage', 'oo/chat', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: 'oo-chat' });
      const member = { identity: ['member:alice-example', 'group:team-a'], hidePrivate: true };
      // No schema version is recorded on the harness brain: the closed form hides every page while any source is owner-only.
      const closed = await read();
      const closedMember = await withCallerAccess(member, read);
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      // Schema version 320 or later: only the owner-only source's pages and the concept built from one are hidden.
      const fn = await withEngineScope(engine, read);
      const fnMember = await withEngineScope(engine, () => withCallerAccess(member, read));
      const none = { flags: [], unverified: [], dates: [] };
      const kept = {
        flags: ['default:oo/open', 'default:oo/plain'], unverified: ['default:oo/open', 'default:oo/plain'],
        dates: ['default::oo/open', 'default::oo/plain'],
      };
      expect(before).toEqual({
        flags: ['default:oo/lineage', 'default:oo/open', 'default:oo/plain'], unverified: ['default:oo/lineage', 'default:oo/open', 'default:oo/plain'],
        dates: ['default::oo/lineage', 'default::oo/open', 'default::oo/plain'],
      });
      expect(closed).toEqual(none);
      expect(closedMember).toEqual(none);
      expect(fn).toEqual(kept);
      expect(fnMember).toEqual(kept);
      return { before, closed, closedMember, fn, fnMember };
    },
  );

  parityTest(
    'getPageTimestamps and getEffectiveDates return dates only for existing live pages',
    { methods: ['getPageTimestamps', 'getEffectiveDates', 'putPage', 'softDeletePage'] },
    async (engine) => {
      await engine.putPage('ts/dated', page('dated', { effective_date: new Date('2024-03-05T00:00:00Z'), effective_date_source: 'date' }));
      await engine.putPage('ts/undated', page('undated'));
      await engine.putPage('ts/gone', page('gone'));
      await engine.softDeletePage('ts/gone');
      const stamps = await engine.getPageTimestamps(['ts/dated', 'ts/undated', 'ts/missing']);
      const refs = ['ts/dated', 'ts/undated', 'ts/missing', 'ts/gone'].map((slug) => ({ slug, source_id: 'default' }));
      const dates = await engine.getEffectiveDates(refs);
      const wrongSource = await engine.getEffectiveDates([{ slug: 'ts/dated', source_id: 'no-such-source' }]);
      const none = await engine.getEffectiveDates([]);
      expect(dates.get('default::ts/dated')?.toISOString()).toBe('2024-03-05T00:00:00.000Z');
      expect(dates.has('default::ts/missing')).toBe(false);
      expect(wrongSource.size).toBe(0);
      expect(none.size).toBe(0);
      return {
        stampSlugs: sorted([...stamps.keys()]),
        stampsAreDates: [...stamps.values()].every((d) => d instanceof Date),
        dateKeys: sorted([...dates.keys()]),
        dated: dates.get('default::ts/dated')?.toISOString(),
        wrongSource: wrongSource.size,
      };
    },
  );

  parityTest(
    'getSalienceScores combines emotional weight and take count',
    { methods: ['getSalienceScores', 'setEmotionalWeightBatch', 'addTakesBatch', 'putPage'] },
    async (engine) => {
      const ids = await seedPages(engine, ['sal/plain', 'sal/weighted', 'sal/taken']);
      await engine.setEmotionalWeightBatch([{ slug: 'sal/weighted', source_id: 'default', weight: 0.4 }]);
      await engine.addTakesBatch([
        { page_id: ids.get('sal/taken')!, row_num: 1, claim: 'a take', kind: 'take', holder: 'garry' },
        { page_id: ids.get('sal/taken')!, row_num: 2, claim: 'another take', kind: 'take', holder: 'garry' },
      ]);
      const refs = ['sal/plain', 'sal/weighted', 'sal/taken', 'sal/missing'].map((slug) => ({ slug, source_id: 'default' }));
      const scores = await engine.getSalienceScores(refs);
      const none = await engine.getSalienceScores([]);
      const round = (n: number | undefined) => (n === undefined ? null : Math.round(n * 1e6) / 1e6);
      expect(none.size).toBe(0);
      return {
        keys: sorted([...scores.keys()]),
        plain: round(scores.get('default::sal/plain')),
        weighted: round(scores.get('default::sal/weighted')),
        taken: round(scores.get('default::sal/taken')),
        missing: round(scores.get('default::sal/missing')),
      };
    },
  );

  // Review finding outside-voice#5: hybrid search hands its whole post-fusion option bag (applyBacklinks, floorRatio,
  // graphSignalsEnabled, query, titleBoost...) to getSalienceScores. A member that refused those keys had its refusal
  // swallowed by the stage, so the salience boost silently never applied on the Rust engine.
  parityTest(
    'the salience boost applies through the post-fusion stage, which passes the hybrid option bag',
    { methods: ['getSalienceScores', 'setEmotionalWeightBatch', 'putPage'] },
    async (engine) => {
      const ids = await seedPages(engine, ['salpf/plain', 'salpf/weighted']);
      await engine.setEmotionalWeightBatch([{ slug: 'salpf/weighted', source_id: 'default', weight: 0.9 }]);
      const round = (n: number) => Math.round(n * 1e6) / 1e6;
      // The stage hands the bag on only when it carries a read policy (hasReadPolicy), as a source-scoped search does.
      const run = async (policy: Pick<PostFusionOpts, 'sourceId' | 'takesHoldersAllowList'>) => {
        const results = ['salpf/plain', 'salpf/weighted'].map((slug) => ({
          slug, page_id: ids.get(slug)!, source_id: 'default', title: slug, type: 'note', chunk_text: slug,
          chunk_source: 'compiled_truth', chunk_id: 0, chunk_index: 0, score: 1, stale: false,
        })) as unknown as SearchResult[];
        await runPostFusionStages(engine, results, {
          ...policy, excludePrivate: undefined, requireSafeChunks: undefined, applyBacklinks: true, salience: 'on',
          recency: 'off', floorRatio: undefined, graphSignalsEnabled: false, query: 'salpf', titleBoost: undefined,
        });
        return Object.fromEntries(results.map((r) => [r.slug, round(r.score)]));
      };
      const unscoped = await run({});
      const scoped = await run({ sourceId: 'default' });
      const holders = await run({ takesHoldersAllowList: ['garry'] });
      expect(scoped['salpf/weighted']).toBeGreaterThan(scoped['salpf/plain']);
      return { unscoped, scoped, holders };
    },
  );

  parityTest(
    'findOrphanPages: islanded default vs inbound mode, with source scope',
    { methods: ['findOrphanPages', 'addLink', 'putPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'orphan-src');
      await seedPages(engine, ['people/op-island', 'people/op-target', 'people/op-linker'], 'person');
      await seedPages(engine, ['people/op-alt-island'], 'person', { sourceId: 'orphan-src' });
      await engine.addLink('people/op-linker', 'people/op-target', '', 'cites', 'manual');
      const view = async (opts?: Parameters<BrainEngine['findOrphanPages']>[0]) =>
        sorted((await engine.findOrphanPages(opts)).map((r) => `${r.source_id ?? 'default'}:${r.slug}`));
      const islanded = await view();
      const inbound = await view({ mode: 'inbound' });
      const scopedDefault = await view({ sourceId: 'default' });
      const scopedAlt = await view({ sourceId: 'orphan-src' });
      const federated = await view({ sourceIds: ['default', 'orphan-src'] });
      expect(islanded).toEqual(['default:people/op-island', 'orphan-src:people/op-alt-island']);
      expect(inbound).toEqual(['default:people/op-island', 'default:people/op-linker', 'orphan-src:people/op-alt-island']);
      return { islanded, inbound, scopedDefault, scopedAlt, federated };
    },
  );
  parityTest(
    'findByTitleFuzzy: exact float4 scores, slug ties, LIKE wildcards in dirPrefix, soft-deleted pages per arm',
    { methods: ['findByTitleFuzzy', 'putPage', 'softDeletePage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'fuzzy-src');
      await engine.putPage('fz/b-tie', page('Widget Example', { type: 'concept' }));
      await engine.putPage('fz/a-tie', page('Widget Example', { type: 'concept' }));
      await engine.putPage('fz_x/odd', page('Gadget Thing', { type: 'concept' }));
      await engine.putPage('fz/gone', page('Vanished Widget Example', { type: 'concept' }));
      await engine.putPage('fz/z-alt', page('Widget Example', { type: 'concept' }), { sourceId: 'fuzzy-src' });
      await engine.softDeletePage('fz/gone');
      const tie = await engine.findByTitleFuzzy('Widget Example');
      const partial = await engine.findByTitleFuzzy('Widget Exampl', 'fz');
      // The prefix is a LIKE pattern: each `_` matches any one character, so `f__x` matches `fz_x/odd`.
      const wildcard = await engine.findByTitleFuzzy('Gadget Thing', 'f__x', 0.5);
      const lowThreshold = await engine.findByTitleFuzzy('Gadget', undefined, 0.1);
      // 1/3 as a float4 is 0.33333334: the SQL compares in float4.
      const boundary = await engine.findByTitleFuzzy('abc', undefined, 0.33333334);
      await engine.putPage('fz/abd', page('abd', { type: 'concept' }));
      const boundaryHit = await engine.findByTitleFuzzy('abc', 'fz', 0.33333334);
      const deletedScoped = await engine.findByTitleFuzzy('Vanished Widget Example', undefined, 0.9, 'default');
      const deletedUnscoped = await engine.findByTitleFuzzy('Vanished Widget Example', undefined, 0.9);
      const otherSource = await engine.findByTitleFuzzy('Widget Example', undefined, 0.55, 'fuzzy-src');
      expect(tie?.slug).toBe('fz/a-tie');
      expect(wildcard?.slug).toBe('fz_x/odd');
      expect(boundaryHit?.slug).toBe('fz/abd');
      expect(deletedScoped).toBeNull();
      return { tie, partial, wildcard, lowThreshold, boundary, boundaryHit, deletedScoped, deletedUnscoped, otherSource };
    },
  );
});

/**
 * `excludePrivate` on the links-family reads: each read applies the page policy (`privatePagesFilterForCaller`) on
 * every page its SQL judges (endpoints, contributors, origins, neighbors, orphan candidates), on every engine arm.
 * A read that ignores the flag returns the hidden pages; one that judges only `visibility` misses readers, aliases,
 * derived atoms and concepts, lineage and Life Chronicle origins.
 */
describe('engine parity: excludePrivate on links reads', () => {
  /** One hidden page per rule of the page policy, plus open pages. */
  const HIDDEN: Array<[string, PageType, Record<string, unknown>]> = [
    ['notes/private', 'note', { visibility: 'private' }],
    ['notes/readers', 'note', { readable_by: ['alice-example'] }],
    ['notes/access-alias', 'note', { access: '\u00a0Restricted\u3000' }],
    ['atoms/no-visibility', 'atom', {}],
    ['atoms/origin-private', 'atom', { visibility: 'world', source_slug: 'notes/private' }],
    ['concepts/private-input', 'concept', { visibility: 'world', synthesized_by: 'dream' }],
    ['notes/lineage-md', 'note', { derived_from: 'notes/private.md' }],
    ['events/chronicle-private', 'event', { captured_via: 'life-chronicle:test', event: { depth: 'notes/private' } }],
  ];
  const OPEN: Array<[string, PageType, Record<string, unknown>]> = [
    ['notes/open', 'note', {}],
    ['notes/access-plain', 'note', { access: 'team' }],
    ['atoms/origin-open', 'atom', { visibility: 'world', source_slug: 'notes/open' }],
    ['events/plain', 'event', { event: { depth: 'meetings/none' } }],
    ['people/hub', 'person', {}],
  ];

  async function fixture(engine: BrainEngine) {
    const ids = new Map<string, number>();
    for (const [slug, type, frontmatter] of [...HIDDEN, ...OPEN]) {
      ids.set(slug, (await engine.putPage(slug, page(slug, { type, frontmatter }))).id);
    }
    await engine.addLink('concepts/private-input', 'atoms/no-visibility', '', 'synthesized_from', 'concept-provenance');
    // Every page but the hub cites the hub; the open note also cites a hidden page.
    for (const [slug] of [...HIDDEN, ...OPEN]) if (slug !== 'people/hub') await engine.addLink(slug, 'people/hub', '', 'cites', 'manual');
    await engine.addLink('notes/open', 'notes/private', '', 'cites', 'manual');
    // An open-to-open edge written on a hidden page: its origin hides it.
    await engine.addLinksBatch([{ from_slug: 'events/plain', to_slug: 'notes/access-plain', link_type: 'cites', link_source: 'frontmatter', origin_slug: 'notes/private', origin_field: 'refs' }]);
    return ids;
  }

  parityTest(
    'getBacklinkCounts and getAdjacencyBoosts under excludePrivate count only links whose pages and origin the policy keeps',
    { methods: ['putPage', 'addLink', 'addLinksBatch', 'getBacklinkCounts', 'getAdjacencyBoosts'] },
    async (engine) => {
      const ids = await fixture(engine);
      const all = [...ids.values()];
      const counts = (m: Map<number, number>) => bySlug(ids, m).filter(([, n]) => n > 0);
      const backOff = counts(await engine.getBacklinkCounts(all, {}));
      const backOn = counts(await engine.getBacklinkCounts(all, { excludePrivate: true }));
      const backScoped = counts(await engine.getBacklinkCounts(all, { sourceId: 'default', excludePrivate: true }));
      const adjOff = bySlug(ids, await engine.getAdjacencyBoosts(all, {}));
      const adjOn = bySlug(ids, await engine.getAdjacencyBoosts(all, { excludePrivate: true }));
      expect(backOff).toContainEqual(['people/hub', HIDDEN.length + OPEN.length - 1]);
      expect(backOn).toEqual([['people/hub', OPEN.length - 1]]);
      expect(adjOn.map(([slug]) => slug)).toEqual(['people/hub']);
      return { backOff, backOn, backScoped, adjOff, adjOn };
    },
  );

  parityTest(
    'relationalFanout and relationalChainHop under excludePrivate never seed, step to, or count a hidden page',
    { methods: ['putPage', 'addLink', 'addLinksBatch', 'relationalFanout', 'relationalChainHop'] },
    async (engine) => {
      const ids = await fixture(engine);
      const shape = (rows: Awaited<ReturnType<BrainEngine['relationalFanout']>>) =>
        rows.map((r) => `${r.source_id}:${r.slug}:${r.hop}:${r.edge_count}:${r.path.join('>')}`);
      const fanOff = shape(await engine.relationalFanout(['people/hub'], { direction: 'in' }));
      const fanOn = shape(await engine.relationalFanout(['people/hub'], { direction: 'in', excludePrivate: true }));
      const fanBoth = shape(await engine.relationalFanout(['notes/open'], { direction: 'both', depth: 2, excludePrivate: true }));
      const hiddenSeed = shape(await engine.relationalFanout(['notes/private'], { direction: 'both', excludePrivate: true }));
      const slugOf = new Map([...ids].map(([slug, id]) => [id, slug]));
      const hop = async (excludePrivate?: boolean) => (await engine.relationalChainHop([ids.get('people/hub')!], {
        linkTypes: ['cites'], toward: 'subject', subjectTypes: ['note', 'atom', 'concept', 'event'], objectTypes: ['person', 'note'],
        degreeLinkTypes: ['cites'], neighborCap: 100, ...(excludePrivate ? { excludePrivate } : {}),
      })).map((e) => `${slugOf.get(e.from_page_id)}>${e.to_slug}:${e.orientation}:${e.link_ids.length}:${e.from_degree}`).sort();
      const hopOff = await hop();
      const hopOn = await hop(true);
      expect(fanOn.some((r) => r.includes('notes/private'))).toBe(false);
      expect(fanOff.some((r) => r.includes('notes/private'))).toBe(true);
      expect(hiddenSeed).toEqual([]);
      expect(hopOn.length).toBe(OPEN.length - 1);
      return { fanOff, fanOn, fanBoth, hiddenSeed, hopOff, hopOn };
    },
  );

  parityTest(
    'supersedingPageSlugs under excludePrivate drops a hidden superseder, a hidden superseded page and a hidden origin',
    { methods: ['putPage', 'addLink', 'addLinksBatch', 'supersedingPageSlugs'] },
    async (engine) => {
      const ids = await fixture(engine);
      for (const slug of ['notes/stale-a', 'notes/stale-b', 'notes/stale-c']) ids.set(slug, (await engine.putPage(slug, page(slug))).id);
      await engine.addLink('notes/private', 'notes/stale-a', '', 'supersedes', 'manual');
      await engine.addLink('notes/open', 'notes/stale-b', '', 'supersedes', 'manual');
      await engine.addLink('notes/open', 'notes/readers', '', 'supersedes', 'manual');
      await engine.addLinksBatch([{ from_slug: 'notes/access-plain', to_slug: 'notes/stale-c', link_type: 'supersedes', link_source: 'frontmatter', origin_slug: 'atoms/no-visibility', origin_field: 'supersedes' }]);
      const slugOf = new Map([...ids].map(([slug, id]) => [id, slug]));
      const view = (m: Map<number, string>) => sorted([...m].map(([id, by]) => `${slugOf.get(id)}<${by}`));
      const all = [...ids.values()];
      const off = view(await engine.supersedingPageSlugs(all, {}));
      const on = view(await engine.supersedingPageSlugs(all, { excludePrivate: true }));
      const scoped = view(await engine.supersedingPageSlugs(all, { sourceIds: ['default'], excludePrivate: true }));
      expect(off).toEqual(['notes/readers<notes/open', 'notes/stale-a<notes/private', 'notes/stale-b<notes/open', 'notes/stale-c<notes/access-plain']);
      expect(on).toEqual(['notes/stale-b<notes/open']);
      return { off, on, scoped };
    },
  );

  parityTest(
    'findOrphanPages under excludePrivate hides hidden candidates and ignores links from hidden pages or with hidden origins',
    { methods: ['putPage', 'addLink', 'addLinksBatch', 'findOrphanPages'] },
    async (engine) => {
      await fixture(engine);
      for (const slug of ['orph/by-private', 'orph/to-private', 'orph/by-origin', 'orph/by-open', 'orph/alone']) await engine.putPage(slug, page(slug));
      await engine.addLink('notes/private', 'orph/by-private', '', 'cites', 'manual');
      await engine.addLink('orph/to-private', 'notes/readers', '', 'cites', 'manual');
      await engine.addLinksBatch([{ from_slug: 'notes/open', to_slug: 'orph/by-origin', link_type: 'cites', link_source: 'frontmatter', origin_slug: 'notes/lineage-md', origin_field: 'refs' }]);
      await engine.addLink('notes/open', 'orph/by-open', '', 'cites', 'manual');
      const view = async (opts?: Parameters<BrainEngine['findOrphanPages']>[0]) =>
        sorted((await engine.findOrphanPages(opts)).map((r) => `${r.source_id ?? 'default'}:${r.slug}`));
      const off = await view({});
      const on = await view({ excludePrivate: true });
      const inbound = await view({ excludePrivate: true, mode: 'inbound' });
      const scopedInbound = await view({ excludePrivate: true, sourceId: 'default', scopeInbound: true });
      expect(off).toEqual(['default:orph/alone']);
      expect(on).toEqual(['default:orph/alone', 'default:orph/by-origin', 'default:orph/by-private', 'default:orph/to-private']);
      expect(inbound).toContain('default:orph/to-private');
      return { off, on, inbound, scopedInbound };
    },
  );

  parityTest(
    'the links reads under excludePrivate apply a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'addLink', 'addLinksBatch', 'getBacklinkCounts', 'getAdjacencyBoosts', 'relationalFanout',
      'relationalChainHop', 'supersedingPageSlugs', 'findOrphanPages'] },
    async (engine) => {
      const ids = await fixture(engine);
      for (const [slug, frontmatter] of [
        ['notes/team', { readable_by: 'group:team-a' }], ['notes/bob-only', { readable_by: ['bob-example'] }],
        ['notes/pinned', { visibility: 'private', pinned_question: true }], ['orph/by-readers', {}], ['orph/by-team', {}], ['notes/stale-g', {}],
      ] as const) ids.set(slug, (await engine.putPage(slug, page(slug, { frontmatter }))).id);
      for (const slug of ['notes/team', 'notes/bob-only', 'notes/pinned']) await engine.addLink(slug, 'people/hub', '', 'cites', 'manual');
      await engine.addLink('notes/readers', 'orph/by-readers', '', 'cites', 'manual');
      await engine.addLink('notes/team', 'orph/by-team', '', 'cites', 'manual');
      await engine.addLink('notes/open', 'notes/readers', '', 'supersedes', 'manual');
      await engine.addLink('notes/private', 'notes/stale-g', '', 'supersedes', 'manual');
      const all = [...ids.values()];
      const slugOf = new Map([...ids].map(([slug, id]) => [id, slug]));
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () => ({
        back: bySlug(ids, await engine.getBacklinkCounts(all, { excludePrivate: true })).filter(([, n]) => n > 0),
        adjacency: bySlug(ids, await engine.getAdjacencyBoosts(all, { excludePrivate: true })).map(([slug]) => slug),
        fanout: sorted((await engine.relationalFanout(['people/hub'], { direction: 'in', excludePrivate: true }))
          .map((r) => `${r.slug}:${r.hop}:${r.edge_count}`)),
        hop: (await engine.relationalChainHop([ids.get('people/hub')!], {
          linkTypes: ['cites'], toward: 'subject', subjectTypes: ['note', 'atom', 'concept', 'event'], objectTypes: ['person', 'note'],
          degreeLinkTypes: ['cites'], neighborCap: 100, excludePrivate: true,
        })).map((e) => `${slugOf.get(e.from_page_id)}>${e.to_slug}:${e.from_degree}`).sort(),
        superseded: sorted([...await engine.supersedingPageSlugs(all, { excludePrivate: true })].map(([id, by]) => `${slugOf.get(id)}<${by}`)),
        orphans: sorted((await engine.findOrphanPages({ excludePrivate: true })).map((r) => r.slug)),
      }));
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const stranger = await read({ identity: ['member:carol-example'], hidePrivate: true });
      const hub = (rows: Array<[string, number]>) => rows.find(([slug]) => slug === 'people/hub')?.[1];
      expect(hub(stranger.back)).toBe(OPEN.length - 1);
      expect(hub(member.back)).toBe(OPEN.length + 1);
      expect(member.back).toContainEqual(['orph/by-readers', 1]);
      expect(stranger.back.map(([slug]) => slug)).not.toContain('orph/by-readers');
      expect(member.fanout.some((r) => r.startsWith('notes/readers:'))).toBe(true);
      expect(member.fanout.some((r) => r.startsWith('notes/bob-only:'))).toBe(false);
      expect(member.superseded).toContain('notes/readers<notes/open');
      expect(member.superseded).not.toContain('notes/stale-g<notes/private');
      expect(granted.superseded).toContain('notes/stale-g<notes/private');
      expect(stranger.orphans).toContain('orph/by-readers');
      expect(member.orphans).not.toContain('orph/by-readers');
      expect(member.orphans).not.toContain('orph/by-team');
      expect(granted.fanout.some((r) => r.startsWith('notes/private:'))).toBe(true);
      expect(granted.fanout.some((r) => r.startsWith('notes/pinned:'))).toBe(false);
      return { member, granted, stranger };
    },
  );

  parityTest(
    'the links reads under excludePrivate hide an owner-only source\'s pages, and under the closed form every page while one exists',
    { methods: ['putPage', 'addLink', 'getBacklinkCounts', 'getAdjacencyBoosts', 'relationalFanout', 'relationalChainHop',
      'supersedingPageSlugs', 'findOrphanPages'] },
    async (engine, backend) => {
      const ids = new Map<string, number>();
      const open: Array<[string, PageType]> = [['people/hub', 'person'], ['notes/open', 'note'], ['notes/open-two', 'note'],
        ['concepts/synthesis', 'concept'], ['notes/stale', 'note'], ['orph/by-open', 'note'], ['orph/alone', 'note']];
      for (const [slug, type] of open) ids.set(slug, (await engine.putPage(slug, page(slug, { type }))).id);
      for (const slug of ['notes/open', 'notes/open-two', 'concepts/synthesis']) await engine.addLink(slug, 'people/hub', '', 'cites', 'manual');
      await engine.addLink('notes/open', 'notes/stale', '', 'supersedes', 'manual');
      await engine.addLink('notes/open', 'orph/by-open', '', 'cites', 'manual');
      const slugOf = new Map<number, string>();
      const read = async () => {
        const all = [...ids.values()];
        for (const [slug, id] of ids) slugOf.set(id, slug);
        return {
          back: bySlug(ids, await engine.getBacklinkCounts(all, { excludePrivate: true })).filter(([, n]) => n > 0),
          adjacency: bySlug(ids, await engine.getAdjacencyBoosts(all, { excludePrivate: true })).map(([slug]) => slug),
          fanout: sorted((await engine.relationalFanout(['people/hub'], { direction: 'in', excludePrivate: true }))
            .map((r) => `${r.slug}:${r.hop}:${r.edge_count}`)),
          hop: (await engine.relationalChainHop([ids.get('people/hub')!], {
            linkTypes: ['cites'], toward: 'subject', subjectTypes: ['note', 'atom', 'concept', 'event'], objectTypes: ['person', 'note'],
            degreeLinkTypes: ['cites'], neighborCap: 100, excludePrivate: true,
          })).map((e) => `${slugOf.get(e.from_page_id)}>${e.to_slug}:${e.from_degree}`).sort(),
          superseded: sorted([...await engine.supersedingPageSlugs(all, { excludePrivate: true })].map(([id, by]) => `${slugOf.get(id)}<${by}`)),
          orphans: sorted((await engine.findOrphanPages({ excludePrivate: true })).map((r) => `${r.source_id ?? 'default'}:${r.slug}`)),
        };
      };
      const before = await read();
      // An owner-only source: its page cites the hub, supersedes a page and is the lineage input of a default-source concept.
      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      ids.set('notes/chat', (await engine.putPage('notes/chat', page('notes/chat'), { sourceId: 'chat' })).id);
      ids.set('notes/chat-old', (await engine.putPage('notes/chat-old', page('notes/chat-old'))).id);
      await engine.addLink('notes/chat', 'people/hub', '', 'cites', 'manual', undefined, undefined, { fromSourceId: 'chat', toSourceId: 'default' });
      await engine.addLink('notes/chat', 'notes/chat-old', '', 'supersedes', 'manual', undefined, undefined, { fromSourceId: 'chat', toSourceId: 'default' });
      await engine.addLink('concepts/synthesis', 'notes/chat', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: 'default', toSourceId: 'chat' });
      const closed = await read();
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const fn = await withEngineScope(engine, read);
      expect(before.back).toContainEqual(['people/hub', 3]);
      expect(before.orphans).toContain('default:orph/alone');
      expect(closed).toEqual({ back: [], adjacency: [], fanout: [], hop: [], superseded: [], orphans: [] });
      expect(fn.back).toContainEqual(['people/hub', 2]);
      expect(fn.back.map(([slug]) => slug)).not.toContain('notes/chat-old');
      expect(fn.fanout.some((r) => r.startsWith('notes/chat:') || r.startsWith('concepts/synthesis:'))).toBe(false);
      expect(fn.superseded).toEqual(['notes/stale<notes/open']);
      expect(fn.orphans).not.toContain('chat:notes/chat');
      return { before, closed, fn };
    },
  );
});
