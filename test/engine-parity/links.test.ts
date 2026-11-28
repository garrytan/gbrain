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

  // A wanted name row with no readAt fails after the edges are written: the whole replacement rolls back.
  const badWanted = {
    rows: [{ producer: 'body' as const, ref_kind: 'name' as const, target_source_id: 'default', target_ref: 'Nobody Yet', link_type: 'mentions', context: 'x' }],
    producers: ['body' as const],
  };

  parityTest(
    'replaceDerivedLinks that fails after its edges keeps the old edges (one transaction)',
    { methods: ['replaceDerivedLinks', 'readPageSnapshot', 'getLinks', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['r/origin', 'r/old', 'r/new']);
      const origin = async () => {
        const snap = await engine.readPageSnapshot('r/origin', { sourceId: 'default' });
        return { slug: 'r/origin', sourceId: 'default', expectedRevision: snap!.revision, sourceIncarnation: snap!.sourceIncarnation };
      };
      await engine.replaceDerivedLinks(await origin(), [{ from_slug: 'r/origin', to_slug: 'r/old', link_type: 'cites', link_source: 'markdown' }]);
      const error = await engine.replaceDerivedLinks(await origin(),
        [{ from_slug: 'r/origin', to_slug: 'r/new', link_type: 'cites', link_source: 'markdown' }], { wanted: badWanted })
        .then(() => 'resolved', (e: Error) => e.message);
      const after = sortedLinks(await engine.getLinks('r/origin')).map(linkKey);
      expect(after).toEqual(['r/origin>r/old:cites:markdown']);
      return { error, after };
    },
  );

  parityTest(
    'replaceDerivedLinksBatch that fails on a later origin keeps every origin\'s old edges',
    { methods: ['replaceDerivedLinksBatch', 'readPageSnapshot', 'getLinks', 'putPage'] },
    async (engine) => {
      await seedPages(engine, ['s/a', 's/b', 's/t1', 's/t2']);
      const origin = async (slug: string) => {
        const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
        return { slug, sourceId: 'default', expectedRevision: snap!.revision, sourceIncarnation: snap!.sourceIncarnation };
      };
      const error = await engine.replaceDerivedLinksBatch([
        { origin: await origin('s/a'), links: [{ from_slug: 's/a', to_slug: 's/t1', link_type: 'cites', link_source: 'markdown' }] },
        { origin: await origin('s/b'), links: [{ from_slug: 's/b', to_slug: 's/t2', link_type: 'cites', link_source: 'markdown' }], opts: { wanted: badWanted } },
      ]).then(() => 'resolved', (e: Error) => e.message);
      const a = sortedLinks(await engine.getLinks('s/a')).map(linkKey);
      const b = sortedLinks(await engine.getLinks('s/b')).map(linkKey);
      expect({ a, b }).toEqual({ a: [], b: [] });
      return { error, a, b };
    },
  );

  parityTest(
    'a derived-link replacement that fails inside a caller\'s transaction keeps the old edges while the caller commits',
    { methods: ['transaction', 'replaceDerivedLinks', 'replaceDerivedLinksBatch', 'readPageSnapshot', 'getLinks', 'putPage', 'setConfig', 'getConfig'] },
    async (engine) => {
      await seedPages(engine, ['n/origin', 'n/old', 'n/new']);
      const origin = async (e: BrainEngine) => {
        const snap = await e.readPageSnapshot('n/origin', { sourceId: 'default' });
        return { slug: 'n/origin', sourceId: 'default', expectedRevision: snap!.revision, sourceIncarnation: snap!.sourceIncarnation };
      };
      await engine.replaceDerivedLinks(await origin(engine), [{ from_slug: 'n/origin', to_slug: 'n/old', link_type: 'cites', link_source: 'markdown' }]);
      const errors = await engine.transaction(async (tx) => {
        const single = await tx.replaceDerivedLinks(await origin(tx),
          [{ from_slug: 'n/origin', to_slug: 'n/new', link_type: 'cites', link_source: 'markdown' }], { wanted: badWanted })
          .then(() => 'resolved', (e: Error) => e.message);
        const batch = await tx.replaceDerivedLinksBatch([{ origin: await origin(tx),
          links: [{ from_slug: 'n/origin', to_slug: 'n/new', link_type: 'cites', link_source: 'markdown' }], opts: { wanted: badWanted } }])
          .then(() => 'resolved', (e: Error) => e.message);
        await tx.setConfig('parity.nested_probe', 'committed');
        return { single, batch };
      });
      const after = sortedLinks(await engine.getLinks('n/origin')).map(linkKey);
      expect(after).toEqual(['n/origin>n/old:cites:markdown']);
      expect(await engine.getConfig('parity.nested_probe')).toBe('committed');
      return { errors, after };
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
