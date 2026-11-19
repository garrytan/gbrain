/**
 * BrainEngine parity: the private-page rule on the reads and embeddings members the Rust store serves under
 * `excludePrivate`, with the owner-only rule.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for each of searchVector, getBacklinkCounts, getAdjacencyBoosts, supersedingPageSlugs, resolveAliases,
 *    aliasCanonicalRefs, getSalienceScores, getContentFlagsByPageIds, getUnverifiedExtractionPageIds and getEffectiveDates,
 *    a brain that holds a private page, a page of an owner-only source, a concept synthesized from an owner-only page, pages
 *    of another source and pages a rename moved answers the same on every arm. PGLite's answer is asserted in the case, so a
 *    Rust refusal never stands in for an answer nobody checked.
 *  - Regression: a Rust arm that returns a page the SQL policy hides. These members called the store's page policy with no
 *    owner-only sources, so `excludePrivate` returned the page of an owner-only source, and a concept derived from it, on the
 *    Rust arm only (keyword search had the same leak until the owner-only rule reached the store's copy of the policy).
 *  - Why existing coverage misses it: the excludePrivate cases of search-reads.test.ts and links.test.ts seed no owner-only
 *    source, and search-privacy.test.ts reads only the keyword and chunk members.
 *  - Seam: none for the cases (typed methods only). Page ids are engine-dependent, so every case maps them back to slugs.
 *    One further test reads the Rust arm's own engine, because a parity case counts a refusal as a pass.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { basisEmbedding, createSource, parityArms, resetArm, sorted, type EngineMethod, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest, arms } = parityArms(testBackends());

interface Fixture {
  source: string;
  slug: string;
  title?: string;
  frontmatter?: Record<string, unknown>;
  type?: string;
  /** The page is first written under this slug and renamed to `slug` once the links are in. */
  was?: string;
  /** A synthesized concept's input page (written before the rename), as the `concept-provenance` link names it. */
  derivedFrom?: { source: string; slug: string };
  /** Written with chunks and an embedding (the vector search reads these). */
  chunked?: boolean;
}

const MARKERS = { content_flag: { reason: 'markup_heavy', detail: 'test' }, provenance: 'auto-extracted', status: 'unverified' };
const SYNTH = { synthesized_by: 'dream', visibility: 'world' };

/**
 * The main pages. Each carries the markers the page-marker reads look for, an effective date and an alias. The pages the
 * policy leaves visible are `notes/open`, `notes/open-moved`, `notes/other`, `concepts/from-open` and the three atoms
 * (written `visibility: world`; an atom with no visibility is private); every other main page is hidden for one rule.
 * No owner-only rule reads an atom's origin: the store keeps no `derivation_inputs`, and PGLite leaves these atoms visible
 * too. The store's `owner_only_marks` (a hard delete of an owner-only page) are read: see `markedCase`.
 */
const MAIN: readonly Fixture[] = [
  { source: 'default', slug: 'notes/open' },
  { source: 'default', slug: 'notes/private', frontmatter: { visibility: 'private' } },
  { source: 'default', slug: 'notes/alias', frontmatter: { access: 'private' } },
  { source: 'default', slug: 'notes/readers', frontmatter: { readable_by: ['member:alice-example'] } },
  { source: 'other', slug: 'notes/other' },
  { source: 'other', slug: 'notes/other-private', frontmatter: { visibility: 'private' } },
  { source: 'vault', slug: 'notes/vault' },
  { source: 'default', slug: 'concepts/from-open', type: 'concept', frontmatter: SYNTH, derivedFrom: { source: 'default', slug: 'notes/open' } },
  { source: 'default', slug: 'concepts/from-vault', type: 'concept', frontmatter: SYNTH, derivedFrom: { source: 'vault', slug: 'notes/vault' } },
  // Pages a rename moved: the alias row names the old slug and the page keeps its source.
  { source: 'default', slug: 'notes/open-moved', was: 'notes/open-was' },
  { source: 'default', slug: 'notes/private-moved', was: 'notes/private-was', frontmatter: { visibility: 'private' } },
  { source: 'vault', slug: 'notes/vault-moved', was: 'notes/vault-was' },
  // A concept synthesized from a vault page that is renamed afterwards: the link names the page, not its slug.
  { source: 'default', slug: 'concepts/from-vault-moved', type: 'concept', frontmatter: SYNTH, derivedFrom: { source: 'vault', slug: 'notes/vault-was' } },
  // Atoms name their origin page in `source_slug`: an open page, a vault page, and the vault page by the slug a rename retired.
  { source: 'default', slug: 'notes/atom-from-open', type: 'atom', frontmatter: { visibility: 'world', source_slug: 'notes/open' } },
  { source: 'default', slug: 'notes/atom-from-vault', type: 'atom', frontmatter: { visibility: 'world', source_slug: 'notes/vault' } },
  { source: 'default', slug: 'notes/atom-via-old', type: 'atom', frontmatter: { visibility: 'world', source_slug: 'notes/vault-was' } },
];
const mainKey = (p: { source: string; slug: string }): string => `${p.source}:${p.slug}`;
const MAIN_KEYS = sorted(MAIN.map(mainKey));
const HIDDEN = [
  'default:notes/private', 'default:notes/alias', 'default:notes/readers', 'other:notes/other-private', 'vault:notes/vault',
  'default:concepts/from-vault', 'default:notes/private-moved', 'vault:notes/vault-moved', 'default:concepts/from-vault-moved',
];
const VISIBLE_MAIN = MAIN_KEYS.filter((k) => !HIDDEN.includes(k));

