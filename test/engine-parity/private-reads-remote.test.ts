/**
 * BrainEngine parity — the reads a remote request makes under `excludePrivate`, for each kind of caller record.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: under `excludePrivate`, searchVector applies the page policy of the caller in context
 *    (`privatePagesFilterForCaller('p')`, src/core/search/private-visibility.ts): with no record, inside an empty
 *    record, for a remote caller with no member, with a member identity, with a private-readable grant, and for a local
 *    and a remote owner. Every engine arm returns the same rows (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: the Rust engine compared a caller's policy text only with the no-record form, so every search made
 *    inside a caller record (every remote MCP or HTTP read) stopped with engine_capability_missing.
 *  - Why existing coverage misses it: vector-options.test.ts and private-page-reads.test.ts read with no caller record.
 *  - Seam: none. Real engines, typed methods only. The caller records are set with withCallerAccess, as the remote
 *    request scope sets them.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { parityArms, sorted } from './harness.ts';
import type { Page } from '../../src/core/types.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const AXIS = 100;

/** A unit vector with `cos` on the query axis and the rest on the page's own axis. */
function vectorAt(cos: number, own: number): Float32Array {
  const e = new Float32Array(1536);
  e[AXIS] = cos;
  e[own] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return e;
}

/** One page per rule; the hidden ones rank first, so a filter applied after the limit would show. */
const PAGES: Array<[slug: string, frontmatter: Record<string, unknown>]> = [
  ['notes/private', { visibility: 'private' }],
  ['notes/readers', { readable_by: ['alice-example'] }],
  ['notes/open', {}],
  ['notes/also-open', {}],
];

async function fixture(engine: BrainEngine): Promise<void> {
  for (const [i, [slug, frontmatter]] of PAGES.entries()) {
    await seedPage(engine, {
      slug,
      input: { type: 'note', title: slug, compiled_truth: `zephyr notes about ${slug}.`, timeline: '', frontmatter },
      chunks: [chunk(0, `zephyr notes about ${slug}.`, { embedding: vectorAt(0.95 - i * 0.05, 200 + i) })],
    });
  }
}

const REMOTE = { hidePrivate: true, restricted: true, applyRemoteReadPolicy: true };

/** The caller records a request carries: none (local CLI), empty, and the remote and owner records. */
export const CALLERS: Array<[name: string, record: Record<string, unknown> | null]> = [
  ['none', null],
  ['empty', {}],
  ['remoteNoMember', { ...REMOTE }],
  ['remoteMember', { ...REMOTE, identity: ['member:alice-example'] }],
  ['remoteGrant', { ...REMOTE, identity: ['member:alice-example'], privateReadableSources: ['default'] }],
  ['localOwner', { owner: true, hidePrivate: false, restricted: false }],
  ['remoteOwner', { ...REMOTE, identity: ['member:owner-example'], owner: true, ownerReads: true }],
];

export async function eachCaller<T>(read: () => Promise<T>): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const [name, record] of CALLERS) out[name] = await (record ? withCallerAccess(record as never, read) : read());
  return out;
}

const slugs = (rows: SearchResult[]) => sorted(rows.map((r) => r.slug));

describe('engine parity: searchVector under excludePrivate for every caller record', () => {
  parityTest('searchVector applies the caller\'s page policy with no record, inside an empty record, and for remote, member, grant and owner callers',
    { methods: ['putPage', 'sealChunks', 'searchVector'] }, async (engine) => {
      await fixture(engine);
      const out = await eachCaller(async () => slugs(await engine.searchVector(vectorAt(1, 999), { limit: 2, excludePrivate: true })));
      // Not vacuous: a plain caller sees only the open pages; the member also sees its readers page; the grant and
      // the local owner see the private page.
      expect(out.none).toEqual(['notes/also-open', 'notes/open']);
      expect(out.remoteMember).toEqual(['notes/open', 'notes/readers']);
      expect(out.remoteGrant).toEqual(['notes/private', 'notes/readers']);
      expect(out.localOwner).toEqual(['notes/open', 'notes/private']);
      return out;
    });
});

