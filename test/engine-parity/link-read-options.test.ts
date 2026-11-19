/**
 * BrainEngine parity: the read options of the link reads (`getLinks`, `getBacklinks`, `traverseGraph`,
 * `traversePaths`, `traversePathsDetailed`): the temporal edge policy and its row annotation, the keyset page of the
 * get_links / get_backlinks ops, and the caller's page policy (`excludePrivate`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each read returns the same rows on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts) for every option the ops send: `temporal` (status, asOf,
 *    during, disabled) on the rows and on every walk step, the page's link type, from-page type, keyset bounds,
 *    relationship match / hidden, context cut, limit and count, and `excludePrivate` for a no-caller read and for a
 *    member caller. A bad date fails with the same TypeError.
 *  - Regression: an engine that drifts tells `gbrain links`, `gbrain backlinks`, `gbrain graph` and the
 *    get_links / get_backlinks / traverse_graph tools a different "now / ended" story, pages a listing differently,
 *    or shows a remote caller a private page or a link a private page wrote.
 *  - Why existing coverage misses it: links.test.ts reads with source scopes only, and link-temporal.test.ts checks
 *    the relationship state, not the reads that consume it. Before this file the Rust arm refused every option here.
 *  - Seam: none. Typed members only. Link ids are serial and engine-dependent, so `link_id` is mapped to its rank
 *    in a full read, keyset bounds are taken from that read, and write timestamps are replaced by their shape.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, LinkBatchInput } from '../../src/core/engine.ts';
import type { EdgeTemporalOpts, LinkReadPage } from '../../src/core/link-validity.ts';
import type { Link, PageInput } from '../../src/core/types.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const { parityTest } = parityArms(testBackends());

const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';
const WIDGET = 'companies/widget-co';
const BOARD = 'notes/board';

function page(title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra };
}

const ALICE_BODY = [
  'Alice is CTO of [Acme](../companies/acme-example).',
  '',
  '## Timeline',
  '',
  '- **2019-02-01** | linkedin — Joined [Acme](../companies/acme-example) as CTO',
  '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co)',
  '- **2025-03-02** | note — works at [Widget](../companies/widget-co)',
].join('\n');

function worksAt(to: string, context: string): LinkBatchInput {
  return { from_slug: ALICE, to_slug: to, link_type: 'works_at', context, link_source: 'markdown', from_source_id: 'default', to_source_id: 'default' };
}

/**
 * Alice worked at Acme (2019-02-01 to 2025-03-01) and works at Widget (from 2025-03-02), published as derived links
 * with the page's temporal evidence. A board note cites both companies and amends Alice's page; Alice also mentions
 * Acme (a reference link with no state).
 */
async function seedTemporal(engine: BrainEngine): Promise<void> {
  await engine.putPage(ACME, page('Acme', { type: 'company' }));
  await engine.putPage(WIDGET, page('Widget', { type: 'company' }));
  await engine.putPage(ALICE, page('Alice', { type: 'person', compiled_truth: ALICE_BODY }));
  await engine.putPage(BOARD, page('Board'));
  const snapshot = (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
  await engine.replaceDerivedLinks({ slug: ALICE, sourceId: 'default', expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation },
    [worksAt(ACME, 'CTO of Acme, leading the platform team'), worksAt(WIDGET, 'works at Widget')]);
  await engine.addLink(ALICE, ACME, 'mentions Acme in passing', 'mentions', 'manual');
  await engine.addLink(BOARD, ACME, 'board minutes cite Acme', 'cites', 'manual');
  await engine.addLink(BOARD, WIDGET, 'board minutes cite Widget', 'cites', 'manual');
  await engine.addLink(BOARD, ALICE, 'amends the title', 'amends', 'manual');
}

/** A row with its write timestamps replaced by their shape and its `link_id` by its rank in `order`. */
function view(row: Link, order: readonly number[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'recorded_at' || k === 'retired_at') out[k] = v == null ? v : typeof v;
    else if (k === 'link_id') out[k] = order.indexOf(Number(v));
    else out[k] = v;
  }
  return out;
}