/** The pages that supersede one main page of the same source: the pair is readable only when both pages are. */
const SUPERSEDED = ['default:notes/open', 'default:notes/private', 'other:notes/other', 'vault:notes/vault'];
const supersederSlug = (key: string): string => `sup/${key.split(':')[1]!.replace('notes/', '')}`;

const aliasOf = (slug: string): string => `alias of ${slug.replace(/\W+/g, ' ')}`;

interface Seeded {
  ids: Map<string, number>;
}

async function seedBrain(engine: BrainEngine, backend: ParityBackend): Promise<Seeded> {
  await createSource(engine, backend, 'other');
  await createSource(engine, backend, 'vault', { owner_only: true });
  const slugAtWrite = (p: Fixture): string => p.was ?? p.slug;
  const input = (p: Fixture): PageInput => ({
    type: (p.type ?? 'note') as PageInput['type'],
    title: p.title ?? `Title of ${p.slug}`,
    compiled_truth: `reads ledger of ${p.slug}`,
    timeline: '',
    frontmatter: { ...MARKERS, ...(p.frontmatter ?? {}) },
    effective_date: new Date('2024-03-05T00:00:00Z'),
    effective_date_source: 'date',
  } as PageInput);
  for (const p of MAIN) {
    await seedPage(engine, {
      slug: slugAtWrite(p),
      input: input(p),
      chunks: [chunk(0, `reads ledger of ${p.slug}`, { embedding: basisEmbedding(3), token_count: 2 })],
    }, { sourceId: p.source });
  }
  await seedPage(engine, { slug: 'notes/hub', input: { type: 'note', title: 'Hub', compiled_truth: 'hub', timeline: '' } });
  for (const key of SUPERSEDED) {
    const [source] = key.split(':');
    await seedPage(engine, { slug: supersederSlug(key), input: { type: 'note', title: supersederSlug(key), compiled_truth: 'newer', timeline: '' } }, { sourceId: source! });
  }
  // Links name the page by the slug it holds while they are written, so the renamed pages are linked before the rename.
  for (const p of MAIN) {
    await engine.addLink('notes/hub', slugAtWrite(p), '', 'cites', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: p.source });
    if (p.derivedFrom) {
      await engine.addLink(slugAtWrite(p), p.derivedFrom.slug, '', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: p.source, toSourceId: p.derivedFrom.source });
    }
  }
  for (const key of SUPERSEDED) {
    const [source, slug] = key.split(':');
    await engine.addLink(supersederSlug(key), slug!, '', 'supersedes', 'manual', undefined, undefined, { fromSourceId: source!, toSourceId: source! });
  }
  for (const p of MAIN) {
    if (p.was) await engine.updateSlug(p.was, p.slug, { sourceId: p.source });
    await engine.setPageAliases(p.slug, p.source, [aliasOf(p.slug)]);
  }
  const ids = new Map<string, number>();
  for (const p of MAIN) ids.set(mainKey(p), (await engine.getPage(p.slug, { sourceId: p.source }))!.id);
  ids.set('default:notes/hub', (await engine.getPage('notes/hub'))!.id);
  for (const key of SUPERSEDED) {
    const [source] = key.split(':');
    ids.set(`${source}:${supersederSlug(key)}`, (await engine.getPage(supersederSlug(key), { sourceId: source! }))!.id);
  }
  return { ids };
}

