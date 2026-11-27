/**
 * BrainEngine parity: the alias fan-out reads of engine-sql/alias-fanout-reads.ts (findPagesByTitles,
 * resolveCaseSensitiveAliases, readPageTitle, readPageAliasRows), which search's alias fan-out
 * (src/core/search/alias-fanout.ts) used to run through `engine.executeRaw`, and readEntityAliasRows, the entity
 * card's alias read (verbs/entity-card.ts, entity-card-identity.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same rows in the same order on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): the live pages of the listed sources and types
 *    whose lower-cased title is asked, by source then slug, less the pages the page policy hides under
 *    `excludePrivate`; the case-sensitive alias rows, by source, slug, alias; a page's title, soft-deleted pages
 *    included; and a page set's alias rows, by source, slug, alias, origin. Each case asserts the exact answer, so
 *    one arm alone also checks it.
 *  - Regression: an engine that drops the deleted, type, source or privacy filter names the wrong entity for a query
 *    (or a private one to an untrusted caller); an engine whose order drifts picks another lead page for a title
 *    group or another alias of equal rank; a Rust store that reads a foreign alias row as clean, or invents
 *    alias text, fans out over names the brain never stored. Refusals stay what they were: the caller's
 *    `.catch(() => [])` reads a refused member as no rows, as it read a refused raw statement before.
 *  - Why existing coverage misses it: test/search-alias-fanout.test.ts runs the fan-out on PGLite only and checks what
 *    the search finds, not the rows each read returns or their order.
 *  - Seam: none for the parity cases (typed methods only). The fallback case drives `resolveQueryEntities` over a
 *    stub engine whose `findPagesByTitles` is the Rust store member over a stub addon, so the refusal it raises is
 *    the one the Rust engine raises.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { withRequestConfigSnapshot } from '../../src/core/config-snapshot.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { resolveQueryEntities } from '../../src/core/search/alias-fanout.ts';
import { STORE_MEMBERS } from '../../src/core/rust-engine/store-members/index.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { createSource, parityArms } from './harness.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const { parityTest } = parityArms(testBackends());

function page(type: string, title: string, frontmatter: Record<string, unknown> = {}): PageInput {
  return { type: type as never, title, compiled_truth: `${title} body`, timeline: '', frontmatter };
}

/**
 * Title fixture, written out of byte order (the later slug and the `other` source first), so a read that leaves the
 * order to the plan answers in write order and fails the exact expectation.
 */
async function titled(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'other');
  await engine.putPage('people/acme-b', page('person', 'Acme Example'), { sourceId: 'other' });
  await engine.putPage('people/acme-b', page('person', 'Acme Example'));
  await engine.putPage('people/acme-a', page('person', 'ACME example'));
  await engine.putPage('people/acme-private', page('person', 'Acme Example', { visibility: 'private' }));
  await engine.putPage('people/acme-readers', page('person', 'Acme example', { readable_by: ['alice-example'] }));
  await engine.putPage('people/acme-gone', page('person', 'Acme Example'));
  await engine.softDeletePage('people/acme-gone');
  await engine.putPage('notes/acme', page('note', 'Acme Example'));
  await engine.putPage('companies/widget-co', page('company', 'Widget Co'));
  await engine.putPage('companies/acme-inc', page('company', 'Acme Example Inc'));
}

const hit = (source_id: string, slug: string, t: string) => ({ slug, source_id, t });

