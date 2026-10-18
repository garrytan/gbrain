/**
 * Engine-parametrized scenarios for the non-ranking `amends` link
 * (src/core/link-ranking-policy.ts) and its liveness exemption
 * (src/core/link-validity.ts LIVENESS_EXEMPT_LINK_TYPES):
 * test/amends-link.test.ts on PGLite, test/e2e/amends-link-postgres.test.ts on
 * Postgres. Each scenario expects a fresh brain. Zero model calls (keyword-only
 * search: the gateway has no provider key).
 *
 * The invariance table has one row per link-counting ranking consumer. Each
 * row seeds a brain, reads the consumer's final output, adds ONLY amends
 * edges and reads it again (must be identical), then adds the same edges with
 * a ranking type and reads it a third time (must cross the consumer's
 * threshold), so a row that cannot see links fails instead of passing.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { hybridSearch, _resetSupersedeProbeForTests, SUPERSEDE_PENALTY } from '../../src/core/search/hybrid.ts';
import { buildRelationalArm } from '../../src/core/search/relational-recall.ts';
import { CHAIN_LINK_TYPES, runRelationalChain } from '../../src/core/search/relational-chain.ts';
import { applyGeneratedDemotion } from '../../src/core/search/provenance-demotion.ts';
import { applyEntityAnchoring } from '../../src/core/search/entity-anchor.ts';
import { findPrefixCandidates } from '../../src/core/entities/resolve.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';
import { utcToday } from '../../src/core/link-validity.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests, _resetPackCacheForTests } from '../../src/core/schema-pack/index.ts';
import { bundledPackPath } from '../../src/core/schema-pack/bundled-assets.ts';

export const EXAMPLE_PACK = 'amends-example';
const EXAMPLE_PACK_PATH = new URL('../../examples/schema-packs/amends-example/pack.yaml', import.meta.url).pathname;

/** Resolve the bundled example pack by name for the duration of a test file. */
export function useExamplePack(): () => void {
  __setPackLocatorForTests(name => name === EXAMPLE_PACK ? EXAMPLE_PACK_PATH : bundledPackPath(name));
  _resetPackCacheForTests();
  return () => { _resetPackLocatorForTests(); _resetPackCacheForTests(); };
}

type Page = { slug: string; title: string; type: string; body: string; source?: string; frontmatter?: string };

async function seed(engine: BrainEngine, pages: Page[]): Promise<void> {
  for (const source of new Set(pages.map(p => p.source ?? 'default'))) {
    if (source !== 'default') await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [source]);
  }
  for (const p of pages) {
    const md = `---\ntype: ${p.type}\ntitle: ${p.title}\n${p.frontmatter ?? ''}---\n\n${p.body}\n`;
    await importFromContent(engine, p.slug, md, { noEmbed: true, ...(p.source ? { sourceId: p.source } : {}) });
  }
}

type Edge = [from: string, to: string] | [from: string, to: string, fromSource: string, toSource: string];