/** The read as a served brain makes it: inside the engine's scope, with the schema version recorded, so the owner-only rule renders its lineage form. */
async function inBrainScope<T>(backend: string, run: () => Promise<T>): Promise<T> {
  const own = arms().find((arm) => arm.backend === backend)!.engine;
  noteSchemaVersion(own, LATEST_SCHEMA_VERSION);
  return withEngineScope(own, run);
}

const refOf = (key: string): { source_id: string; slug: string } => {
  const [source_id, slug] = key.split(':');
  return { source_id: source_id!, slug: slug! };
};
const nameOf = (seeded: Seeded) => {
  const byId = new Map([...seeded.ids].map(([k, id]) => [id, k]));
  return (id: number): string => byId.get(Number(id)) ?? `unknown:${id}`;
};
const mapKeys = (m: Map<unknown, unknown>, name: (id: number) => string): string[] => sorted([...m.keys()].map((k) => (typeof k === 'number' ? name(k) : String(k).replace('::', ':'))));

/** One member as a read over the whole fixture brain. */
interface Reader {
  member: EngineMethod;
  /** Every page the read can name, with no policy: what the case asserts for the plain read. */
  universe: string[];
  /** The view the read returns under `opts`. */
  run(engine: BrainEngine, seeded: Seeded, opts: Record<string, unknown>): Promise<string[]>;
}

const ALL_MAIN_PLUS_HUB = [...MAIN_KEYS, 'default:notes/hub'];

const READERS: Reader[] = [
  // A rename leaves the page without the chunks it was sealed with, on PGLite; the vector read cannot name the moved pages.
  { member: 'searchVector', universe: MAIN_KEYS.filter((k) => !MAIN.find((p) => mainKey(p) === k)!.was),
    run: async (e, _s, o) => sorted([...new Set((await e.searchVector(basisEmbedding(3), { limit: 50, ...o } as never)).map((r) => `${r.source_id}:${r.slug}`))]) },
  { member: 'getBacklinkCounts', universe: MAIN_KEYS,
    run: async (e, s, o) => {
      // The read answers 0 for an id it may not read, so the view says which pages the hub's link was counted for.
      const counts = await e.getBacklinkCounts(MAIN_KEYS.map((k) => s.ids.get(k)!), o as never);
      const name = nameOf(s);
      return sorted([...counts].filter(([, n]) => n > 0).map(([id]) => name(id)));
    } },
  { member: 'getAdjacencyBoosts', universe: MAIN_KEYS,
    run: async (e, s, o) => mapKeys(await e.getAdjacencyBoosts(ALL_MAIN_PLUS_HUB.map((k) => s.ids.get(k)!), o as never), nameOf(s)) },
  { member: 'supersedingPageSlugs', universe: SUPERSEDED,
    run: async (e, s, o) => {
      const found = await e.supersedingPageSlugs(SUPERSEDED.map((k) => s.ids.get(k)!), o as never);
      const name = nameOf(s);
      return sorted([...found].map(([id, by]) => `${name(id)}<${by}`));
    } },
  { member: 'resolveAliases', universe: MAIN_KEYS,
    run: async (e, _s, o) => {
      const found = await e.resolveAliases(MAIN.map((p) => aliasOf(p.slug)), o as never);
      return sorted([...found.values()].flatMap((refs) => refs.map((r) => `${r.source_id}:${r.slug}`)));
    } },
  { member: 'aliasCanonicalRefs', universe: MAIN.filter((p) => p.was).map(mainKey),
    run: async (e, _s, o) => sorted((await e.aliasCanonicalRefs(MAIN.map((p) => refOf(mainKey(p))), o as never)).map((r) => `${r.source_id}:${r.canonical_slug}`)) },
  { member: 'getSalienceScores', universe: MAIN_KEYS,
    run: async (e, s, o) => mapKeys(await e.getSalienceScores(MAIN_KEYS.map(refOf), o as never), nameOf(s)) },
  { member: 'getContentFlagsByPageIds', universe: MAIN_KEYS,
    run: async (e, s, o) => mapKeys(await e.getContentFlagsByPageIds(MAIN_KEYS.map((k) => s.ids.get(k)!), o as never), nameOf(s)) },
  { member: 'getUnverifiedExtractionPageIds', universe: MAIN_KEYS,
    run: async (e, s, o) => mapKeys(await e.getUnverifiedExtractionPageIds(MAIN_KEYS.map((k) => s.ids.get(k)!), o as never), nameOf(s)) },
  { member: 'getEffectiveDates', universe: MAIN_KEYS,
    run: async (e, s, o) => mapKeys(await e.getEffectiveDates(MAIN_KEYS.map(refOf), o as never), nameOf(s)) },
];