describe('engine parity: alias fan-out reads', () => {
  parityTest(
    'findPagesByTitles matches the lower-cased title of live pages of the listed sources and types, by source then slug',
    { methods: ['putPage', 'softDeletePage', 'findPagesByTitles'] },
    async (engine, backend) => {
      await titled(engine, backend);
      const both = await engine.findPagesByTitles(['acme example', 'widget co'], ['other', 'default'], ['person', 'company']);
      expect(both).toEqual([
        hit('default', 'companies/widget-co', 'widget co'),
        hit('default', 'people/acme-a', 'acme example'),
        hit('default', 'people/acme-b', 'acme example'),
        hit('default', 'people/acme-private', 'acme example'),
        hit('default', 'people/acme-readers', 'acme example'),
        hit('other', 'people/acme-b', 'acme example'),
      ]);
      const other = await engine.findPagesByTitles(['acme example'], ['other'], ['person']);
      const notes = await engine.findPagesByTitles(['acme example'], ['default'], ['note']);
      // An exact title only: neither a prefix nor an unlisted case of the asked text matches.
      const exact = await engine.findPagesByTitles(['acme', 'Acme Example'], ['default'], ['person', 'company']);
      const empty = [
        await engine.findPagesByTitles([], ['default'], ['person']),
        await engine.findPagesByTitles(['acme example'], [], ['person']),
        await engine.findPagesByTitles(['acme example'], ['default'], []),
      ];
      expect(other).toEqual([hit('other', 'people/acme-b', 'acme example')]);
      expect(notes).toEqual([hit('default', 'notes/acme', 'acme example')]);
      expect({ exact, empty }).toEqual({ exact: [], empty: [[], [], []] });
      return { both, other, notes, exact, empty };
    },
  );

  parityTest(
    'findPagesByTitles under excludePrivate drops the pages the page policy hides; without it they come back',
    { methods: ['putPage', 'softDeletePage', 'findPagesByTitles'] },
    async (engine, backend) => {
      await titled(engine, backend);
      const open = await engine.findPagesByTitles(['acme example'], ['default'], ['person'], { excludePrivate: false });
      const hidden = await engine.findPagesByTitles(['acme example'], ['default'], ['person'], { excludePrivate: true });
      expect(open.map((r) => r.slug)).toEqual(['people/acme-a', 'people/acme-b', 'people/acme-private', 'people/acme-readers']);
      expect(hidden.map((r) => r.slug)).toEqual(['people/acme-a', 'people/acme-b']);
      return { open, hidden };
    },
  );

  parityTest(
    'findPagesByTitles under excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'softDeletePage', 'findPagesByTitles'] },
    async (engine, backend) => {
      await titled(engine, backend);
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () =>
        (await engine.findPagesByTitles(['acme example'], ['default'], ['person'], { excludePrivate: true })).map((r) => r.slug));
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const stranger = await read({ identity: ['member:bob-example'], hidePrivate: true });
      expect(member).toEqual(['people/acme-a', 'people/acme-b', 'people/acme-readers']);
      expect(granted).toEqual(['people/acme-a', 'people/acme-b', 'people/acme-private', 'people/acme-readers']);
      expect(stranger).toEqual(['people/acme-a', 'people/acme-b']);
      return { member, granted, stranger };
    },
  );

  parityTest(
    'findPagesByTitles under excludePrivate hides an owner-only source\'s pages, and under the closed form every page while one exists',
    { methods: ['putPage', 'addLink', 'findPagesByTitles'] },
    async (engine, backend) => {
      await engine.putPage('people/acme-open', page('person', 'Acme Example'));
      await engine.putPage('concepts/acme-synthesis', page('concept', 'Acme Example'));
      const read = async (excludePrivate: boolean) => (await engine.findPagesByTitles(['acme example'], ['default', 'chat'], ['person', 'concept'], { excludePrivate }))
        .map((r) => `${r.source_id}:${r.slug}`);
      const before = await read(true);
      // An owner-only source: a page with the same title, and the lineage input of the default-source concept.
      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await engine.putPage('people/acme-chat', page('person', 'Acme Example'), { sourceId: 'chat' });
      await engine.addLink('concepts/acme-synthesis', 'people/acme-chat', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: 'default', toSourceId: 'chat' });
      const unfiltered = await read(false);
      const closed = await read(true);
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const fn = await withEngineScope(engine, () => read(true));
      expect(before).toEqual(['default:concepts/acme-synthesis', 'default:people/acme-open']);
      expect(unfiltered).toEqual(['chat:people/acme-chat', 'default:concepts/acme-synthesis', 'default:people/acme-open']);
      expect(closed).toEqual([]);
      expect(fn).toEqual(['default:people/acme-open']);
      return { before, unfiltered, closed, fn };
    },
  );

  parityTest(
    'resolveCaseSensitiveAliases finds no row for frontmatter aliases, which are never case-sensitive',
    { methods: ['putPage', 'setPageAliases', 'resolveCaseSensitiveAliases'] },
    async (engine) => {
      await engine.putPage('companies/widget-co', page('company', 'Widget Co'));
      await engine.setPageAliases('companies/widget-co', 'default', ['wgco', 'copper fox']);
      const rows = await engine.resolveCaseSensitiveAliases(['wgco', 'copper fox', 'none'], ['default']);
      const empty = [await engine.resolveCaseSensitiveAliases([], ['default']), await engine.resolveCaseSensitiveAliases(['wgco'], [])];
      expect({ rows, empty }).toEqual({ rows: [], empty: [[], []] });
      return { rows, empty };
    },
  );

  parityTest(
    'resolveCaseSensitiveAliases and readPageAliasRows return the derived rows by source, slug, alias, then origin',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'resolveCaseSensitiveAliases', 'readPageAliasRows'] },
    async (engine) => {
      await engine.putPage('companies/widget-co', page('company', 'Widget Co'));
      await engine.putPage('companies/acme-example', page('company', 'Acme Example'));
      await engine.setPageAliases('companies/widget-co', 'default', ['wgco']);
      // Written out of byte order: the later slug first, and `subject` before `declared` for one alias. `aaa` sorts
      // first by alias but last by slug, so neither the write order nor the (source, alias, slug) index order is the
      // (source, slug, alias) answer.
      await engine.replaceDerivedAliases('companies/widget-co', 'default', [
        { alias_norm: 'aaa', origin: 'declared', case_sensitive: true, alias_text: 'AAA' },
        { alias_norm: 'wgco', origin: 'subject', case_sensitive: true, alias_text: 'WGCO' },
        { alias_norm: 'wgco', origin: 'declared', case_sensitive: true, alias_text: 'WGCO' },
        { alias_norm: 'copper fox', origin: 'declared', case_sensitive: false, alias_text: 'Copper Fox' },
      ]);
      await engine.replaceDerivedAliases('companies/acme-example', 'default', [
        { alias_norm: 'wgco', origin: 'declared', case_sensitive: true, alias_text: 'WGCo' },
      ]);
      const caseRows = await engine.resolveCaseSensitiveAliases(['wgco', 'copper fox', 'aaa'], ['default']);
      const aliasRows = await engine.readPageAliasRows(['default'], ['companies/widget-co', 'companies/acme-example']);
      expect(caseRows).toEqual([
        { slug: 'companies/acme-example', alias_norm: 'wgco', alias_text: 'WGCo' },
        { slug: 'companies/widget-co', alias_norm: 'aaa', alias_text: 'AAA' },
        { slug: 'companies/widget-co', alias_norm: 'wgco', alias_text: 'WGCO' },
        { slug: 'companies/widget-co', alias_norm: 'wgco', alias_text: 'WGCO' },
      ]);
      expect(aliasRows.map((r) => `${r.slug}|${r.alias_norm}|${r.origin}|${r.alias_text}`)).toEqual([
        'companies/acme-example|wgco|declared|WGCo',
        'companies/widget-co|aaa|declared|AAA',
        'companies/widget-co|copper fox|declared|Copper Fox',
        'companies/widget-co|wgco|declared|WGCO',
        'companies/widget-co|wgco|frontmatter|null',
        'companies/widget-co|wgco|subject|WGCO',
      ]);
      return { caseRows, aliasRows };
    },
  );

  parityTest(
    'readEntityAliasRows returns every alias row of the listed slugs in one source, by alias',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'readEntityAliasRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      // Written out of alias order, with a same-named page in `other` and an unlisted page in `default`.
      await engine.putPage('people/alice-example', page('person', 'Alice Example'), { sourceId: 'other' });
      await engine.setPageAliases('people/alice-example', 'other', ['foreign']);
      await engine.putPage('people/alice-example', page('person', 'Alice Example'));
      await engine.setPageAliases('people/alice-example', 'default', ['zed', 'alice']);
      await engine.replaceDerivedAliases('people/alice-example', 'default', [
        { alias_norm: 'mike', origin: 'declared', case_sensitive: false, alias_text: 'Mike' },
      ]);
      await engine.putPage('people/al-twin', page('person', 'Al Twin'));
      await engine.setPageAliases('people/al-twin', 'default', ['bravo']);
      await engine.putPage('people/unlisted', page('person', 'Unlisted'));
      await engine.setPageAliases('people/unlisted', 'default', ['able']);
      const both = await engine.readEntityAliasRows('default', ['people/alice-example', 'people/al-twin', 'people/missing']);
      const one = await engine.readEntityAliasRows('default', ['people/alice-example']);
      const other = await engine.readEntityAliasRows('other', ['people/alice-example']);
      const none = await engine.readEntityAliasRows('default', []);
      const row = (r: { slug: string; alias_norm: string; origin: string | null; alias_text: string | null }) => `${r.slug}|${r.alias_norm}|${r.origin}|${r.alias_text}`;
      const result = { both: both.map(row), one: one.map(row), other: other.map(row), none: none.map(row) };
      expect(result).toEqual({
        both: [
          'people/alice-example|alice|frontmatter|null',
          'people/al-twin|bravo|frontmatter|null',
          'people/alice-example|mike|declared|Mike',
          'people/alice-example|zed|frontmatter|null',
        ],
        one: ['people/alice-example|alice|frontmatter|null', 'people/alice-example|mike|declared|Mike', 'people/alice-example|zed|frontmatter|null'],
        other: ['people/alice-example|foreign|frontmatter|null'],
        none: [],
      });
      return result;
    },
  );

  parityTest(
    'readPageTitle reads the title of a live or soft-deleted page in its own source, and null for no page',
    { methods: ['putPage', 'softDeletePage', 'readPageTitle'] },
    async (engine, backend) => {
      await titled(engine, backend);
      const titles = {
        live: await engine.readPageTitle('default', 'people/acme-a'),
        other: await engine.readPageTitle('other', 'people/acme-b'),
        deleted: await engine.readPageTitle('default', 'people/acme-gone'),
        missing: await engine.readPageTitle('default', 'people/none'),
        wrongSource: await engine.readPageTitle('other', 'people/acme-a'),
        noSource: await engine.readPageTitle('nowhere', 'people/acme-a'),
      };
      expect(titles).toEqual({ live: 'ACME example', other: 'Acme Example', deleted: 'Acme Example', missing: null, wrongSource: null, noSource: null });
      return titles;
    },
  );

  parityTest(
    'readPageAliasRows returns the frontmatter rows of the listed slugs in the listed sources, by source, slug, then alias',
    { methods: ['putPage', 'setPageAliases', 'readPageAliasRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      // Written out of byte order: the `other` source and the later slug first.
      await engine.putPage('people/b', page('person', 'B'), { sourceId: 'other' });
      await engine.setPageAliases('people/b', 'other', ['zed', 'bee']);
      await engine.putPage('people/b', page('person', 'B'));
      await engine.setPageAliases('people/b', 'default', ['zed', 'bee']);
      await engine.putPage('people/a', page('person', 'A'));
      await engine.setPageAliases('people/a', 'default', ['ay', 'a.']);
      await engine.putPage('people/unlisted', page('person', 'U'));
      await engine.setPageAliases('people/unlisted', 'default', ['you']);
      const rows = await engine.readPageAliasRows(['other', 'default'], ['people/b', 'people/a', 'people/none', 'people/b']);
      const defaultOnly = await engine.readPageAliasRows(['default'], ['people/b']);
      const empty = [await engine.readPageAliasRows([], ['people/a']), await engine.readPageAliasRows(['default'], [])];
      const row = (source_id: string, slug: string, alias_norm: string) => ({ slug, source_id, alias_norm, alias_text: null, origin: 'frontmatter' });
      expect(rows).toEqual([
        row('default', 'people/a', 'a.'),
        row('default', 'people/a', 'ay'),
        row('default', 'people/b', 'bee'),
        row('default', 'people/b', 'zed'),
        row('other', 'people/b', 'bee'),
        row('other', 'people/b', 'zed'),
      ]);
      expect({ defaultOnly, empty }).toEqual({ defaultOnly: [row('default', 'people/b', 'bee'), row('default', 'people/b', 'zed')], empty: [[], []] });
      return { rows, defaultOnly, empty };
    },
  );
});

