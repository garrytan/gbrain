/**
 * BrainEngine parity — the private-page rule on the ten search and chunk-read members the Rust store serves.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for each of searchKeyword, searchKeywordChunks, countKeywordPages, searchKeywordPages, searchTitles,
 *    findByTitleFuzzy, getChunkPage, getChunkWindows, countChunklessPagesWithContent and listChunklessPagesWithContent,
 *    a brain that holds a private page, a page of an owner-only source (and a concept derived from it) and pages of
 *    another source answers the same on every arm, or the Rust arm ends on the typed refusal the member owes
 *    (`engine_capability_missing`, before it reads anything). PGLite's answer is asserted in the case, so a refusal on
 *    the Rust arm never stands in for an answer nobody checked.
 *  - Regression: a Rust arm that returns a page the SQL policy hides. The owner-only rule (the page of an owner-only
 *    source, a concept or question synthesized from one) was not in the store's copy of the policy, so excludePrivate
 *    returned the owner-only page on the Rust arm only.
 *  - Why existing coverage misses it: the searchKeyword excludePrivate case in search.test.ts seeds no owner-only
 *    source, and the other nine members were compared without excludePrivate or not at all.
 *  - Seam: none for the cases (typed methods only). Two further tests read the Rust arm's own engine and the
 *    store-member functions with a brain that throws on any use, because a parity case counts a refusal as a pass.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { STORE_MEMBERS } from '../../src/core/rust-engine/store-members/index.ts';
import { createSource, parityArms, sorted, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest, arms } = parityArms(testBackends());

type Fixture = { source: string; slug: string; title: string; frontmatter?: Record<string, unknown>; type?: string; derivedFrom?: { source: string; slug: string } };

/**
 * One page of each kind the policy tells apart. Every page carries the term `heliotrope` in its title and its body.
 * `notes/open` and `notes/other` are the only pages the policy leaves visible, with `concepts/from-open` (a synthesized
 * concept whose input page is open); the rest are hidden for one rule each.
 */
const PAGES: readonly Fixture[] = [
  { source: 'default', slug: 'notes/open', title: 'Heliotrope Open' },
  { source: 'default', slug: 'notes/private', title: 'Heliotrope Private', frontmatter: { visibility: 'private' } },
  { source: 'default', slug: 'notes/alias', title: 'Heliotrope Alias', frontmatter: { access: 'private' } },
  { source: 'default', slug: 'notes/readers', title: 'Heliotrope Readers', frontmatter: { readable_by: ['member:alice-example'] } },
  { source: 'other', slug: 'notes/other', title: 'Heliotrope Other' },
  { source: 'other', slug: 'notes/other-private', title: 'Heliotrope Other Private', frontmatter: { visibility: 'private' } },
  { source: 'vault', slug: 'notes/vault', title: 'Heliotrope Vault' },
  { source: 'default', slug: 'concepts/from-open', title: 'Heliotrope Concept Open', type: 'concept', frontmatter: { synthesized_by: 'dream', visibility: 'world' }, derivedFrom: { source: 'default', slug: 'notes/open' } },
  { source: 'default', slug: 'concepts/from-vault', title: 'Heliotrope Concept Vault', type: 'concept', frontmatter: { synthesized_by: 'dream', visibility: 'world' }, derivedFrom: { source: 'vault', slug: 'notes/vault' } },
];
const key = (p: { source: string; slug: string }): string => `${p.source}:${p.slug}`;
const ALL = sorted(PAGES.map(key));
/** What the policy leaves visible when the brain holds an owner-only source and the schema carries the lineage functions. */
const VISIBLE = ['default:concepts/from-open', 'default:notes/open', 'other:notes/other'];
/** The policy as a brain below schema v320 (or an unscoped call) reads it: any owner-only source in the brain hides every page. */
const CLOSED_VISIBLE: string[] = [];

