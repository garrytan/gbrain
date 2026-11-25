/**
 * BrainEngine parity: the alias fan-out reads of engine-sql/alias-fanout-reads.ts (resolveCaseSensitiveAliases,
 * readPageTitle, readPageAliasRows), which search's alias fan-out
 * (src/core/search/alias-fanout.ts) used to run through `engine.executeRaw`, and readEntityAliasRows, the entity
 * card's alias read (verbs/entity-card.ts, entity-card-identity.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same rows in the same order on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): the case-sensitive alias rows, by source, slug, alias; a page's title,
 *    soft-deleted pages included; and a page set's alias rows, by source, slug, alias, origin. Each case asserts the exact answer, so
 *    one arm alone also checks it.
 *  - Regression: an engine that drops the deleted or source filter names the wrong entity for a query; an engine
 *    whose order drifts picks another alias of equal rank; a Rust store that reads a foreign alias row as clean, or invents
 *    alias text, fans out over names the brain never stored. Refusals stay what they were: the caller's
 *    `.catch(() => [])` reads a refused member as no rows, as it read a refused raw statement before.
 *  - Why existing coverage misses it: test/search-alias-fanout.test.ts runs the fan-out on PGLite only and checks what
 *    the search finds, not the rows each read returns or their order.
 *  - The exact-title lookup (findPagesByTitles) carries the page-visibility filter and stays at its call site in this slice.
 *  - Seam: none (typed methods only). The Rust arm holds these members as raw_sql and ends each case on the typed refusal.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
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

describe('engine parity: alias fan-out reads', () => {
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