/** The open hub every page links to and is linked from, so getLinks and getBacklinks see each policy decision. */
async function graph(engine: BrainEngine): Promise<void> {
  await seedPage(engine, { slug: 'notes/hub', input: { type: 'note', title: 'hub', compiled_truth: 'zephyr hub.', timeline: '' }, chunks: [chunk(0, 'zephyr hub.')] });
  for (const [i, [slug]] of PAGES.entries()) {
    await engine.addLink('notes/hub', slug, '', 'mentions', 'manual');
    await engine.addLink(slug, 'notes/hub', '', 'mentions', 'manual');
    await engine.addTag(slug, 'probe');
    await engine.addTimelineEntry(slug, { date: `2026-01-0${i + 1}`, summary: `zephyr event on ${slug}` });
  }
}

/** One take per page, each with a vector, so the take searches see each policy decision. */
async function takes(engine: BrainEngine): Promise<void> {
  for (const [i, [slug]] of PAGES.entries()) {
    const page = (await engine.getPage(slug))!;
    await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: `zephyr claim on ${slug}`, kind: 'take', holder: 'world' }]);
    const [take] = await engine.listTakes({ page_id: page.id } as never);
    await engine.updateTakeEmbeddings([{ take_id: take!.id, embedding: vectorAt(0.95 - i * 0.05, 300 + i), claim: `zephyr claim on ${slug}`, model: 'embed-m1' }]);
  }
}

const pageSlugs = (rows: Page[]) => sorted(rows.map((r) => r.slug));

describe('engine parity: the remote search and page reads under excludePrivate for every caller record', () => {
  parityTest('searchKeyword, searchTitles, getPage and listPages apply the caller\'s page policy for every record, owners included',
    { methods: ['putPage', 'sealChunks', 'searchKeyword', 'searchTitles', 'getPage', 'listPages'] }, async (engine) => {
      await fixture(engine);
      const out = await eachCaller(async () => ({
        keyword: slugs(await engine.searchKeyword('zephyr', { limit: 20, excludePrivate: true })),
        titles: slugs(await engine.searchTitles('notes', { limit: 20, excludePrivate: true })),
        page: Object.fromEntries(await Promise.all(PAGES.map(async ([slug]) => [slug, (await engine.getPage(slug, { excludePrivate: true }))?.slug ?? null]))),
        list: pageSlugs(await engine.listPages({ limit: 20, excludePrivate: true })),
      }));
      expect(out.none!.list).toEqual(['notes/also-open', 'notes/open']);
      expect(out.localOwner!.list).toEqual(['notes/also-open', 'notes/open', 'notes/private']);
      expect(out.remoteOwner!.keyword).toEqual(out.remoteOwner!.list);
      return out;
    });

  parityTest('the other page, link, tag, timeline, keyword and take reads apply the caller\'s page policy for every record, owners included',
    { methods: ['putPage', 'sealChunks', 'addLink', 'addTag', 'addTimelineEntry', 'findPages', 'resolveSlugs', 'getLinks', 'getBacklinks',
      'getTags', 'getTimeline', 'searchKeywordChunks', 'countKeywordPages', 'addTakesBatch', 'listTakes', 'updateTakeEmbeddings', 'searchTakes'] }, async (engine) => {
      await fixture(engine);
      await graph(engine);
      await takes(engine);
      const each = async <T>(read: (slug: string) => Promise<T>) => Object.fromEntries(await Promise.all(PAGES.map(async ([slug]) => [slug, await read(slug)])));
      const out = await eachCaller(async () => ({
        find: sorted((await engine.findPages({ pattern: { kind: 'prefix', like: 'notes/%', lead: 'notes/' } as never, limit: 20, excludeSlugPrefixes: [],
          untrusted: { excludePrivate: true } as never })).rows.map(p => p.slug)),
        resolve: sorted(await engine.resolveSlugs('notes', { excludePrivate: true })),
        links: sorted((await engine.getLinks('notes/hub', { excludePrivate: true })).map(l => l.to_slug)),
        backlinks: sorted((await engine.getBacklinks('notes/hub', { excludePrivate: true })).map(l => l.from_slug)),
        tags: await each(async (slug) => await engine.getTags(slug, { excludePrivate: true })),
        timeline: await each(async (slug) => (await engine.getTimeline(slug, { excludePrivate: true })).map(t => t.summary)),
        chunks: slugs(await engine.searchKeywordChunks('zephyr', { limit: 20, excludePrivate: true })),
        count: await engine.countKeywordPages('zephyr', { excludePrivate: true }),
        takes: sorted((await engine.searchTakes('zephyr', { limit: 20, excludePrivate: true })).map(t => t.page_slug)),
      }));
      expect(out.none!.links).toEqual(['notes/also-open', 'notes/open']);
      expect(out.localOwner!.backlinks).toEqual(['notes/also-open', 'notes/open', 'notes/private']);
      return out;
    });
});