const views = (rows: Link[], order: readonly number[] = []) => rows.map(r => view(r, order));
const byEdge = (rows: Record<string, unknown>[]) => sorted(rows, r => `${r.from_slug}>${r.to_slug}:${r.link_type}`);
// traversePathsDetailed orders by depth, slugs and sources; two edges between the same pair
// at the same depth (different link types) tie, and the tie order is unspecified.
const byPath = <T extends { paths: object[] }>(walk: T): T => ({
  ...walk,
  paths: sorted(walk.paths, p => {
    const r = p as Record<string, unknown>;
    return `${r.depth}|${r.from_slug}>${r.to_slug}:${r.link_type}`;
  }),
});

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

describe('engine parity: temporal link reads', () => {
  parityTest(
    'getLinks and getBacklinks with temporal annotate each row with its status, stints and dates',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'addLink', 'getLinks', 'getBacklinks'] },
    async (engine) => {
      await seedTemporal(engine);
      const out = byEdge(views(await engine.getLinks(ALICE, { temporal: {} })));
      const past = byEdge(views(await engine.getLinks(ALICE, { temporal: { asOf: '2020-06-01' } })));
      const back = byEdge(views(await engine.getBacklinks(ACME, { temporal: { status: 'all' } })));
      const scoped = byEdge(views(await engine.getBacklinks(WIDGET, { sourceIds: ['default'], temporal: { asOf: '2025-03-01' } })));
      const plain = byEdge(views(await engine.getLinks(ALICE)));
      expect(out.find(r => r.to_slug === ACME && r.link_type === 'works_at')?.status).toBe('ended');
      expect(past.find(r => r.to_slug === ACME && r.link_type === 'works_at')?.status).toBe('live');
      expect(plain.every(r => !('status' in r))).toBe(true);
      return { out, past, back, scoped, plain };
    },
  );

  parityTest(
    'the keyset page of getLinks and getBacklinks: link type, from type, bounds, limit, context cut, relationship and count',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'addLink', 'getLinks', 'getBacklinks'] },
    async (engine) => {
      await seedTemporal(engine);
      const pageOf = (p: LinkReadPage) => ({ page: p });
      const full = await engine.getLinks(ALICE, pageOf({}));
      const order = full.map(r => Number((r as Link & { link_id: number }).link_id));
      const backFull = await engine.getBacklinks(ACME, pageOf({}));
      const backOrder = backFull.map(r => Number((r as Link & { link_id: number }).link_id));
      const all = [...order, ...backOrder];
      const read = async (p: LinkReadPage, temporal?: EdgeTemporalOpts) => views(await engine.getLinks(ALICE, { ...pageOf(p), ...(temporal ? { temporal } : {}) }), all);
      const back = async (p: LinkReadPage) => views(await engine.getBacklinks(ACME, pageOf(p)), all);
      const rel = (policy: EdgeTemporalOpts, keep: 'match' | 'hidden' = 'match') => ({ relationship: { policy, keep } });
      const result = {
        full: views(full, all),
        backFull: views(backFull, all),
        first: await read({ limit: 1 }),
        afterFirst: await read({ afterId: order[0], limit: 2 }),
        through: await read({ throughId: order[1] }),
        window: await read({ afterId: order[0], throughId: order[2] }),
        zero: await read({ limit: 0 }),
        worksAt: await read({ linkType: 'works_at' }),
        cut: await read({ contextChars: 8 }),
        cutOne: await read({ contextChars: 1 }),
        cutZero: await read({ contextChars: 0 }),
        live: await read(rel({})),
        hiddenLive: await read(rel({}, 'hidden')),
        ended: await read(rel({ status: 'ended' })),
        endedHidden: await read(rel({ status: 'ended' }, 'hidden')),
        asOf: await read(rel({ asOf: '2020-06-01' })),
        during: await read(rel({ status: 'all', during: { from: '2025-01-01', until: '2025-02-01' } })),
        duringHidden: await read(rel({ status: 'all', during: { from: '2025-01-01', until: '2025-02-01' } }, 'hidden')),
        allStatus: await read(rel({ status: 'all' })),
        disabled: await read(rel({ status: 'ended', disabled: true })),
        annotated: await read(rel({}), { asOf: '2020-06-01' }),
        count: await engine.getLinks(ALICE, { ...pageOf({ ...rel({}, 'hidden'), count: true }), temporal: {} }),
        countAfter: await engine.getLinks(ALICE, pageOf({ afterId: order[0], count: true })),
        countLimited: await engine.getLinks(ALICE, pageOf({ limit: 1, count: true })),
        person: await back({ fromType: { type: 'person', aliasSources: [], aliases: [] } }),
        untyped: await back({ fromType: { type: 'untyped', aliasSources: [], aliases: [] } }),
        alias: await back({ fromType: { type: 'person', aliasSources: ['default'], aliases: ['note'] } }),
        aliasOtherSource: await back({ fromType: { type: 'person', aliasSources: ['other'], aliases: ['note'] } }),
        backCites: await back({ linkType: 'cites', contextChars: 12 }),
      };
      expect(result.first.length).toBe(1);
      expect(result.live.some(r => r.to_slug === ACME && r.link_type === 'works_at')).toBe(false);
      expect(result.ended.map(r => `${r.to_slug}:${r.link_type}`)).toEqual([`${ACME}:works_at`]);
      expect(result.count as unknown).toEqual([{ link_total: 1 }]);
      return result;
    },
  );

  parityTest(
    'a bad temporal date fails the same way on every read',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'addLink', 'getLinks', 'getBacklinks', 'traverseGraph', 'traversePathsDetailed'] },
    async (engine) => {
      await seedTemporal(engine);
      const bad = { relationship: { policy: { asOf: '2024-02-30' }, keep: 'match' as const } };
      const result = {
        getLinks: await failure(() => engine.getLinks(ALICE, { page: bad })),
        getBacklinks: await failure(() => engine.getBacklinks(ACME, { page: { relationship: { policy: { during: { from: '2024-01-01', until: '2025' } }, keep: 'hidden' } } })),
        allStatus: await failure(() => engine.getLinks(ALICE, { page: { relationship: { policy: { status: 'all', asOf: 'never' }, keep: 'match' } } })),
        graph: await failure(() => engine.traverseGraph(ALICE, 2, { temporal: { asOf: '20240101' } })),
        paths: await failure(() => engine.traversePathsDetailed(ALICE, { temporal: { status: 'ended', asOf: 'yesterday' } })),
      };
      expect(result.getLinks).toBe('TypeError: temporal edge filter: invalid date "2024-02-30"');
      expect(result.allStatus).toBe('no error');
      return result;
    },
  );

  parityTest(
    'traverseGraph and traversePathsDetailed with temporal walk and return only the edges the policy keeps',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'addLink', 'traverseGraph', 'traversePathsDetailed'] },
    async (engine) => {
      await seedTemporal(engine);
      const graph = (temporal?: EdgeTemporalOpts, slug = BOARD) => engine.traverseGraph(slug, 3, temporal ? { temporal } : {});
      const paths = async (temporal: EdgeTemporalOpts, direction: 'in' | 'out' | 'both' = 'out', slug = ALICE) =>
        byPath(await engine.traversePathsDetailed(slug, { depth: 3, direction, temporal }));
      const result = {
        graphOff: await graph(),
        graphLive: await graph({}),
        graphEnded: await graph({ status: 'ended' }),
        graphPast: await graph({ asOf: '2020-06-01' }),
        graphDuring: await graph({ status: 'all', during: { from: '2025-01-01', until: '2025-02-01' } }),
        graphDisabled: await graph({ status: 'ended', disabled: true }),
        pathsLive: await paths({}),
        pathsEnded: await paths({ status: 'ended' }),
        pathsPast: await paths({ asOf: '2020-06-01' }),
        pathsIn: await paths({}, 'in', ACME),
        pathsBoth: await paths({ status: 'ended' }, 'both', ACME),
        pathsAll: byPath(await engine.traversePathsDetailed(BOARD, { depth: 2, direction: 'both', temporal: { status: 'all' } })),
      };
      expect(result.pathsEnded.paths.map(p => `${p.to_slug}:${p.link_type}`)).toEqual([`${ACME}:works_at`]);
      expect(result.pathsLive.paths.some(p => p.to_slug === ACME && p.link_type === 'works_at')).toBe(false);
      return result;
    },
  );
});