/** Seeds the sources and the pages: `chunked` pages carry two sealed chunks, the others none (the chunkless members read those). */
async function seedBrain(engine: BrainEngine, backend: Parameters<typeof createSource>[1], chunked: boolean): Promise<void> {
  await createSource(engine, backend, 'other');
  await createSource(engine, backend, 'vault', { owner_only: true });
  for (const p of PAGES) {
    const input: PageInput = {
      type: (p.type ?? 'note') as PageInput['type'],
      title: p.title,
      compiled_truth: `heliotrope ledger of ${p.slug}`,
      timeline: '',
      ...(p.frontmatter ? { frontmatter: p.frontmatter } : {}),
    };
    await seedPage(engine, { slug: p.slug, input, chunks: chunked ? [chunk(0, `heliotrope ledger of ${p.slug}`), chunk(1, `heliotrope second chunk of ${p.slug}`)] : undefined }, { sourceId: p.source });
  }
  for (const p of PAGES) {
    if (!p.derivedFrom) continue;
    await engine.addLink(p.slug, p.derivedFrom.slug, '', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: p.source, toSourceId: p.derivedFrom.source });
  }
}

/**
 * The read as a served brain makes it: inside the engine's scope, with the schema version the connect gate records on it
 * (connectEngine reads config `version`: the migrated PGLite brain and the Rust store, opened at the latest version, both
 * report it), so the owner-only rule renders its lineage form. The harness clears config between cases, so the version is
 * noted here rather than read.
 */
async function inBrainScope<T>(backend: string, run: () => Promise<T>): Promise<T> {
  // The scenario's engine records its calls; the scope and the version belong to the arm's own engine.
  const own = arms().find((arm) => arm.backend === backend)!.engine;
  noteSchemaVersion(own, LATEST_SCHEMA_VERSION);
  return withEngineScope(own, run);
}

/** The pages a result names, once each (a chunk-grain result names a page once per chunk). */
const keys = (rows: Array<{ source_id?: string; slug: string }>): string[] => sorted([...new Set(rows.map((r) => `${r.source_id}:${r.slug}`))]);

type Search = Parameters<BrainEngine['searchKeyword']>[1];
const WINDOW = { limit: 50, offset: 0 };
const Q = 'heliotrope';

/** Each member as a read over the whole fixture brain: the view it returns, given the options of the privacy case. */
interface Reader {
  member: string;
  /** Does PGLite apply `excludePrivate` here? (The chunkless and title-lookup members have no privacy option at all.) */
  hasPrivacyOption: boolean;
  run(engine: BrainEngine, opts: Record<string, unknown>): Promise<unknown>;
  /** The view of the pages the policy leaves visible, for the `excludePrivate` case. */
  visible(pages: readonly string[]): unknown;
  /** The view of every page. */
  all: unknown;
  chunked: boolean;
}

const chunkTotals = async (engine: BrainEngine, opts: Record<string, unknown>): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const p of PAGES) {
    const read = await engine.getChunkPage(p.slug, { fromIndex: 0, limit: 10, sourceId: p.source, ...opts });
    out[key(p)] = read.total_chunks;
  }
  return out;
};
const totalsFor = (visible: readonly string[]): Record<string, number> => Object.fromEntries(PAGES.map((p) => [key(p), visible.includes(key(p)) ? 2 : 0]));

const windowKeys = async (engine: BrainEngine, opts: Record<string, unknown>): Promise<string[]> => {
  const requests: Array<{ page_id: number; from_index: number; to_index: number; priority: number }> = [];
  for (const p of PAGES) {
    const page = await engine.getPage(p.slug, { sourceId: p.source });
    requests.push({ page_id: page!.id, from_index: 0, to_index: 5, priority: requests.length });
  }
  const pages = await engine.getChunkWindows(requests, { chunkSources: ['compiled_truth'], maxRows: 100, ...opts });
  return sorted(pages.map((p) => `${p.source_id}:${p.slug}`));
};

const titleLookups = async (engine: BrainEngine, sourceId?: string): Promise<Record<string, string | null>> => {
  const out: Record<string, string | null> = {};
  for (const p of PAGES) out[p.title] = (await engine.findByTitleFuzzy(p.title, undefined, 0.9, sourceId))?.slug ?? null;
  return out;
};