/** Insert link rows the way a frontmatter mapping stores them (origin = the stating page). */
async function link(engine: BrainEngine, edges: Edge[], linkType: string): Promise<void> {
  for (const [from, to, fromSource = 'default', toSource = 'default'] of edges) {
    const inserted = await engine.executeRaw<{ id: number }>(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source, origin_page_id, origin_field, context)
       SELECT f.id, t.id, $3, 'frontmatter', f.id, $3, '' FROM pages f, pages t
        WHERE f.slug = $1 AND f.source_id = $4 AND t.slug = $2 AND t.source_id = $5 RETURNING id`,
      [from, to, linkType, fromSource, toSource]);
    if (inserted.length !== 1) throw new Error(`fixture link ${from} -> ${to} not inserted`);
  }
}

const pageId = async (engine: BrainEngine, slug: string, source = 'default') =>
  Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, source]))[0]!.id);

/** Final search output: every result's score and every ranking stamp. */
async function searchOutput(engine: BrainEngine, query: string, extra: Record<string, unknown> = {}) {
  _resetSupersedeProbeForTests();
  const results = await hybridSearch(engine, query, { limit: 20, ...extra });
  return results.map(r => ({
    slug: r.slug, source_id: r.source_id, score: r.score,
    backlink_boost: r.backlink_boost, backlink_count: r.backlink_count,
    graph_adjacency_boost: r.graph_adjacency_boost, graph_cross_source_boost: r.graph_cross_source_boost,
    superseded: r.superseded, superseded_by: r.superseded_by,
  })).sort((a, b) => `${a.source_id}:${a.slug}`.localeCompare(`${b.source_id}:${b.slug}`));
}
type SearchOut = Awaited<ReturnType<typeof searchOutput>>;
const row = (out: SearchOut, slug: string) => out.find(r => r.slug === slug)!;

const MSA_TEXT = 'Master services agreement. Payment terms are net 30 and support runs on business days.';
const AMENDMENT_TEXT = 'Amendment to the master services agreement. Payment terms change to net 45.';
const contract = (slug: string, title: string, body: string, source?: string): Page => ({ slug, title, type: 'contract', body, source });

export interface InvarianceRow {
  consumer: string;
  threshold: string;
  setup: (engine: BrainEngine) => Promise<void>;
  observe: (engine: BrainEngine) => Promise<unknown>;
  /** Edges added once as `amends` (no change allowed), then as a ranking type (must cross the threshold). */
  edges: Edge[];
  crossed: (before: any, after: any) => boolean;
}

export const INVARIANCE_ROWS: InvarianceRow[] = [
  {
    consumer: 'backlink boost (hybrid search, getBacklinkCounts)',
    threshold: 'boost applies from 1 linking page',
    setup: e => seed(e, [contract('contracts/msa-example', 'MSA Example', MSA_TEXT), contract('contracts/msa-example-amendment-1', 'MSA Example Amendment 1', AMENDMENT_TEXT)]),
    observe: e => searchOutput(e, 'payment terms master services agreement'),
    edges: [['contracts/msa-example-amendment-1', 'contracts/msa-example']],
    crossed: (b: SearchOut, a: SearchOut) => row(b, 'contracts/msa-example').backlink_boost === undefined
      && row(a, 'contracts/msa-example').backlink_boost! > 1 && row(a, 'contracts/msa-example').score > row(b, 'contracts/msa-example').score,
  },
  {
    consumer: 'in-set adjacency boost (graph signals, getAdjacencyBoosts hits)',
    threshold: 'ADJACENCY_MIN_HITS = 2 linking top-K pages',
    setup: async e => {
      await seed(e, [contract('contracts/msa-example', 'MSA Example', MSA_TEXT),
        contract('contracts/msa-example-amendment-1', 'MSA Example Amendment 1', AMENDMENT_TEXT),
        contract('contracts/msa-example-amendment-2', 'MSA Example Amendment 2', `${AMENDMENT_TEXT} Support adds weekends.`)]);
      await link(e, [['contracts/msa-example-amendment-1', 'contracts/msa-example']], 'related_to');
    },
    observe: e => searchOutput(e, 'payment terms master services agreement', { graph_signals: true }),
    edges: [['contracts/msa-example-amendment-2', 'contracts/msa-example']],
    crossed: (b: SearchOut, a: SearchOut) => row(b, 'contracts/msa-example').graph_adjacency_boost === undefined
      && row(a, 'contracts/msa-example').graph_adjacency_boost! > 1,
  },
  {
    consumer: 'cross-source adjacency boost (graph signals, getAdjacencyBoosts cross_source_hits)',
    threshold: 'CROSS_SOURCE_MIN_HITS = 2 other sources',
    setup: async e => {
      await seed(e, [contract('contracts/msa-example', 'MSA Example', MSA_TEXT),
        contract('contracts/msa-example-amendment-1', 'MSA Example Amendment 1', AMENDMENT_TEXT, 'east-example'),
        contract('contracts/msa-example-amendment-2', 'MSA Example Amendment 2', `${AMENDMENT_TEXT} Support adds weekends.`, 'west-example')]);
      await link(e, [['contracts/msa-example-amendment-1', 'contracts/msa-example', 'east-example', 'default']], 'related_to');
    },
    observe: e => searchOutput(e, 'payment terms master services agreement', { graph_signals: true }),
    edges: [['contracts/msa-example-amendment-2', 'contracts/msa-example', 'west-example', 'default']],
    crossed: (b: SearchOut, a: SearchOut) => row(b, 'contracts/msa-example').graph_cross_source_boost === undefined
      && row(a, 'contracts/msa-example').graph_cross_source_boost! > 1,
  },
  {
    consumer: 'relational fanout hops (relational search arm, type-agnostic connects)',
    threshold: 'a shared midpoint is reachable from both seeds',
    setup: async e => {
      await seed(e, [{ slug: 'companies/acme-example', title: 'Acme Example', type: 'company', body: 'A customer.' },
        { slug: 'companies/widget-example', title: 'Widget Example', type: 'company', body: 'A supplier.' },
        contract('contracts/msa-example', 'MSA Example', MSA_TEXT)]);
      await link(e, [['contracts/msa-example', 'companies/acme-example']], 'related_to');
    },
    observe: async e => (await buildRelationalArm(e, 'what connects Acme Example and Widget Example', { sourceId: 'default' }))
      .map(r => ({ slug: r.slug, score: r.score })),
    edges: [['contracts/msa-example', 'companies/widget-example']],
    crossed: (b: Array<{ slug: string }>, a: Array<{ slug: string }>) => !b.some(r => r.slug === 'contracts/msa-example') && a.some(r => r.slug === 'contracts/msa-example'),
  },
  {
    consumer: 'relational chain hops (relationalChainHop link scan)',
    threshold: 'an edge of an asked-for type is walked',
    setup: e => seed(e, [contract('contracts/msa-example', 'MSA Example', MSA_TEXT), contract('contracts/msa-example-amendment-1', 'MSA Example Amendment 1', AMENDMENT_TEXT)]),
    observe: async e => e.relationalChainHop([await pageId(e, 'contracts/msa-example-amendment-1')], {
      linkTypes: ['amends', 'related_to'], toward: 'object', subjectTypes: ['contract'], objectTypes: ['contract'],
      degreeLinkTypes: ['amends', 'related_to'], neighborCap: 100,
    }),
    edges: [['contracts/msa-example-amendment-1', 'contracts/msa-example']],
    crossed: (b: unknown[], a: Array<{ to_slug: string }>) => b.length === 0 && a.length === 1 && a[0]!.to_slug === 'contracts/msa-example',
  },
  {
    consumer: 'typed degree / hub degree (relationalChainHop from_degree; chain path weights)',
    threshold: 'hub weight falls once an intermediate gains a typed neighbor',
    setup: async e => {
      await seed(e, [{ slug: 'people/alice-example', title: 'Alice Example', type: 'person', body: 'An engineer.' },
        { slug: 'people/bob-example', title: 'Bob Example', type: 'person', body: 'A designer.' },
        { slug: 'people/carol-example', title: 'Carol Example', type: 'person', body: 'A manager.' },
        { slug: 'companies/acme-example', title: 'Acme Example', type: 'company', body: 'A customer.' },
        contract('contracts/msa-example', 'MSA Example', MSA_TEXT)]);
      await link(e, [['people/alice-example', 'companies/acme-example'], ['people/bob-example', 'companies/acme-example']], 'works_at');
    },
    observe: async e => {
      const alice = await pageId(e, 'people/alice-example');
      const chain = await runRelationalChain(e, [{ page_id: alice, slug: 'people/alice-example', source_id: 'default' }], {
        hops: [{ linkTypes: ['works_at'], toward: 'object' }, { linkTypes: ['works_at'], toward: 'subject' }], excludeAnchor: true,
      }, { sourceId: 'default' });
      const hop = await e.relationalChainHop([await pageId(e, 'companies/acme-example')], {
        linkTypes: ['works_at'], toward: 'subject', subjectTypes: ['person'], objectTypes: ['company'],
        degreeLinkTypes: [...CHAIN_LINK_TYPES, 'amends', 'related_to'], neighborCap: 100,
      });
      return { answers: chain.rows.filter(r => r.role === 'answer').map(r => ({ slug: r.slug, score: r.score })), degree: hop.map(h => h.from_degree) };
    },
    edges: [['contracts/msa-example', 'companies/acme-example'], ['people/carol-example', 'companies/acme-example']],
    crossed: (b: { degree: number[] }, a: { degree: number[] }) => b.degree.every(d => d === 2) && a.degree.every(d => d === 4),
  },
  {
    consumer: 'salience inbound counts (listEnrichCandidates order inbound-links)',
    threshold: 'order flips when one candidate gains inbound links',
    setup: e => seed(e, [{ slug: 'companies/acme-example', title: 'Acme Example', type: 'company', body: 'A customer.' },
      { slug: 'companies/widget-example', title: 'Widget Example', type: 'company', body: 'A supplier.' },
      contract('contracts/msa-example', 'MSA Example', MSA_TEXT)]),
    observe: e => e.listEnrichCandidates({ types: ['company'], thinThreshold: 10_000, order: 'inbound-links', limit: 10 })
      .then(rows => rows.map(r => ({ slug: r.slug, inbound_count: r.inbound_count }))),
    edges: [['contracts/msa-example', 'companies/widget-example']],
    crossed: (b: Array<{ slug: string }>, a: Array<{ slug: string; inbound_count: number }>) =>
      b[0]!.slug === 'companies/acme-example' && a[0]!.slug === 'companies/widget-example' && a[0]!.inbound_count === 1,
  },
  {
    consumer: 'canonical entity pick (entity resolution connection count)',
    threshold: 'the most connected prefix candidate wins',
    setup: e => seed(e, [{ slug: 'companies/acme-example', title: 'Acme Example', type: 'company', body: 'A customer.' },
      { slug: 'companies/acme-labs', title: 'Acme Labs', type: 'company', body: 'A lab.' },
      contract('contracts/msa-example', 'MSA Example', MSA_TEXT)]),
    observe: e => findPrefixCandidates(e, 'default', 'acme'),
    edges: [['contracts/msa-example', 'companies/acme-labs']],
    crossed: (b: Array<{ slug: string }>, a: Array<{ slug: string }>) => b[0]!.slug === 'companies/acme-example' && a[0]!.slug === 'companies/acme-labs',
  },
  {
    consumer: 'generated-page demotion (provenance demotion link test)',
    threshold: 'a generated page that links to the query entity is demoted',
    setup: e => seed(e, [{ slug: 'companies/acme-example', title: 'Acme Example', type: 'company', body: 'Acme Example is a customer.' },
      { slug: 'notes/acme-example-digest', title: 'Weekly digest', type: 'note', body: 'Digest of the week.', frontmatter: 'dream_generated: true\n' }]),
    observe: async e => {
      const list = [
        { page_id: await pageId(e, 'companies/acme-example'), slug: 'companies/acme-example', source_id: 'default', score: 1 },
        { page_id: await pageId(e, 'notes/acme-example-digest'), slug: 'notes/acme-example-digest', source_id: 'default', score: 1 },
      ] as SearchResult[];
      await applyGeneratedDemotion(e, list, 'Acme Example', { sourceId: 'default' });
      return list.map(r => ({ slug: r.slug, score: r.score, generated_demotion: r.generated_demotion }));
    },
    edges: [['notes/acme-example-digest', 'companies/acme-example']],
    crossed: (b: Array<{ score: number }>, a: Array<{ slug: string; score: number }>) =>
      b.every(r => r.score === 1) && a.find(r => r.slug === 'notes/acme-example-digest')!.score < 1,
  },
  {
    consumer: 'entity anchoring (pages linking to the named entity)',
    threshold: 'a page that links to the entity is anchored',
    setup: e => seed(e, [{ slug: 'companies/acme-example', title: 'Acme Example', type: 'company', body: 'A customer.' },
      contract('contracts/msa-example', 'MSA Example', MSA_TEXT)]),
    observe: async e => (await applyEntityAnchoring(e, 'what is the latest on Acme Example', [], { sourceId: 'default' }))
      .results.map(r => ({ slug: r.slug, score: r.score, entity_anchored: r.entity_anchored })),
    edges: [['contracts/msa-example', 'companies/acme-example']],
    crossed: (b: Array<{ slug: string }>, a: Array<{ slug: string }>) => !b.some(r => r.slug === 'contracts/msa-example') && a.some(r => r.slug === 'contracts/msa-example'),
  },
];

/** One invariance row: amends edges leave the final output unchanged; the same edges with a ranking type cross the threshold. */
export async function runInvarianceRow(engine: BrainEngine, r: InvarianceRow): Promise<void> {
  await r.setup(engine);
  const before = await r.observe(engine);
  await link(engine, r.edges, 'amends');
  expect(await r.observe(engine)).toEqual(before);
  await link(engine, r.edges, 'related_to');
  const control = await r.observe(engine);
  expect(r.crossed(before, control)).toBe(true);
}

// ─── Search scores and labels: unchanged terms, future amendments, replacement ───

const ctx = (engine: BrainEngine, remote = false): OperationContext => ({
  engine, config: { engine: 'pglite' as const }, logger: { info() {}, warn() {}, error() {} },
  dryRun: false, remote, sourceId: 'default', ...(remote ? { takesHoldersAllowList: ['world'] } : {}),
} as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

async function put(engine: BrainEngine, slug: string, fm: string, body: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await op('put_page').handler(ctx(engine), { slug, content: `---\n${fm}\n---\n\n${body}\n`, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The brain's current UTC date, as the default liveness filter reads it (the database clock). */
export async function databaseToday(engine: BrainEngine): Promise<string> {
  const [r] = await engine.executeRaw<{ d: string }>(`SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS d`);
  return r!.d;
}

/**
 * Write the original contract, an amendment of it that takes effect in the
 * future (through the example pack's frontmatter mapping) and a prefix-sharing
 * sibling contract with its own amendment date. Requires the example pack active.
 */
export async function seedAmendedContracts(engine: BrainEngine, today: string): Promise<{ since: string; renewalSince: string }> {
  const since = addDays(today, 400);
  const renewalSince = addDays(today, 800);
  await engine.setConfig('schema_pack', EXAMPLE_PACK);
  await put(engine, 'contracts/msa-example', 'type: contract\ntitle: MSA Example', MSA_TEXT);
  await put(engine, 'contracts/msa-example-renewal', 'type: contract\ntitle: MSA Example Renewal', 'Renewal of the services agreement for a second term.');
  await put(engine, 'contracts/msa-example-amendment-2', [
    'type: contract', 'title: MSA Example Amendment 2', 'amends:',
    '  - name: MSA Example', `    since: ${since}`,
    '  - name: MSA Example Renewal', `    since: ${renewalSince}`,
  ].join('\n'), AMENDMENT_TEXT);
  return { since, renewalSince };
}

/**
 * The example pack maps frontmatter `amends` to amends links whose `since` is
 * link_relationships.first_start in both scopes; a `since` stated only on a
 * private page is recorded in the `all` scope and absent from `world`.
 */
export async function frontmatterRecordsSince(engine: BrainEngine): Promise<void> {
  const { since, renewalSince } = await seedAmendedContracts(engine, await databaseToday(engine));
  const links = await engine.executeRaw<{ to: string; link_type: string; link_source: string }>(
    `SELECT t.slug AS "to", l.link_type, l.link_source FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = 'contracts/msa-example-amendment-2' AND l.link_type = 'amends' ORDER BY t.slug`);
  expect(links).toEqual([
    { to: 'contracts/msa-example', link_type: 'amends', link_source: 'frontmatter' },
    { to: 'contracts/msa-example-renewal', link_type: 'amends', link_source: 'frontmatter' },
  ]);
  const state = await engine.executeRaw<{ to: string; scope: string; semantics: string; first_start: string; status_now: string }>(
    `SELECT t.slug AS "to", lr.scope, lr.semantics, lr.first_start::text AS first_start, lr.status_now FROM link_relationships lr
       JOIN pages t ON t.id = lr.to_page_id WHERE lr.link_type = 'amends' ORDER BY t.slug, lr.scope`);
  expect(state).toEqual([
    { to: 'contracts/msa-example', scope: 'all', semantics: 'event', first_start: since, status_now: 'not_started' },
    { to: 'contracts/msa-example', scope: 'world', semantics: 'event', first_start: since, status_now: 'not_started' },
    { to: 'contracts/msa-example-renewal', scope: 'all', semantics: 'event', first_start: renewalSince, status_now: 'not_started' },
    { to: 'contracts/msa-example-renewal', scope: 'world', semantics: 'event', first_start: renewalSince, status_now: 'not_started' },
  ]);

  await put(engine, 'contracts/msa-example-amendment-3', [
    'type: contract', 'title: MSA Example Amendment 3', 'visibility: private', 'amends:', '  - name: MSA Example Renewal', `    since: ${since}`,
  ].join('\n'), 'A private side letter.');
  const scopes = await engine.executeRaw<{ scope: string; first_start: string }>(
    `SELECT lr.scope, lr.first_start::text AS first_start FROM link_relationships lr JOIN pages f ON f.id = lr.from_page_id
      WHERE f.slug = 'contracts/msa-example-amendment-3' AND lr.link_type = 'amends' ORDER BY lr.scope`);
  expect(scopes).toEqual([{ scope: 'all', first_start: since }]);
}

/**
 * Frozen clock: the process clock is pinned to the brain's date, and a future
 * `since` amends edge stays visible in get_backlinks, traverse_graph and the
 * entity card's edges, while a future-dated event of another type is hidden.
 * The caller pins the clock (bun:test setSystemTime) to `today`.
 */
export async function futureAmendsStayVisible(engine: BrainEngine, today: string): Promise<void> {
  expect(utcToday()).toBe(today);
  const { since } = await seedAmendedContracts(engine, today);
  await op('add_link').handler(ctx(engine), { from: 'contracts/msa-example-renewal', to: 'contracts/msa-example', link_type: 'discussed_in', valid_from: since });

  const notices: string[] = [];
  const meta: Record<string, unknown> = {};
  const reader = { ...ctx(engine), emitNotice: (n: { code: string }) => { notices.push(n.code); }, emitResponseMeta: (k: string, v: unknown) => { meta[k] = v; } } as OperationContext;
  const backlinks = await op('get_backlinks').handler(reader, { slug: 'contracts/msa-example' }) as Array<{ from_slug: string; link_type: string }>;
  expect(backlinks.map(b => `${b.from_slug}:${b.link_type}`)).toEqual(['contracts/msa-example-amendment-2:amends']);
  expect((meta['gbrain.temporal'] as { hidden: number }).hidden).toBe(1);
  expect(notices).toContain('former_relationships_hidden');

  for (const params of [{ as_of: today }, { as_of: addDays(today, -30) }]) {
    const rows = await op('get_backlinks').handler(reader, { slug: 'contracts/msa-example', ...params }) as Array<{ from_slug: string; link_type: string; status: string; stints: unknown }>;
    expect(rows.map(r => [r.link_type, r.status, r.stints])).toEqual([['amends', 'not_started', [{ from: since, until: null }]]]);
  }
  const history = await op('get_backlinks').handler(reader, { slug: 'contracts/msa-example', status: 'all' }) as Array<{ link_type: string; status: string }>;
  expect(history.map(r => `${r.link_type}:${r.status}`).sort()).toEqual(['amends:not_started', 'discussed_in:not_started']);

  const walked = await op('traverse_graph').handler(reader, { slug: 'contracts/msa-example-amendment-2', depth: 1 }) as unknown;
  expect(JSON.stringify(walked)).toContain('contracts/msa-example"');
  const remoteBacklinks = await op('get_backlinks').handler({ ...ctx(engine, true), emitNotice() {}, emitResponseMeta() {} } as OperationContext, { slug: 'contracts/msa-example' }) as Array<{ link_type: string }>;
  expect(remoteBacklinks.map(b => b.link_type)).toEqual(['amends']);

  for (let i = 0; i < 10; i++) {
    await put(engine, `people/former-${i}-example`, `type: person\ntitle: Former ${i}`, 'A former contact.');
    await op('add_link').handler(ctx(engine), { from: `people/former-${i}-example`, to: 'contracts/msa-example', link_type: 'works_at', valid_from: '2020-01-01', valid_until: '2021-01-01' });
  }
  await put(engine, 'contracts/msa-example-amendment-2', [
    'type: contract', 'title: MSA Example Amendment 2', 'amends:', '  - name: MSA Example', `    since: ${since}`,
  ].join('\n'), `${AMENDMENT_TEXT} Restated.`);
  const card = await buildEntityCard(engine, 'default', 'contracts/msa-example', { remote: false });
  const edge = card.card!.edges.find(e => e.type === 'amends' && e.direction === 'in');
  expect(edge).toEqual(expect.objectContaining({ slug: 'contracts/msa-example-amendment-2', status: 'not_started', since }));
}

/**
 * Final search scores and labels: an amendment (current or future-effective)
 * leaves the original's score unchanged and unlabeled, so its unchanged terms
 * still rank; a genuine replacement (`supersedes`) halves it and labels it.
 */
export async function amendmentsVersusReplacement(engine: BrainEngine): Promise<void> {
  await seed(engine, [contract('contracts/msa-example', 'MSA Example', MSA_TEXT),
    contract('contracts/msa-example-amendment-1', 'MSA Example Amendment 1', AMENDMENT_TEXT),
    contract('contracts/msa-example-amendment-2', 'MSA Example Amendment 2', `${AMENDMENT_TEXT} Support adds weekends.`),
    contract('contracts/msa-example-v2', 'MSA Example v2', 'Replacement master services agreement. Payment terms are net 60.')]);
  await engine.setConfig('schema_pack', EXAMPLE_PACK);
  const query = 'payment terms support business days master services agreement';
  const before = await searchOutput(engine, query);
  const msaBefore = row(before, 'contracts/msa-example');

  const future = addDays(await databaseToday(engine), 400);
  await op('add_link').handler(ctx(engine), { from: 'contracts/msa-example-amendment-1', to: 'contracts/msa-example', link_type: 'amends' });
  await op('add_link').handler(ctx(engine), { from: 'contracts/msa-example-amendment-2', to: 'contracts/msa-example', link_type: 'amends', valid_from: future });
  const amended = await searchOutput(engine, query);
  expect(amended).toEqual(before);
  expect(row(amended, 'contracts/msa-example')).toEqual(expect.objectContaining({ superseded: undefined, superseded_by: undefined }));

  await op('add_link').handler(ctx(engine), { from: 'contracts/msa-example-v2', to: 'contracts/msa-example', link_type: 'supersedes' });
  const replaced = row(await searchOutput(engine, query), 'contracts/msa-example');
  expect(replaced.superseded).toBe(true);
  expect(replaced.superseded_by).toBe('contracts/msa-example-v2');
  expect(replaced.score).toBeCloseTo(msaBefore.score * (replaced.backlink_boost ?? 1) * SUPERSEDE_PENALTY, 10);
  expect(replaced.backlink_count).toBe(1);
}
