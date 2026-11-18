/**
 * BrainEngine parity: the alias fan-out reads of engine-sql/alias-fanout-reads.ts (findPagesByTitles,
 * resolveCaseSensitiveAliases, readPageTitle, readPageAliasRows), which search's alias fan-out
 * (src/core/search/alias-fanout.ts) used to run through `engine.executeRaw`.
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
    'findPagesByTitles under excludePrivate for a caller with a reader identity: SQL arms apply the caller policy, the Rust store refuses',
    { methods: ['putPage', 'softDeletePage', 'findPagesByTitles'] },
    async (engine, backend) => {
      await titled(engine, backend);
      const rows = await withCallerAccess({ identity: ['alice-example'], hidePrivate: true },
        () => engine.findPagesByTitles(['acme example'], ['default'], ['person'], { excludePrivate: true }));
      expect(rows.map((r) => r.slug)).toContain('people/acme-a');
      expect(rows.map((r) => r.slug)).not.toContain('people/acme-private');
      return rows;
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
    const widened = <T>(fn: () => Promise<T>) => withCallerAccess({ identity: ['alice-example'], hidePrivate: true }, fn);
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