/**
 * `excludePrivate` on the link reads and walks: a private endpoint, a readers-only endpoint and a link a private page
 * wrote never reach a remote caller; a member caller named in `readable_by` reads the readers-only page.
 */
describe('engine parity: excludePrivate on link reads and walks', () => {
  async function fixture(engine: BrainEngine): Promise<void> {
    await engine.putPage('people/hub', page('Hub', { type: 'person' }));
    await engine.putPage('notes/open', page('Open'));
    await engine.putPage('notes/other', page('Other'));
    await engine.putPage('notes/private', page('Private', { frontmatter: { visibility: 'private' } }));
    await engine.putPage('notes/readers', page('Readers', { frontmatter: { readable_by: ['alice-example'] } }));
    for (const slug of ['notes/open', 'notes/private', 'notes/readers']) await engine.addLink(slug, 'people/hub', `${slug} cites the hub`, 'cites', 'manual');
    await engine.addLink('people/hub', 'notes/open', 'hub cites open', 'cites', 'manual');
    await engine.addLink('notes/open', 'notes/private', 'open cites private', 'cites', 'manual');
    await engine.addLink('notes/private', 'notes/other', 'private cites other', 'cites', 'manual');
    // An open-to-open link written on the private page: its origin hides it.
    await engine.addLinksBatch([{ from_slug: 'notes/other', to_slug: 'people/hub', link_type: 'cites', link_source: 'frontmatter', origin_slug: 'notes/private', origin_field: 'refs' }]);
  }

  const reads = async (engine: BrainEngine, excludePrivate: boolean) => ({
    links: byEdge(views(await engine.getLinks('notes/open', { excludePrivate }))),
    back: byEdge(views(await engine.getBacklinks('people/hub', { excludePrivate }))),
    backPaged: views(await engine.getBacklinks('people/hub', { excludePrivate, page: { limit: 2, contextChars: 10 } }))
      .map(r => ({ ...r, link_id: typeof r.link_id })),
    backTemporal: byEdge(views(await engine.getBacklinks('people/hub', { excludePrivate, temporal: {} }))),
    hiddenSeed: await engine.getLinks('notes/private', { excludePrivate }),
    graph: await engine.traverseGraph('people/hub', 3, { excludePrivate }),
    graphHidden: await engine.traverseGraph('notes/private', 2, { excludePrivate }),
    paths: byPath(await engine.traversePathsDetailed('people/hub', { depth: 3, direction: 'both', excludePrivate })),
    pathsIn: byPath(await engine.traversePathsDetailed('people/hub', { depth: 2, direction: 'in', excludePrivate, temporal: {} })),
    pathsOut: await engine.traversePaths('notes/open', { depth: 2, excludePrivate }),
  });

  parityTest(
    'getLinks, getBacklinks, traverseGraph and traversePathsDetailed under excludePrivate never return a private endpoint or a link a private page wrote',
    { methods: ['putPage', 'addLink', 'addLinksBatch', 'getLinks', 'getBacklinks', 'traverseGraph', 'traversePathsDetailed'] },
    async (engine) => {
      await fixture(engine);
      const off = await reads(engine, false);
      const on = await reads(engine, true);
      const leaks = JSON.stringify(on);
      expect(leaks.includes('notes/private')).toBe(false);
      expect(leaks.includes('notes/readers')).toBe(false);
      expect(on.back.map(r => r.from_slug)).toEqual(['notes/open']);
      expect(JSON.stringify(off).includes('notes/private')).toBe(true);
      return { off, on };
    },
  );

  parityTest(
    'a remote read passes requireSafeChunks and takesHoldersAllowList too: link reads and walks ignore both, as the MCP link ops need',
    { methods: ['putPage', 'addLink', 'addLinksBatch', 'getLinks', 'getBacklinks', 'traverseGraph', 'traversePathsDetailed'] },
    async (engine) => {
      await fixture(engine);
      const remote = { excludePrivate: true, requireSafeChunks: true, takesHoldersAllowList: [] as string[] };
      const result = {
        links: byEdge(views(await engine.getLinks('notes/open', remote))),
        back: byEdge(views(await engine.getBacklinks('people/hub', { ...remote, temporal: {} }))),
        graph: await engine.traverseGraph('people/hub', 3, remote),
        paths: byPath(await engine.traversePathsDetailed('people/hub', { ...remote, depth: 3, direction: 'both', temporal: {} })),
      };
      const plain = await reads(engine, true);
      expect(result.links).toEqual(plain.links);
      expect(result.back).toEqual(plain.backTemporal);
      expect(result.graph).toEqual(plain.graph);
      expect(JSON.stringify(result).includes('notes/private')).toBe(false);
      return result;
    },
  );

  parityTest(
    'a member caller under excludePrivate reads the readers-only page and still never the private one',
    { methods: ['putPage', 'addLink', 'addLinksBatch', 'getLinks', 'getBacklinks', 'traverseGraph', 'traversePathsDetailed'] },
    async (engine) => {
      await fixture(engine);
      const member = await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, () => reads(engine, true));
      const stranger = await withCallerAccess({ identity: ['member:bob-example'], hidePrivate: true }, () => reads(engine, true));
      expect(JSON.stringify(member).includes('notes/private')).toBe(false);
      expect(member.back.map(r => r.from_slug)).toEqual(['notes/open', 'notes/readers']);
      expect(JSON.stringify(stranger).includes('notes/readers')).toBe(false);
      return { member, stranger };
    },
  );
});