/**
 * Derived fixture: one frontmatter row and three derived rows on one page (one case-sensitive alias under two origins,
 * one not case-sensitive), a case-sensitive row on a second page, and one in the `other` source. A store read that
 * ignores the value of a derived row reads `alias_text` as null, finds no case-sensitive row, or refuses the row.
 */
async function derived(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'other');
  await engine.putPage('people/alice-example', page('person', 'Alice Example'));
  await engine.setPageAliases('people/alice-example', 'default', ['ae']);
  await engine.replaceDerivedAliases('people/alice-example', 'default', [
    { alias_norm: 'ae', origin: 'subject', case_sensitive: true, alias_text: 'AE' },
    { alias_norm: 'ae', origin: 'declared', case_sensitive: true, alias_text: 'AE' },
    { alias_norm: 'alice', origin: 'declared', case_sensitive: false, alias_text: 'Alice' },
  ]);
  await engine.replaceDerivedAliases('people/a-founder', 'default', [
    { alias_norm: 'ae', origin: 'declared', case_sensitive: true, alias_text: 'aE' },
  ]);
  await engine.replaceDerivedAliases('people/alice-example', 'other', [
    { alias_norm: 'ae', origin: 'declared', case_sensitive: true, alias_text: 'A.E.' },
  ]);
}