const READERS: Reader[] = [
  { member: 'searchKeyword', hasPrivacyOption: true, chunked: true, all: ALL, visible: (v) => [...v],
    run: async (e, o) => keys(await e.searchKeyword(Q, { limit: 50, ...(o as Search) })) },
  { member: 'searchKeywordChunks', hasPrivacyOption: true, chunked: true, all: ALL, visible: (v) => [...v],
    run: async (e, o) => keys(await e.searchKeywordChunks(Q, { limit: 50, ...(o as Search) })) },
  { member: 'countKeywordPages', hasPrivacyOption: true, chunked: true, all: ALL.length, visible: (v) => v.length,
    run: (e, o) => e.countKeywordPages(Q, { ...(o as Search) }) },
  { member: 'searchKeywordPages', hasPrivacyOption: true, chunked: true, all: ALL, visible: (v) => [...v],
    run: async (e, o) => keys(await e.searchKeywordPages(Q, { ...(o as Search) }, WINDOW)) },
  { member: 'searchTitles', hasPrivacyOption: true, chunked: true, all: ALL, visible: (v) => [...v],
    run: async (e, o) => keys(await e.searchTitles(Q, { limit: 50, ...(o as Search) })) },
  { member: 'getChunkPage', hasPrivacyOption: true, chunked: true, all: totalsFor(ALL), visible: totalsFor,
    run: (e, o) => chunkTotals(e, o) },
  { member: 'getChunkWindows', hasPrivacyOption: true, chunked: true, all: ALL, visible: (v) => [...v],
    run: (e, o) => windowKeys(e, o) },
];

/** Reads every page alike when no policy is asked for. */
const plainCase = (reader: Reader) => async (engine: BrainEngine, backend: ParityBackend) => {
  await seedBrain(engine, backend, reader.chunked);
  const view = await reader.run(engine, {});
  expect(view).toEqual(reader.all);
  return view;
};

/**
 * The brain as a served one reads it: the lineage form of the owner-only rule. PGLite hides the private, alias, named-readers
 * and owner-only pages and the concept derived from the owner-only page; the Rust arm answers equally or refuses the option.
 */
const servedCase = (reader: Reader) => async (engine: BrainEngine, backend: ParityBackend) => {
  await seedBrain(engine, backend, reader.chunked);
  const view = await inBrainScope(backend, () => reader.run(engine, { excludePrivate: true }));
  expect(view).toEqual(reader.visible(VISIBLE));
  return view;
};

const scopedCase = (reader: Reader) => async (engine: BrainEngine, backend: ParityBackend) => {
  await seedBrain(engine, backend, reader.chunked);
  const scoped = async (o: Record<string, unknown>) => inBrainScope(backend, () => reader.run(engine, { excludePrivate: true, ...o }));
  const other = await scoped({ sourceId: 'other' });
  const vault = await scoped({ sourceId: 'vault' });
  const both = await scoped({ sourceIds: ['other', 'vault'] });
  // getChunkPage reads one named source per call, so its scope is the page's own: the case reads every page already.
  if (reader.member !== 'getChunkPage') {
    expect(other).toEqual(reader.visible(['other:notes/other']));
    expect(vault).toEqual(reader.visible([]));
    expect(both).toEqual(reader.visible(['other:notes/other']));
  }
  return { other, vault, both };
};

const reader = (member: string): Reader => READERS.find((r) => r.member === member)!;