/** The expected view for the pages of the member's universe that the served policy leaves visible. */
function visibleView(r: Reader): string[] {
  if (r.member === 'supersedingPageSlugs') return sorted(['default:notes/open<sup/open', 'other:notes/other<sup/other']);
  return sorted(r.universe.filter((k) => !HIDDEN.includes(k)));
}
function allView(r: Reader): string[] {
  if (r.member === 'supersedingPageSlugs') return sorted(SUPERSEDED.map((k) => `${k}<${supersederSlug(k)}`));
  return sorted(r.universe);
}
const reader = (member: EngineMethod): Reader => READERS.find((r) => r.member === member)!;

/** Reads every page alike when no policy is asked for. */
const plainCase = (r: Reader) => async (engine: BrainEngine, backend: ParityBackend) => {
  const seeded = await seedBrain(engine, backend);
  const view = await r.run(engine, seeded, {});
  expect(view).toEqual(allView(r));
  return view;
};

/** The brain as a served one reads it: PGLite hides the private, alias, readers and owner-only pages and the concepts derived from them. */
const servedCase = (r: Reader) => async (engine: BrainEngine, backend: ParityBackend) => {
  const seeded = await seedBrain(engine, backend);
  const view = await inBrainScope(backend, () => r.run(engine, seeded, { excludePrivate: true }));
  expect(view).toEqual(visibleView(r));
  return view;
};

/** A call outside an engine scope reads the closed owner-only form: any owner-only source in the brain hides every page. */
const closedCase = (r: Reader) => async (engine: BrainEngine, backend: ParityBackend) => {
  const seeded = await seedBrain(engine, backend);
  const view = await r.run(engine, seeded, { excludePrivate: true });
  expect(view).toEqual([]);
  return view;
};

/** The same pages with the flag taken off the owner-only source: only the private, alias and readers pages go. */
const openedCase = (r: Reader) => async (engine: BrainEngine, backend: ParityBackend) => {
  const seeded = await seedBrain(engine, backend);
  await engine.updateSourceConfig('vault', { owner_only: false });
  const view = await inBrainScope(backend, () => r.run(engine, seeded, { excludePrivate: true }));
  const rules = ['default:notes/private', 'default:notes/alias', 'default:notes/readers', 'other:notes/other-private', 'default:notes/private-moved'];
  const expected = r.member === 'supersedingPageSlugs'
    ? sorted(['default:notes/open<sup/open', 'other:notes/other<sup/other', 'vault:notes/vault<sup/vault'])
    : sorted(r.universe.filter((k) => !rules.includes(k)));
  expect(view).toEqual(expected);
  return view;
};

/**
 * The owner-only page `vault:notes/vault` is hard-deleted while its source is owner-only, then the source stops being
 * owner-only: the concept synthesized from it stays hidden, because the delete recorded it in `owner_only_marks`
 * (`owner_only_marks.rs`) before the page's `concept-provenance` link went. Every other open page keeps reading.
 */
const markedCase = (r: Reader) => async (engine: BrainEngine, backend: ParityBackend) => {
  const seeded = await seedBrain(engine, backend);
  await engine.deletePage('notes/vault', { sourceId: 'vault' });
  await engine.updateSourceConfig('vault', { owner_only: false });
  const view = await inBrainScope(backend, () => r.run(engine, seeded, { excludePrivate: true }));
  const concept = 'default:concepts/from-vault';
  // A member that names the concept must not return it; a member that names the open page must still return it, so the
  // case never passes on a read that refuses everything.
  if (r.universe.includes(concept)) expect(view).not.toContain(concept);
  if (r.universe.includes('default:notes/open')) expect(view.some((v) => v.startsWith('default:notes/open'))).toBe(true);
  return view;
};