/**
 * `excludePrivate` for a widening caller: a member identity plus a private-readable grant on `default`, the caller
 * the MCP get_links, get_backlinks and traverse_graph ops send for a granted token. The grant opens the private page
 * of `default` and the identity opens the readers-only page; a page of an owner-only source (`kind: imessage`) stays
 * hidden from both, and a caller without the grant still never reads the private page. One case per member.
 */
describe('engine parity: excludePrivate on link reads and walks for a widening caller', () => {
  const GRANTED = { identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true };
  const UNGRANTED = { identity: ['member:alice-example'], hidePrivate: true };

  /** The hub is cited by an open, a private, a readers-only and an owner-only-source page; the hub cites each back. */
  async function fixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
    await engine.putPage('people/hub', page('Hub', { type: 'person' }));
    await engine.putPage('notes/open', page('Open'));
    await engine.putPage('notes/private', page('Private', { frontmatter: { visibility: 'private' } }));
    await engine.putPage('notes/readers', page('Readers', { frontmatter: { readable_by: ['alice-example'] } }));
    await createSource(engine, backend, 'link-chat', { kind: 'imessage' });
    await engine.putPage('notes/chat', page('Chat'), { sourceId: 'link-chat' });
    for (const slug of ['notes/open', 'notes/private', 'notes/readers']) {
      await engine.addLink(slug, 'people/hub', `${slug} cites the hub`, 'cites', 'manual');
      await engine.addLink('people/hub', slug, `hub cites ${slug}`, 'mentions', 'manual');
    }
    await engine.addLink('notes/chat', 'people/hub', 'chat cites the hub', 'cites', 'manual', undefined, undefined, { fromSourceId: 'link-chat' });
    await engine.addLink('people/hub', 'notes/chat', 'hub cites chat', 'mentions', 'manual', undefined, undefined, { toSourceId: 'link-chat' });
  }

  /** Runs `read` for the granted and the ungranted caller in the per-page owner-only form (a recorded schema version). */
  async function asCallers<T>(engine: BrainEngine, read: () => Promise<T>): Promise<{ granted: T; ungranted: T }> {
    noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
    return withEngineScope(engine, async () => ({
      granted: await withCallerAccess(GRANTED, read),
      ungranted: await withCallerAccess(UNGRANTED, read),
    }));
  }

  function expectWidened(out: { granted: unknown; ungranted: unknown }): void {
    const granted = JSON.stringify(out.granted);
    const ungranted = JSON.stringify(out.ungranted);
    for (const slug of ['notes/open', 'notes/private', 'notes/readers']) expect(granted.includes(slug)).toBe(true);
    expect(ungranted.includes('notes/private')).toBe(false);
    expect(ungranted.includes('notes/readers')).toBe(true);
    expect(granted.includes('notes/chat')).toBe(false);
    expect(ungranted.includes('notes/chat')).toBe(false);
  }

  parityTest('getLinks serves excludePrivate for a caller with a member identity and a private-readable grant', { methods: ['putPage', 'addLink', 'getLinks'] }, async (engine, backend) => {
    await fixture(engine, backend);
    const out = await asCallers(engine, async () => byEdge(views(await engine.getLinks('people/hub', { excludePrivate: true }))));
    expectWidened(out);
    return out;
  });

  parityTest('getBacklinks serves excludePrivate for a caller with a member identity and a private-readable grant', { methods: ['putPage', 'addLink', 'getBacklinks'] }, async (engine, backend) => {
    await fixture(engine, backend);
    const out = await asCallers(engine, async () => ({
      plain: byEdge(views(await engine.getBacklinks('people/hub', { excludePrivate: true }))),
      temporal: byEdge(views(await engine.getBacklinks('people/hub', { excludePrivate: true, temporal: {} }))),
    }));
    expectWidened(out);
    return out;
  });

  parityTest('traverseGraph serves excludePrivate for a caller with a member identity and a private-readable grant', { methods: ['putPage', 'addLink', 'traverseGraph'] }, async (engine, backend) => {
    await fixture(engine, backend);
    const out = await asCallers(engine, () => engine.traverseGraph('people/hub', 2, { excludePrivate: true }));
    expectWidened(out);
    return out;
  });

  parityTest('traversePathsDetailed serves excludePrivate for a caller with a member identity and a private-readable grant', { methods: ['putPage', 'addLink', 'traversePathsDetailed'] }, async (engine, backend) => {
    await fixture(engine, backend);
    const out = await asCallers(engine, async () => ({
      both: byPath(await engine.traversePathsDetailed('people/hub', { depth: 2, direction: 'both', excludePrivate: true })),
      in: byPath(await engine.traversePathsDetailed('people/hub', { depth: 2, direction: 'in', excludePrivate: true, temporal: {} })),
    }));
    expectWidened(out);
    return out;
  });
});

