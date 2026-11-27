/**
 * BrainEngine parity — the entity resolver's page reads (entities/resolve.ts) that ran through executeRaw and are now
 * typed members of engine-sql/entity-reads.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each resolver read returns the same pages on every engine arm: live pages only, the retired-page and
 *    private-page filters where the resolver applied them, and the same caps.
 *  - Regression: an engine that answers a deleted page, a page of another source, or a slug listed twice twice, or that
 *    drops the cap, changes which page an entity mention resolves to (or makes a lone match look ambiguous).
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines, and a Rust brain refused them with `raw_sql`.
 *  - Seam: none. Typed methods only (no executeRaw: D18). Rows with no defined order are sorted; a capped read with
 *    more matches than its cap is compared by count.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

type PageInput = Parameters<BrainEngine['putPage']>[1];
const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}): PageInput =>
  ({ type, title, compiled_truth: `${title} body.`, frontmatter }) as PageInput;

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'other');
  const pages: Array<[string, PageInput, string?]> = [
    ['companies/acme', page('company', 'Acme')],
    ['orgs/acme', page('company', 'Acme Org')],
    ['organizations/acme', page('company', 'Acme Organization', { merged_into: 'companies/acme' })],
    ['people/alice-example', page('person', 'Alice Example')],
    ['companies/alice-example', page('company', 'Alice Example Co')],
    ['hosts/alice-example', page('person', 'Alice Example Host')],
    ['people/gone', page('person', 'Gone')],
    ['orgs/widget', page('company', 'Widget'), 'other'],
  ];
  for (const [slug, input, sourceId] of pages) await engine.putPage(slug, input, { sourceId: sourceId ?? 'default' });
  await engine.softDeletePage('people/gone', { sourceId: 'default' });
}

describe('engine parity: entity resolver reads', () => {
  parityTest('readLiveSlugs names the live pages among the slugs, retired or not, once each; limit 2 caps it',
    { methods: ['readLiveSlugs'] }, async (engine, backend) => {
      await seed(engine, backend);
      const all = ['companies/acme', 'orgs/acme', 'organizations/acme', 'people/gone', 'orgs/widget', 'people/missing', 'companies/acme'];
      const result = {
        all: sorted(await engine.readLiveSlugs('default', all)),
        other: await engine.readLiveSlugs('other', ['orgs/widget', 'companies/acme']),
        none: await engine.readLiveSlugs('default', ['people/gone', 'people/missing']),
        empty: await engine.readLiveSlugs('default', []),
        // Three live matches under a cap of two: which two is not set, so only the count is compared.
        capped: (await engine.readLiveSlugs('default', ['people/alice-example', 'companies/alice-example', 'hosts/alice-example'], { limit: 2 })).length,
        cappedOne: await engine.readLiveSlugs('default', ['people/alice-example', 'people/gone', 'people/alice-example'], { limit: 2 }),
      };
      expect(result).toEqual({
        all: ['companies/acme', 'organizations/acme', 'orgs/acme'],
        other: ['orgs/widget'],
        none: [],
        empty: [],
        capped: 2,
        cappedOne: ['people/alice-example'],
      });
      return result;
    });

  parityTest('readLivePageTypes reads the live pages among the slugs with their types under the resolver privacy',
    { methods: ['readLivePageTypes'] }, async (engine, backend) => {
      await seed(engine, backend);
      await engine.putPage('people/hidden-example', page('person', 'Hidden Example', { visibility: 'private' }), { sourceId: 'default' });
      await engine.putPage('people/readers-example', page('person', 'Readers Example', { readable_by: ['bob-example'] }), { sourceId: 'default' });
      const slugs = ['companies/acme', 'organizations/acme', 'people/gone', 'orgs/widget', 'people/hidden-example', 'people/readers-example', 'people/missing'];
      const read = async (privacy: 'none' | 'caller' | 'floor') => sorted(await engine.readLivePageTypes('default', slugs, privacy), r => r.slug);
      const result = {
        none: await read('none'),
        caller: await read('caller'),
        floor: await read('floor'),
        other: await engine.readLivePageTypes('other', ['orgs/widget'], 'none'),
        // The read floor under a caller is its own case: the store refuses it typed (retirementHopPolicy).
        bob: await withCallerAccess({ identity: ['member:bob-example'], hidePrivate: true }, () => read('caller')),
        granted: await withCallerAccess({ identity: ['member:carol-example'], privateReadableSources: ['default'], hidePrivate: true }, () => read('caller')),
      };
      const acme = [{ slug: 'companies/acme', type: 'company' }, { slug: 'organizations/acme', type: 'company' }];
      expect(result.none).toEqual([...acme, { slug: 'people/hidden-example', type: 'person' }, { slug: 'people/readers-example', type: 'person' }]);
      expect(result.caller.map(r => r.slug)).not.toContain('people/hidden-example');
      expect(result.floor.map(r => r.slug)).not.toContain('people/hidden-example');
      expect(result.other).toEqual([{ slug: 'orgs/widget', type: 'company' }]);
      expect(result.bob.map(r => r.slug)).toContain('people/readers-example');
      expect(result.granted.map(r => r.slug)).toContain('people/hidden-example');
      return result;
    });

  parityTest('readTrigramCandidates ranks live, non-retired pages by title or slug similarity under each resolver arm',
    { methods: ['readTrigramCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const more: Array<[string, PageInput]> = [
        ['people/alicia-example', page('person', 'Alicia Example')],
        ['people/alice-examples', page('person', 'Alice Examples', { canonical: false })],
        ['meetings/alice-example-sync', page('meeting', 'Alice Example sync')],
        ['people/hidden-alice-example', page('person', 'Alice Example', { visibility: 'private' })],
        ['people/bob-other', page('person', 'Bob Other')],
        ['people/pct_example', page('person', 'Zed')],
      ];
      for (const [slug, input] of more) await engine.putPage(slug, input, { sourceId: 'default' });
      const read = (arm: 'same_name' | 'near', privacy: 'none' | 'caller' | 'floor', titleLc: string, slugFragment: string) =>
        engine.readTrigramCandidates('default', { arm, titleLc, slugFragment, privacy });
      const result = {
        sameName: await read('same_name', 'none', 'alice example', 'alice-example'),
        sameNameCaller: await read('same_name', 'caller', 'alice example', 'alice-example'),
        near: await read('near', 'none', 'alice example', 'alice-example'),
        nearFloor: await read('near', 'floor', 'alice example', 'alice-example'),
        // `_` in the fragment is a LIKE wildcard.
        wildcard: await read('near', 'none', 'nobody', 'pct_'),
        other: await read('near', 'none', 'widget', 'widget'),
        fuzzy: await engine.readTrigramCandidates('default', { arm: 'fuzzy', titleLc: 'alice example', slugFragment: 'alice-example' }),
        none: await engine.readTrigramCandidates('default', { arm: 'fuzzy', titleLc: 'qqqq', slugFragment: 'qqqq' }),
      };
      expect(result.sameName.length).toBe(5);
      expect(result.sameName[0]).toEqual({ slug: 'people/alice-example', title: 'Alice Example', type: 'person' });
      expect(result.sameName.map(r => r.slug)).not.toContain('people/alice-examples');
      expect(result.sameNameCaller.map(r => r.slug)).not.toContain('people/hidden-alice-example');
      expect(result.near.map(r => r.slug)).toContain('people/hidden-alice-example');
      expect(result.nearFloor.map(r => r.slug)).not.toContain('people/hidden-alice-example');
      expect(result.wildcard.map(r => r.slug)).toEqual(['people/pct_example']);
      expect(result.other).toEqual([]);
      expect(result.fuzzy[0]).toMatchObject({ slug: 'people/alice-example', score: 1 });
      expect(result.none).toEqual([]);
      return result;
    });

  parityTest('readPrefixCandidates ranks live, non-retired prefix pages by inbound, outbound ranking links and chunks',
    { methods: ['readPrefixCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const pages: Array<[string, PageInput]> = [
        ['people/alice', page('person', 'Alice')],
        ['people/alice-other', page('person', 'Alice Other')],
        ['people/alice-retired', page('person', 'Alice Retired', { canonical: 'no' })],
        ['people/aliceberg', page('person', 'Aliceberg')],
        ['people/alice_x', page('person', 'Alice X')],
        ['companies/alice-co', page('company', 'Alice Co')],
      ];
      for (const [slug, input] of pages) await engine.putPage(slug, input, { sourceId: 'default' });
      // people/alice-other: 1 inbound + 1 outbound ranking link + 2 chunks = 4; an amends link counts for nothing.
      await engine.addLink('people/alice-example', 'people/alice-other', '', 'mentions');
      await engine.addLink('people/alice-other', 'companies/acme', '', 'works_at');
      await engine.addLink('companies/acme', 'people/alice-other', '', 'amends');
      await engine.upsertChunks('people/alice-other', [
        { chunk_index: 0, chunk_text: 'Alice Other body.', chunk_source: 'compiled_truth' },
        { chunk_index: 1, chunk_text: 'More of Alice Other.', chunk_source: 'compiled_truth' },
      ], { sourceId: 'default' });
      // companies/alice-co: one chunk; people/alice-example: one outbound link.
      await engine.upsertChunks('companies/alice-co', [{ chunk_index: 0, chunk_text: 'Alice Co body.', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
      const patterns = ['people', 'companies', 'hosts', 'projects'].flatMap(dir => [`${dir}/alice`, `${dir}/alice-%`]);
      const result = {
        any: await engine.readPrefixCandidates('default', { patterns }),
        dir: await engine.readPrefixCandidates('default', { pattern: 'people/alice-%' }),
        // `_` stays a LIKE wildcard: it matches the hyphen of people/alice-other.
        wildcard: await engine.readPrefixCandidates('default', { pattern: 'people/alice_other' }),
        other: await engine.readPrefixCandidates('other', { pattern: 'orgs/%' }),
      };
      expect(result).toEqual({
        any: [
          { slug: 'people/alice-other', connection_count: 4 },
          { slug: 'companies/alice-co', connection_count: 1 },
          { slug: 'people/alice-example', connection_count: 1 },
          { slug: 'companies/alice-example', connection_count: 0 },
          { slug: 'hosts/alice-example', connection_count: 0 },
          { slug: 'people/alice', connection_count: 0 },
        ],
        dir: [
          { slug: 'people/alice-other', connection_count: 4 },
          { slug: 'people/alice-example', connection_count: 1 },
        ],
        wildcard: [{ slug: 'people/alice-other', connection_count: 4 }],
        other: [{ slug: 'orgs/widget', connection_count: 0 }],
      });
    });

  parityTest('readPrefixDirs names the entity directories of the live, non-retired prefix pages, at most two',
    { methods: ['readPrefixDirs'] }, async (engine, backend) => {
      await seed(engine, backend);
      await engine.putPage('projects/alice-retired', page('project', 'Alice Retired', { superseded_by: 'people/alice-example' }), { sourceId: 'default' });
      const dirs = (patterns: string[]) => engine.readPrefixDirs('default', patterns);
      const result = {
        one: await dirs(['people/alice', 'people/alice-%']),
        // people, companies and hosts all match; which two come back is not set, so only the count is compared.
        capped: (await dirs(['people/alice-%', 'companies/alice-%', 'hosts/alice-%'])).length,
        retired: await dirs(['projects/alice-%']),
        deleted: await dirs(['people/gone']),
        other: await engine.readPrefixDirs('other', ['orgs/%']),
      };
      expect(result).toEqual({ one: ['people'], capped: 2, retired: [], deleted: [], other: ['orgs'] });
    });

  parityTest('readPrefixTitleMatches reads the live, non-retired prefix pages whose title is the name, ignoring case',
    { methods: ['readPrefixTitleMatches'] }, async (engine, backend) => {
      await seed(engine, backend);
      const extra: Array<[string, PageInput]> = [
        ['companies/acme-0', page('company', 'ACME')],
        ['companies/acme-labs-50', page('company', 'Acme Labs')],
        ['companies/acme-old', page('company', 'Acme', { status: 'redirect' })],
      ];
      for (const [slug, input] of extra) await engine.putPage(slug, input, { sourceId: 'default' });
      const patterns = ['companies/acme', 'companies/acme-%'];
      const result = {
        named: sorted(await engine.readPrefixTitleMatches('default', patterns, 'acme'), r => r.slug),
        none: await engine.readPrefixTitleMatches('default', patterns, 'Widget'),
        other: await engine.readPrefixTitleMatches('other', ['orgs/%'], 'WIDGET'),
      };
      expect(result).toEqual({
        named: [{ slug: 'companies/acme', title: 'Acme' }, { slug: 'companies/acme-0', title: 'ACME' }],
        none: [],
        other: [{ slug: 'orgs/widget', title: 'Widget' }],
      });
    });

  parityTest('readNamedEntitySlugs names the live, non-retired pages among the slugs under the resolver privacy, by slug, at most five',
    { methods: ['readNamedEntitySlugs'] }, async (engine, backend) => {
      await seed(engine, backend);
      await engine.putPage('people/hidden-example', page('person', 'Hidden Example', { visibility: 'private' }), { sourceId: 'default' });
      for (const n of [1, 2, 3, 4, 5, 6]) await engine.putPage(`people/many-${n}`, page('person', `Many ${n}`), { sourceId: 'default' });
      const slugs = ['orgs/acme', 'companies/acme', 'organizations/acme', 'people/gone', 'orgs/widget', 'people/hidden-example', 'people/missing', 'companies/acme'];
      const many = ['people/many-6', 'people/many-2', 'people/many-4', 'people/many-1', 'people/many-5', 'people/many-3'];
      const result = {
        none: await engine.readNamedEntitySlugs('default', slugs, 'none'),
        caller: await engine.readNamedEntitySlugs('default', slugs, 'caller'),
        floor: await engine.readNamedEntitySlugs('default', slugs, 'floor'),
        other: await engine.readNamedEntitySlugs('other', ['orgs/widget', 'companies/acme'], 'none'),
        capped: await engine.readNamedEntitySlugs('default', many, 'none'),
        empty: await engine.readNamedEntitySlugs('default', [], 'none'),
      };
      expect(result).toEqual({
        none: ['companies/acme', 'orgs/acme', 'people/hidden-example'],
        caller: ['companies/acme', 'orgs/acme'],
        floor: ['companies/acme', 'orgs/acme'],
        other: ['orgs/widget'],
        capped: ['people/many-1', 'people/many-2', 'people/many-3', 'people/many-4', 'people/many-5'],
        empty: [],
      });
      return result;
    });
});