describe('engine parity: alias fan-out reads of derived alias rows', () => {
  parityTest(
    'resolveCaseSensitiveAliases returns the case-sensitive rows replaceDerivedAliases wrote, with their alias text',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'resolveCaseSensitiveAliases'] },
    async (engine, backend) => {
      await derived(engine, backend);
      const both = await engine.resolveCaseSensitiveAliases(['alice', 'ae'], ['other', 'default']);
      expect(both).toEqual([
        { slug: 'people/a-founder', alias_norm: 'ae', alias_text: 'aE' },
        // By slug, alias, then alias text in byte order (master's R2 contract: the rows carry no source).
        { slug: 'people/alice-example', alias_norm: 'ae', alias_text: 'A.E.' },
        { slug: 'people/alice-example', alias_norm: 'ae', alias_text: 'AE' },
        { slug: 'people/alice-example', alias_norm: 'ae', alias_text: 'AE' },
      ]);
      // Not case-sensitive: the derived `alice` row and the frontmatter `ae` row never answer.
      const notCase = await engine.resolveCaseSensitiveAliases(['alice'], ['default']);
      // A new set replaces the derived rows: `ae` turns case-insensitive and leaves the answer.
      await engine.replaceDerivedAliases('people/a-founder', 'default', [
        { alias_norm: 'ae', origin: 'declared', case_sensitive: false, alias_text: 'aE' },
      ]);
      const replaced = await engine.resolveCaseSensitiveAliases(['ae'], ['default']);
      expect({ notCase, replaced }).toEqual({
        notCase: [],
        replaced: [
          { slug: 'people/alice-example', alias_norm: 'ae', alias_text: 'AE' },
          { slug: 'people/alice-example', alias_norm: 'ae', alias_text: 'AE' },
        ],
      });
      return { both, notCase, replaced };
    },
  );

  parityTest(
    'readPageAliasRows returns the alias text replaceDerivedAliases wrote, and null for a frontmatter row',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'readPageAliasRows'] },
    async (engine, backend) => {
      await derived(engine, backend);
      const rows = await engine.readPageAliasRows(['other', 'default'], ['people/alice-example', 'people/a-founder']);
      const row = (source_id: string, slug: string, alias_norm: string, origin: string, alias_text: string | null) =>
        ({ slug, source_id, alias_norm, alias_text, origin });
      expect(rows).toEqual([
        row('default', 'people/a-founder', 'ae', 'declared', 'aE'),
        row('default', 'people/alice-example', 'ae', 'declared', 'AE'),
        row('default', 'people/alice-example', 'ae', 'frontmatter', null),
        row('default', 'people/alice-example', 'ae', 'subject', 'AE'),
        row('default', 'people/alice-example', 'alice', 'declared', 'Alice'),
        row('other', 'people/alice-example', 'ae', 'declared', 'A.E.'),
      ]);
      // Replacing the derived rows with none leaves the frontmatter row.
      await engine.replaceDerivedAliases('people/alice-example', 'default', []);
      const cleared = await engine.readPageAliasRows(['default'], ['people/alice-example']);
      expect(cleared).toEqual([row('default', 'people/alice-example', 'ae', 'frontmatter', null)]);
      return { rows, cleared };
    },
  );
});