describe('private pages, owner-only pages and other sources across the reads and embeddings members', () => {
  // Each case names its member as a literal: the coverage list reads the declarations from the source.
  parityTest('searchVector: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['searchVector'] }, plainCase(reader('searchVector')));
  parityTest('searchVector: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['searchVector'] }, servedCase(reader('searchVector')));
  parityTest('searchVector: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['searchVector'] }, closedCase(reader('searchVector')));
  parityTest('searchVector: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['searchVector'] }, openedCase(reader('searchVector')));
  parityTest('getBacklinkCounts: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['getBacklinkCounts'] }, plainCase(reader('getBacklinkCounts')));
  parityTest('getBacklinkCounts: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['getBacklinkCounts'] }, servedCase(reader('getBacklinkCounts')));
  parityTest('getBacklinkCounts: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['getBacklinkCounts'] }, closedCase(reader('getBacklinkCounts')));
  parityTest('getBacklinkCounts: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['getBacklinkCounts'] }, openedCase(reader('getBacklinkCounts')));
  parityTest('getAdjacencyBoosts: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['getAdjacencyBoosts'] }, plainCase(reader('getAdjacencyBoosts')));
  parityTest('getAdjacencyBoosts: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['getAdjacencyBoosts'] }, servedCase(reader('getAdjacencyBoosts')));
  parityTest('getAdjacencyBoosts: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['getAdjacencyBoosts'] }, closedCase(reader('getAdjacencyBoosts')));
  parityTest('getAdjacencyBoosts: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['getAdjacencyBoosts'] }, openedCase(reader('getAdjacencyBoosts')));
  parityTest('supersedingPageSlugs: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['supersedingPageSlugs'] }, plainCase(reader('supersedingPageSlugs')));
  parityTest('supersedingPageSlugs: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['supersedingPageSlugs'] }, servedCase(reader('supersedingPageSlugs')));
  parityTest('supersedingPageSlugs: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['supersedingPageSlugs'] }, closedCase(reader('supersedingPageSlugs')));
  parityTest('supersedingPageSlugs: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['supersedingPageSlugs'] }, openedCase(reader('supersedingPageSlugs')));
  parityTest('resolveAliases: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['resolveAliases'] }, plainCase(reader('resolveAliases')));
  parityTest('resolveAliases: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['resolveAliases'] }, servedCase(reader('resolveAliases')));
  parityTest('resolveAliases: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['resolveAliases'] }, closedCase(reader('resolveAliases')));
  parityTest('resolveAliases: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['resolveAliases'] }, openedCase(reader('resolveAliases')));
  parityTest('aliasCanonicalRefs: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['aliasCanonicalRefs'] }, plainCase(reader('aliasCanonicalRefs')));
  parityTest('aliasCanonicalRefs: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['aliasCanonicalRefs'] }, servedCase(reader('aliasCanonicalRefs')));
  parityTest('aliasCanonicalRefs: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['aliasCanonicalRefs'] }, closedCase(reader('aliasCanonicalRefs')));
  parityTest('aliasCanonicalRefs: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['aliasCanonicalRefs'] }, openedCase(reader('aliasCanonicalRefs')));
  parityTest('getSalienceScores: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['getSalienceScores'] }, plainCase(reader('getSalienceScores')));
  parityTest('getSalienceScores: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['getSalienceScores'] }, servedCase(reader('getSalienceScores')));
  parityTest('getSalienceScores: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['getSalienceScores'] }, closedCase(reader('getSalienceScores')));
  parityTest('getSalienceScores: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['getSalienceScores'] }, openedCase(reader('getSalienceScores')));
  parityTest('getContentFlagsByPageIds: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['getContentFlagsByPageIds'] }, plainCase(reader('getContentFlagsByPageIds')));
  parityTest('getContentFlagsByPageIds: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['getContentFlagsByPageIds'] }, servedCase(reader('getContentFlagsByPageIds')));
  parityTest('getContentFlagsByPageIds: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['getContentFlagsByPageIds'] }, closedCase(reader('getContentFlagsByPageIds')));
  parityTest('getContentFlagsByPageIds: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['getContentFlagsByPageIds'] }, openedCase(reader('getContentFlagsByPageIds')));
  parityTest('getUnverifiedExtractionPageIds: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['getUnverifiedExtractionPageIds'] }, plainCase(reader('getUnverifiedExtractionPageIds')));
  parityTest('getUnverifiedExtractionPageIds: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['getUnverifiedExtractionPageIds'] }, servedCase(reader('getUnverifiedExtractionPageIds')));
  parityTest('getUnverifiedExtractionPageIds: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['getUnverifiedExtractionPageIds'] }, closedCase(reader('getUnverifiedExtractionPageIds')));
  parityTest('getUnverifiedExtractionPageIds: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['getUnverifiedExtractionPageIds'] }, openedCase(reader('getUnverifiedExtractionPageIds')));
  parityTest('getEffectiveDates: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['getEffectiveDates'] }, plainCase(reader('getEffectiveDates')));
  parityTest('getEffectiveDates: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['getEffectiveDates'] }, servedCase(reader('getEffectiveDates')));
  parityTest('getEffectiveDates: excludePrivate outside an engine scope hides every page of a brain that holds an owner-only source', { methods: ['getEffectiveDates'] }, closedCase(reader('getEffectiveDates')));
  parityTest('getEffectiveDates: excludePrivate in a brain whose owner-only source was opened hides the private pages and nothing else', { methods: ['getEffectiveDates'] }, openedCase(reader('getEffectiveDates')));

  parityTest('searchVector: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['searchVector', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('searchVector')));
  parityTest('getBacklinkCounts: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['getBacklinkCounts', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('getBacklinkCounts')));
  parityTest('getAdjacencyBoosts: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['getAdjacencyBoosts', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('getAdjacencyBoosts')));
  parityTest('supersedingPageSlugs: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['supersedingPageSlugs', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('supersedingPageSlugs')));
  parityTest('resolveAliases: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['resolveAliases', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('resolveAliases')));
  parityTest('aliasCanonicalRefs: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['aliasCanonicalRefs', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('aliasCanonicalRefs')));
  parityTest('getSalienceScores: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['getSalienceScores', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('getSalienceScores')));
  parityTest('getContentFlagsByPageIds: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['getContentFlagsByPageIds', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('getContentFlagsByPageIds')));
  parityTest('getUnverifiedExtractionPageIds: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['getUnverifiedExtractionPageIds', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('getUnverifiedExtractionPageIds')));
  parityTest('getEffectiveDates: a concept stays hidden after its owner-only input page is hard-deleted and its source is opened', { methods: ['getEffectiveDates', 'deletePage', 'updateSourceConfig'] }, markedCase(reader('getEffectiveDates')));

  // The owner-only rule follows a page by id and source, not by slug: a rename or an alias does not move a vault page out of it.
  parityTest(
    'owner-only pages stay hidden under a renamed slug and through an alias, and a concept keeps its owner-only input across a rename',
    { methods: ['searchVector', 'aliasCanonicalRefs', 'resolveAliases'] },
    async (engine, backend) => {
      const seeded = await seedBrain(engine, backend);
      const vector = await inBrainScope(backend, () => reader('searchVector').run(engine, seeded, { excludePrivate: true }));
      const canonical = await inBrainScope(backend, () => reader('aliasCanonicalRefs').run(engine, seeded, { excludePrivate: true }));
      const aliases = await inBrainScope(backend, () => reader('resolveAliases').run(engine, seeded, { excludePrivate: true }));
      expect(aliases).toContain('default:notes/open-moved');
      for (const view of [vector, aliases]) {
        expect(view).not.toContain('vault:notes/vault-moved');
        expect(view).not.toContain('default:concepts/from-vault-moved');
      }
      expect(canonical).toEqual(['default:notes/open-moved']);
      return { vector, canonical, aliases };
    },
  );
});

describe('the Rust arm serves each member and returns exactly the pages PGLite leaves visible', () => {
  // A parity case counts a typed refusal as a pass, so this test reads the Rust arm's own engine: each member must answer
  // (not refuse) with the view PGLite gave above, in a served brain and outside a scope.
  test('every member answers under excludePrivate with the served view and the closed view', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    const engine = rust.engine;
    const seeded = await seedBrain(engine, 'rust');
    for (const r of READERS) {
      const served = await inBrainScope('rust', () => r.run(engine, seeded, { excludePrivate: true }));
      expect({ member: r.member, served }).toEqual({ member: r.member, served: visibleView(r) });
      const closed = await r.run(engine, seeded, { excludePrivate: true });
      expect({ member: r.member, closed }).toEqual({ member: r.member, closed: [] });
    }
  });

  // The members whose SQL reads a page policy but that the store does not serve under excludePrivate refuse it, naming the option.
  test('the members the store does not serve under excludePrivate refuse it', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    const engine = rust.engine;
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['getRecentSalience', () => engine.getRecentSalience({ excludePrivate: true } as never)],
      ['findAnomalies', () => engine.findAnomalies({ excludePrivate: true } as never)],
      ['getTags', () => engine.getTags('notes/open', { excludePrivate: true })],
    ];
    for (const [member, call] of calls) {
      const error = await (async () => call())().then(() => null, (e: unknown) => e as { code?: string; message?: string });
      expect({ member, code: error?.code, message: error?.message })
        .toMatchObject({ code: 'engine_capability_missing', message: expect.stringContaining('excludePrivate') });
    }
  });
});