describe('engine parity: the reads the Rust engine did not take excludePrivate on, for every caller record', () => {
  parityTest('resolveSlugWithAlias, getChunks and searchTakesVector apply the caller\'s page policy for every record, owners included',
    { methods: ['putPage', 'sealChunks', 'updateSlug', 'addTakesBatch', 'listTakes', 'updateTakeEmbeddings', 'resolveSlugWithAlias', 'getChunks', 'searchTakesVector'] }, async (engine) => {
      await fixture(engine);
      await takes(engine);
      // A renamed page per rule: its old slug is an alias row whose canonical page is the policy's to judge.
      for (const [slug, frontmatter] of PAGES) {
        const old = slug.replace('notes/', 'renamed/');
        await engine.putPage(`${old}-old`, { type: 'note', title: old, compiled_truth: `about ${old}.`, timeline: '', frontmatter });
        await engine.updateSlug(`${old}-old`, old);
      }
      const each = async <T>(read: (slug: string) => Promise<T>) => Object.fromEntries(await Promise.all(PAGES.map(async ([slug]) => [slug, await read(slug)])));
      const out = await eachCaller(async () => ({
        alias: await each(async (slug) => await engine.resolveSlugWithAlias(`${slug.replace('notes/', 'renamed/')}-old`, 'default', { excludePrivate: true })),
        chunks: await each(async (slug) => (await engine.getChunks(slug, { excludePrivate: true })).map(c => c.chunk_text)),
        takeVector: (await engine.searchTakesVector(vectorAt(1, 999), { limit: 2, excludePrivate: true })).map(t => t.page_slug),
      }));
      expect(out.none!.chunks['notes/private']).toEqual([]);
      expect(out.none!.alias['notes/private']).toBe('renamed/private-old');
      expect(out.localOwner!.alias['notes/private']).toBe('renamed/private');
      expect(out.localOwner!.chunks['notes/private']).toEqual(['zephyr notes about notes/private.']);
      return out;
    });
});

describe('engine parity: listFactsByEntity under excludePrivate for every caller record', () => {
  parityTest('listFactsByEntity applies the caller\'s fact policy for every record, owners included',
    { methods: ['putPage', 'sealChunks', 'insertFacts', 'listFactsByEntity'] }, async (engine) => {
      await fixture(engine);
      const rows = PAGES.map(([slug], i) => ({
        fact: `fact from ${slug}`, entity_slug: 'notes/open', source_markdown_slug: slug, row_num: i + 1, kind: 'fact' as const,
        visibility: 'world' as const, source: 'fence', source_session: 'sess-remote', valid_from: new Date('2026-03-01T00:00:00Z'),
      }));
      await engine.insertFacts(rows as never, { source_id: 'default' });
      const out = await eachCaller(async () => sorted((await engine.listFactsByEntity('default', 'notes/open', { limit: 50, excludePrivate: true })).map(f => f.fact)));
      expect(out.none).toEqual(['fact from notes/also-open', 'fact from notes/open']);
      expect(out.localOwner).toContain('fact from notes/private');
      return out;
    });
});