describe('alias fan-out: a refused Rust read reads as no rows', () => {
  test('resolveQueryEntities answers the same when the Rust findPagesByTitles refuses a widened caller as when it finds nothing', async () => {
    const addonCalls: string[] = [];
    // The addon half of the Rust engine: any call reaching it is recorded, and finds nothing.
    const brain = new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => { addonCalls.push(String(prop)); void args; return Promise.resolve([]); } });
    const refusals: unknown[] = [];
    const stub = (titles: BrainEngine['findPagesByTitles']) => ({
      kind: 'pglite',
      resolveAliases: async () => new Map([['acme example', [{ slug: 'companies/acme-example', source_id: 'default' }]]]),
      findPagesByTitles: titles,
      resolveCaseSensitiveAliases: async () => [],
      getAllConfig: async () => ({}),
      getConfig: async () => null,
      getConfigValues: async () => [],
    }) as unknown as BrainEngine;
    const viaStore: BrainEngine['findPagesByTitles'] = (...args) =>
      (STORE_MEMBERS.findPagesByTitles as (b: unknown, ...a: unknown[]) => Promise<never>)(brain, ...args)
        .catch((e: unknown) => { refusals.push(e); throw e; });
    // A member's lineage read is served now (row 32e-b-2); a labelled-only member speaking for an audience of several identities
    // still widens the page policy past what the store reads, so the store member refuses typed.
    const widened = <T>(fn: () => Promise<T>) => withCallerAccess({
      identity: ['member:alice-example'], hidePrivate: true, labelledOnly: true,
      audienceIdentities: [['member:alice-example'], ['member:bob-example']],
    }, fn);
    const run = (engine: BrainEngine) => widened(() => withRequestConfigSnapshot(engine,
      () => resolveQueryEntities(engine, 'Acme Example renewal', { sourceId: 'default', excludePrivate: true })));

    const refused = await run(stub(viaStore));
    const nothing = await run(stub(async () => []));
    expect(refusals.map((e) => (e as { code?: string }).code)).toEqual(['engine_capability_missing']);
    expect(addonCalls).toEqual([]);
    expect(refused).toEqual(nothing);
    expect(refused.map((f) => f.pages)).toEqual([[{ slug: 'companies/acme-example', source_id: 'default' }]]);
  });
});