/**
 * `excludePrivate` for an anonymous remote caller on a brain whose config holds no member-access restriction: the
 * caller the MCP stdio server sends (no reader identity, restricted: false), with and without a private-readable grant
 * on `default`. No page names readers, so the restriction flag stays unset, as restricted: false requires. The private
 * page opens only with the grant; a page of an owner-only source (`kind: imessage`) stays hidden from both. One case per
 * member.
 */
describe('engine parity: excludePrivate on link reads and walks for an anonymous caller on an unrestricted brain', () => {
  const ANONYMOUS = { identity: [], hidePrivate: true, restricted: false };
  const ANONYMOUS_GRANTED = { identity: [], privateReadableSources: ['default'], hidePrivate: true, restricted: false };

  /** The hub is cited by an open, a private and an owner-only-source page; the hub cites each back. */
  async function fixture(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
    await engine.putPage('people/hub', page('Hub', { type: 'person' }));
    await engine.putPage('notes/open', page('Open'));
    await engine.putPage('notes/private', page('Private', { frontmatter: { visibility: 'private' } }));
    await createSource(engine, backend, 'anon-chat', { kind: 'imessage' });
    await engine.putPage('notes/chat', page('Chat'), { sourceId: 'anon-chat' });
    for (const slug of ['notes/open', 'notes/private']) {
      await engine.addLink(slug, 'people/hub', `${slug} cites the hub`, 'cites', 'manual');
      await engine.addLink('people/hub', slug, `hub cites ${slug}`, 'mentions', 'manual');
    }
    await engine.addLink('notes/chat', 'people/hub', 'chat cites the hub', 'cites', 'manual', undefined, undefined, { fromSourceId: 'anon-chat' });
    await engine.addLink('people/hub', 'notes/chat', 'hub cites chat', 'mentions', 'manual', undefined, undefined, { toSourceId: 'anon-chat' });
  }

  /** Runs `read` for the anonymous caller with and without the grant, in the per-page owner-only form. */
  async function asCallers<T>(engine: BrainEngine, read: () => Promise<T>): Promise<{ anonymous: T; granted: T }> {
    noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
    return withEngineScope(engine, async () => ({
      anonymous: await withCallerAccess(ANONYMOUS, read),
      granted: await withCallerAccess(ANONYMOUS_GRANTED, read),
    }));
  }

  function expectServed(out: { anonymous: unknown; granted: unknown }): void {
    const anonymous = JSON.stringify(out.anonymous);
    const granted = JSON.stringify(out.granted);
    expect(anonymous.includes('notes/open')).toBe(true);
    expect(anonymous.includes('notes/private')).toBe(false);
    expect(granted.includes('notes/open')).toBe(true);
    expect(granted.includes('notes/private')).toBe(true);
    expect(anonymous.includes('notes/chat')).toBe(false);
    expect(granted.includes('notes/chat')).toBe(false);
  }

  parityTest('getLinks serves excludePrivate for an anonymous caller on an unrestricted brain', { methods: ['putPage', 'addLink', 'getLinks'] }, async (engine, backend) => {
    await fixture(engine, backend);
    const out = await asCallers(engine, async () => byEdge(views(await engine.getLinks('people/hub', { excludePrivate: true }))));
    expectServed(out);
    return out;
  });

  parityTest('getBacklinks serves excludePrivate for an anonymous caller on an unrestricted brain', { methods: ['putPage', 'addLink', 'getBacklinks'] }, async (engine, backend) => {
    await fixture(engine, backend);
    const out = await asCallers(engine, async () => ({
      plain: byEdge(views(await engine.getBacklinks('people/hub', { excludePrivate: true }))),
      temporal: byEdge(views(await engine.getBacklinks('people/hub', { excludePrivate: true, temporal: {} }))),
    }));
    expectServed(out);
    return out;
  });

  parityTest('traverseGraph serves excludePrivate for an anonymous caller on an unrestricted brain', { methods: ['putPage', 'addLink', 'traverseGraph'] }, async (engine, backend) => {
    await fixture(engine, backend);
    const out = await asCallers(engine, () => engine.traverseGraph('people/hub', 2, { excludePrivate: true }));
    expectServed(out);
    return out;
  });

  parityTest('traversePathsDetailed serves excludePrivate for an anonymous caller on an unrestricted brain', { methods: ['putPage', 'addLink', 'traversePathsDetailed'] }, async (engine, backend) => {
    await fixture(engine, backend);
    const out = await asCallers(engine, async () => ({
      both: byPath(await engine.traversePathsDetailed('people/hub', { depth: 2, direction: 'both', excludePrivate: true })),
      in: byPath(await engine.traversePathsDetailed('people/hub', { depth: 2, direction: 'in', excludePrivate: true, temporal: {} })),
    }));
    expectServed(out);
    return out;
  });
});

