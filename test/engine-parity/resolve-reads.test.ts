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
});