describe('private pages, owner-only pages and other sources across the search and chunk-read members', () => {
  parityTest('searchKeyword: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['searchKeyword'] }, plainCase(reader('searchKeyword')));
  parityTest('searchKeyword: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['searchKeyword'] }, servedCase(reader('searchKeyword')));
  parityTest('searchKeyword: excludePrivate scoped to the other source, to the owner-only source and to a list of both', { methods: ['searchKeyword'] }, scopedCase(reader('searchKeyword')));

  parityTest('searchKeywordChunks: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['searchKeywordChunks'] }, plainCase(reader('searchKeywordChunks')));
  parityTest('searchKeywordChunks: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['searchKeywordChunks'] }, servedCase(reader('searchKeywordChunks')));
  parityTest('searchKeywordChunks: excludePrivate scoped to the other source, to the owner-only source and to a list of both', { methods: ['searchKeywordChunks'] }, scopedCase(reader('searchKeywordChunks')));

  parityTest('countKeywordPages: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['countKeywordPages'] }, plainCase(reader('countKeywordPages')));
  parityTest('countKeywordPages: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['countKeywordPages'] }, servedCase(reader('countKeywordPages')));
  parityTest('countKeywordPages: excludePrivate scoped to the other source, to the owner-only source and to a list of both', { methods: ['countKeywordPages'] }, scopedCase(reader('countKeywordPages')));

  parityTest('searchKeywordPages: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['searchKeywordPages'] }, plainCase(reader('searchKeywordPages')));
  parityTest('searchKeywordPages: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['searchKeywordPages'] }, servedCase(reader('searchKeywordPages')));
  parityTest('searchKeywordPages: excludePrivate scoped to the other source, to the owner-only source and to a list of both', { methods: ['searchKeywordPages'] }, scopedCase(reader('searchKeywordPages')));

  parityTest('searchTitles: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['searchTitles'] }, plainCase(reader('searchTitles')));
  parityTest('searchTitles: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['searchTitles'] }, servedCase(reader('searchTitles')));
  parityTest('searchTitles: excludePrivate scoped to the other source, to the owner-only source and to a list of both', { methods: ['searchTitles'] }, scopedCase(reader('searchTitles')));

  parityTest('getChunkPage: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['getChunkPage'] }, plainCase(reader('getChunkPage')));
  parityTest('getChunkPage: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['getChunkPage'] }, servedCase(reader('getChunkPage')));
  parityTest('getChunkPage: excludePrivate scoped to the other source, to the owner-only source and to a list of both', { methods: ['getChunkPage'] }, scopedCase(reader('getChunkPage')));

  parityTest('getChunkWindows: without excludePrivate it reads the private, owner-only and other-source pages alike', { methods: ['getChunkWindows'] }, plainCase(reader('getChunkWindows')));
  parityTest('getChunkWindows: excludePrivate in a served brain hides the private, owner-only and derived pages and keeps the other source', { methods: ['getChunkWindows'] }, servedCase(reader('getChunkWindows')));
  parityTest('getChunkWindows: excludePrivate scoped to the other source, to the owner-only source and to a list of both', { methods: ['getChunkWindows'] }, scopedCase(reader('getChunkWindows')));

  // The brain a call reads outside an engine scope (a test, a script): the version is unknown, so the owner-only rule takes its
  // closed form and any owner-only source in the brain hides every page. The Rust arm must read the same.
  parityTest(
    'searchKeyword: excludePrivate with the closed owner-only form hides every page of a brain that holds an owner-only source',
    { methods: ['searchKeyword'] },
    async (engine, backend) => {
      await seedBrain(engine, backend, true);
      const view = keys(await engine.searchKeyword(Q, { limit: 50, excludePrivate: true }));
      expect(view).toEqual(CLOSED_VISIBLE);
      return view;
    },
  );

  parityTest(
    'searchKeyword: excludePrivate in a brain with no owner-only source hides the private pages and nothing else',
    { methods: ['searchKeyword'] },
    async (engine, backend) => {
      await seedBrain(engine, backend, true);
      // The same pages with the owner-only flag taken off the source: only the private, alias and named-readers pages go.
      await engine.updateSourceConfig('vault', { owner_only: false });
      const view = await inBrainScope(backend, async () => keys(await engine.searchKeyword(Q, { limit: 50, excludePrivate: true })));
      expect(view).toEqual(sorted(['default:concepts/from-open', 'default:concepts/from-vault', 'default:notes/open', 'other:notes/other', 'vault:notes/vault']));
      return view;
    },
  );

  // The two title lookups: findByTitleFuzzy has no privacy option, so it reads every page's title on every arm. It also takes no
  // options object, so the unhandled-option case (c) does not apply to it; searchTitles carries both.
  parityTest(
    'findByTitleFuzzy: finds the private, owner-only and other-source pages by title, unscoped and in each source',
    { methods: ['findByTitleFuzzy'] },
    async (engine, backend) => {
      await seedBrain(engine, backend, true);
      const unscoped = await titleLookups(engine);
      const other = await titleLookups(engine, 'other');
      const vault = await titleLookups(engine, 'vault');
      expect(unscoped['Heliotrope Private']).toBe('notes/private');
      expect(unscoped['Heliotrope Vault']).toBe('notes/vault');
      expect(unscoped['Heliotrope Other']).toBe('notes/other');
      expect(other['Heliotrope Other Private']).toBe('notes/other-private');
      expect(other['Heliotrope Open']).toBeNull();
      expect(vault['Heliotrope Vault']).toBe('notes/vault');
      return { unscoped, other, vault };
    },
  );

  // The two chunkless reads have no privacy option on any arm: every page with a body and no chunks answers.
  parityTest(
    'countChunklessPagesWithContent and listChunklessPagesWithContent: read the private, owner-only and other-source pages, unscoped and per source',
    { methods: ['countChunklessPagesWithContent', 'listChunklessPagesWithContent'] },
    async (engine, backend) => {
      await seedBrain(engine, backend, false);
      const view = async (sourceId?: string) => {
        const opts = sourceId ? { sourceId } : undefined;
        return { count: await engine.countChunklessPagesWithContent(opts), rows: keys(await engine.listChunklessPagesWithContent({ ...opts, batchSize: 50 })) };
      };
      const all = await view();
      expect(all).toEqual({ count: ALL.length, rows: ALL });
      const other = await view('other');
      expect(other).toEqual({ count: 2, rows: ['other:notes/other', 'other:notes/other-private'] });
      const vault = await view('vault');
      expect(vault).toEqual({ count: 1, rows: ['vault:notes/vault'] });
      return { all, other, vault };
    },
  );
});

type Refusal = { code?: string; message?: string };
const refusal = async (run: () => Promise<unknown>): Promise<Refusal> => {
  // A member that refuses before it returns a promise throws synchronously; the async wrapper reads both the same.
  const error = await (async () => run())().then(() => null, (e: unknown) => e as Refusal);
  return { code: error?.code, message: error?.message };
};

/** The members that refuse `excludePrivate`, each as the call that carries it. */
const EXCLUDE_PRIVATE_CALLS: Array<[string, (e: BrainEngine) => Promise<unknown>]> = [
  ['searchKeywordChunks', (e) => e.searchKeywordChunks(Q, { excludePrivate: true })],
  ['countKeywordPages', (e) => e.countKeywordPages(Q, { excludePrivate: true })],
  ['searchKeywordPages', (e) => e.searchKeywordPages(Q, { excludePrivate: true }, WINDOW)],
  ['getChunkPage', (e) => e.getChunkPage('notes/open', { fromIndex: 0, limit: 5, excludePrivate: true })],
  ['getChunkWindows', (e) => e.getChunkWindows([{ page_id: 1, from_index: 0, to_index: 1, priority: 0 }], { chunkSources: ['compiled_truth'], maxRows: 10, excludePrivate: true } as never)],
  ['countChunklessPagesWithContent', (e) => e.countChunklessPagesWithContent({ excludePrivate: true } as never)],
  ['listChunklessPagesWithContent', (e) => e.listChunklessPagesWithContent({ excludePrivate: true } as never)],
];

describe('the Rust arm answers or refuses each private-page case the way this file says', () => {
  // A parity case counts a typed refusal as a pass, so this test reads the Rust arm's own engine: it says which member is served
  // (and what it returns, hard-coded from PGLite's answer above) and which refuses, with the code and the option named.
  test('searchKeyword and searchTitles serve excludePrivate and return exactly the pages PGLite leaves visible; the other members refuse it', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    const engine = rust.engine;
    await seedBrain(engine, 'rust', true);
    const served = await inBrainScope('rust', async () => keys(await engine.searchKeyword(Q, { limit: 50, excludePrivate: true })));
    expect(served).toEqual(VISIBLE);
    const titles = await inBrainScope('rust', async () => keys(await engine.searchTitles(Q, { limit: 50, excludePrivate: true })));
    expect(titles).toEqual(VISIBLE);
    for (const [member, call] of EXCLUDE_PRIVATE_CALLS) {
      const got = await inBrainScope('rust', () => refusal(() => call(engine)));
      expect({ member, code: got.code, message: got.message })
        .toMatchObject({ code: 'engine_capability_missing', message: expect.stringContaining('option excludePrivate') });
    }
  });

  // (c) An option the member does not handle, on a brain that holds the pages: the call refuses with the typed code, names the
  // option and changes nothing it could have read.
  test('every member refuses an option it does not handle, naming it, with the pages untouched', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    const engine = rust.engine;
    await seedBrain(engine, 'rust', true);
    const before = keys(await engine.searchKeyword(Q, { limit: 50 }));
    const unhandled: Array<[string, () => Promise<unknown>, string]> = [
      ['searchKeyword', () => engine.searchKeyword(Q, { notAnOption: true } as never), 'notAnOption'],
      ['searchKeyword', () => engine.searchKeyword(Q, { minTrust: 'medium' } as never), 'minTrust'],
      ['searchKeywordChunks', () => engine.searchKeywordChunks(Q, { type: 'note' }), 'type'],
      ['searchKeywordChunks', () => engine.searchKeywordChunks(Q, { notAnOption: true } as never), 'notAnOption'],
      ['countKeywordPages', () => engine.countKeywordPages(Q, { notAnOption: true } as never), 'notAnOption'],
      ['searchKeywordPages', () => engine.searchKeywordPages(Q, { notAnOption: true } as never, WINDOW), 'notAnOption'],
      ['searchTitles', () => engine.searchTitles(Q, { notAnOption: true } as never), 'notAnOption'],
      ['getChunkPage', () => engine.getChunkPage('notes/open', { fromIndex: 0, limit: 5, requireSafeChunks: true }), 'requireSafeChunks'],
      ['getChunkWindows', () => engine.getChunkWindows([{ page_id: 1, from_index: 0, to_index: 1, priority: 0 }], { chunkSources: ['compiled_truth'], maxRows: 10, requireSafeChunks: true } as never), 'requireSafeChunks'],
      ['countChunklessPagesWithContent', () => engine.countChunklessPagesWithContent({ notAnOption: true } as never), 'notAnOption'],
      ['listChunklessPagesWithContent', () => engine.listChunklessPagesWithContent({ notAnOption: true } as never), 'notAnOption'],
    ];
    for (const [member, call, option] of unhandled) {
      const got = await refusal(call);
      expect({ member, option, code: got.code, message: got.message })
        .toMatchObject({ code: 'engine_capability_missing', message: expect.stringContaining(`option ${option}`) });
    }
    expect(keys(await engine.searchKeyword(Q, { limit: 50 }))).toEqual(before);
  });
});

/** A store brain that records any use and throws: a member that refuses before it works never touches it. */
function untouchedBrain(): { brain: never; touched: string[] } {
  const touched: string[] = [];
  const brain = new Proxy({}, {
    get(_target, prop) { touched.push(String(prop)); throw new Error(`the member read ${String(prop)} of the store`); },
  });
  return { brain: brain as never, touched };
}

describe('a member refuses an option it does not handle before it reads the store', () => {
  // No addon and no arm: the store-member functions are called with a brain that throws on any property read, so a refusal that
  // came after a store call would fail here, on every run.
  const CASES: Array<[string, unknown[], string]> = [
    ['searchKeyword', [Q, { notAnOption: true }], 'notAnOption'],
    ['searchKeyword', [Q, { minTrust: 'medium' }], 'minTrust'],
    ['searchKeyword', [Q, { suppressFlagged: true }], 'suppressFlagged'],
    ['searchKeywordChunks', [Q, { type: 'note' }], 'type'],
    ['searchKeywordChunks', [Q, { excludePrivate: true }], 'excludePrivate'],
    ['countKeywordPages', [Q, { excludePrivate: true }], 'excludePrivate'],
    ['countKeywordPages', [Q, { notAnOption: true }], 'notAnOption'],
    ['searchKeywordPages', [Q, { excludePrivate: true }, WINDOW], 'excludePrivate'],
    ['searchKeywordPages', [Q, { notAnOption: true }, WINDOW], 'notAnOption'],
    ['searchTitles', [Q, { notAnOption: true }], 'notAnOption'],
    ['getChunkPage', ['notes/open', { fromIndex: 0, limit: 5, excludePrivate: true }], 'excludePrivate'],
    ['getChunkPage', ['notes/open', { fromIndex: 0, limit: 5, requireSafeChunks: true }], 'requireSafeChunks'],
    ['getChunkWindows', [[{ page_id: 1, from_index: 0, to_index: 1, priority: 0 }], { chunkSources: ['compiled_truth'], maxRows: 10, excludePrivate: true }], 'excludePrivate'],
    ['getChunkWindows', [[{ page_id: 1, from_index: 0, to_index: 1, priority: 0 }], { chunkSources: ['compiled_truth'], maxRows: 10, requireSafeChunks: true }], 'requireSafeChunks'],
    ['countChunklessPagesWithContent', [{ excludePrivate: true }], 'excludePrivate'],
    ['listChunklessPagesWithContent', [{ excludePrivate: true }], 'excludePrivate'],
  ];
  for (const [member, args, option] of CASES) {
    test(`${member} (${option}) refuses with engine_capability_missing and reads nothing`, async () => {
      const { brain, touched } = untouchedBrain();
      const run = (STORE_MEMBERS as unknown as Record<string, (b: never, ...a: unknown[]) => Promise<unknown>>)[member]!;
      const got = await refusal(() => run(brain, ...args));
      expect({ code: got.code, message: got.message }).toMatchObject({ code: 'engine_capability_missing', message: expect.stringContaining(`option ${option}`) });
      expect(touched).toEqual([]);
    });
  }
});