describe('engine parity: a remote caller whose record carries the schema version its engine scope has not recorded', () => {
  const REMOTE_POLICY = { privacyRelaxed: false, restricted: false, ownerMember: null, ownerReadsRestricted: false, membersReadLineage: false, schemaVersion: LATEST_SCHEMA_VERSION };
  /** The MCP server's caller: anonymous, on an unrestricted brain, with the remote policy its request read. */
  const REMOTE = { identity: [], hidePrivate: true, restricted: false, remotePolicy: REMOTE_POLICY };

  async function fixture(engine: BrainEngine): Promise<void> {
    await engine.putPage('people/hub', page('Hub', { type: 'person' }));
    await engine.putPage('notes/open', page('Open'));
    await engine.putPage('notes/private', page('Private', { frontmatter: { visibility: 'private' } }));
    for (const slug of ['notes/open', 'notes/private']) await engine.addLink('people/hub', slug, `hub cites ${slug}`, 'mentions', 'manual');
  }

  parityTest('getLinks renders its reference policy in the schema version the caller record carries', { methods: ['putPage', 'addLink', 'getLinks'] }, async (engine) => {
    await fixture(engine);
    const out = byEdge(views(await withCallerAccess(REMOTE, () => engine.getLinks('people/hub', { excludePrivate: true }))));
    const text = JSON.stringify(out);
    expect(text.includes('notes/open')).toBe(true);
    expect(text.includes('notes/private')).toBe(false);
    return out;
  });

  parityTest('readWriteVisibilityProbe renders its reference policy in the schema version the caller record carries', { methods: ['putPage', 'readWriteVisibilityProbe'] }, async (engine) => {
    await fixture(engine);
    const out: Record<string, unknown> = {};
    for (const slug of ['notes/open', 'notes/private']) {
      out[slug] = await withCallerAccess(REMOTE, () => engine.readWriteVisibilityProbe('default', slug)) ?? null;
    }
    expect(JSON.stringify(out['notes/open'])).not.toBe(JSON.stringify(out['notes/private']));
    return out;
  });
});
