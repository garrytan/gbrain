/**
 * BrainEngine parity — the exact-basename entity lookup (engine-sql/entity-reads.ts `findExactBasenameCandidates`),
 * the retirement hop it follows (`readRetirementHop`), and the resolver step built on both (entities/resolve.ts
 * `findExactBasenameCandidates` inside `resolveEntitySlugWithSource`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the live `<dir>/<basename>` slugs of one source (at most two), and per hop the live page's slug, type,
 *    retired flag and trimmed `superseded_by`, else `merged_into`, target are the same on every engine arm. So is the
 *    resolver answer: a bare multi-word name with one live basename page resolves to that page (`fuzzy_match`),
 *    through a retired page's redirect to its target, before the fuzzy tier sees same-name pages.
 *  - Regression: an engine that cannot run the basename lookup sends "Dana Ray Example" on to the fuzzy tier, which
 *    finds two pages of that name and falls back to a slugified phantom: a fact lands on a new page, not the
 *    person's own page. An engine that reads a deleted or other-source page, or trims the target another way,
 *    changes which page answers.
 *  - Why existing coverage misses it: both reads ran through `executeRaw`, which the parity cases cannot call (D18);
 *    the resolver swallowed the Rust refusal, so the divergence was silent.
 *  - Seam: none. Typed methods and the resolver only. Two matching slugs are compared sorted: Postgres reads them
 *    with `LIMIT 2` and no `ORDER BY`, the store in slug byte order.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveEntitySlugWithSource } from '../../src/core/entities/resolve.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'other');
  const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}) =>
    ({ type, title, compiled_truth: `${title} body.`, frontmatter }) as Parameters<BrainEngine['putPage']>[1];
  const pages: Array<[string, Parameters<BrainEngine['putPage']>[1], string?]> = [
    ['people/dana-ray-example', page('person', 'Dana Ray Example')],
    ['people/dana-r-example', page('person', 'Dana Ray Example')],
    ['people/old-lee-example', page('person', 'Old Lee Example', { merged_into: '  people/lee-example ' })],
    ['people/lee-example', page('person', 'Lee Example')],
    ['people/sup-example', page('person', 'Sup Example', { superseded_by: 'people/lee-example', merged_into: 'people/x' })],
    ['people/off-example', page('person', 'Off Example', { canonical: false })],
    ['people/blank-example', page('person', 'Blank Example', { merged_into: '   ', status: 'active' })],
    ['people/twin-example', page('person', 'Twin Example')],
    ['companies/twin-example', page('company', 'Twin Example')],
    ['people/gone-example', page('person', 'Gone Example')],
    ['people/far-example', page('person', 'Far Example'), 'other'],
  ];
  for (const [slug, input, sourceId] of pages) await engine.putPage(slug, input, { sourceId: sourceId ?? 'default' });
  await engine.softDeletePage('people/gone-example', { sourceId: 'default' });
}

const dirs = (token: string) => ['people', 'companies', 'hosts', 'projects', 'concepts'].map(d => `${d}/${token}`);

describe('engine parity: the exact-basename entity lookup', () => {
  parityTest('findExactBasenameCandidates returns the live slugs of one source, at most two',
    { methods: ['findExactBasenameCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const find = async (token: string, sourceId = 'default') =>
        (await engine.findExactBasenameCandidates(sourceId, dirs(token))).sort();
      const result = {
        one: await find('dana-ray-example'),
        two: await find('twin-example'),
        deleted: await find('gone-example'),
        otherSource: await find('far-example'),
        inOther: await find('far-example', 'other'),
        none: await find('nobody-example'),
        empty: await engine.findExactBasenameCandidates('default', []),
      };
      expect(result.one).toEqual(['people/dana-ray-example']);
      expect(result.two).toEqual(['companies/twin-example', 'people/twin-example']);
      expect(result.deleted).toEqual([]);
      expect(result.otherSource).toEqual([]);
      expect(result.inOther).toEqual(['people/far-example']);
      return result;
    });

  parityTest('readRetirementHop reads the retired flag and the trimmed redirect target',
    { methods: ['readRetirementHop'] }, async (engine, backend) => {
      await seed(engine, backend);
      const hop = (slug: string, sourceId = 'default') => engine.readRetirementHop(sourceId, slug, 'none');
      const result = {
        live: await hop('people/lee-example'),
        merged: await hop('people/old-lee-example'),
        superseded: await hop('people/sup-example'),
        notCanonical: await hop('people/off-example'),
        blankTarget: await hop('people/blank-example'),
        deleted: await hop('people/gone-example'),
        otherSource: await hop('people/far-example'),
        missing: await hop('people/nobody-example'),
      };
      expect(result.live).toEqual({ slug: 'people/lee-example', type: 'person', retired: false, target: null });
      expect(result.merged).toEqual({ slug: 'people/old-lee-example', type: 'person', retired: true, target: 'people/lee-example' });
      expect(result.superseded?.target).toBe('people/lee-example');
      expect(result.notCanonical).toEqual({ slug: 'people/off-example', type: 'person', retired: true, target: null });
      expect(result.blankTarget?.retired).toBe(false);
      expect(result.deleted).toBeNull();
      expect(result.otherSource).toBeNull();
      return result;
    });

  parityTest('resolveEntitySlugWithSource takes the one live basename page before the fuzzy tier',
    { methods: ['findExactBasenameCandidates', 'readRetirementHop'] }, async (engine, backend) => {
      await seed(engine, backend);
      const resolve = (raw: string) => resolveEntitySlugWithSource(engine, 'default', raw);
      const result = {
        sameNameTwin: await resolve('Dana Ray Example'),
        retired: await resolve('Old Lee Example'),
      };
      expect(result.sameNameTwin).toEqual({ slug: 'people/dana-ray-example', source: 'fuzzy_match' });
      expect(result.retired).toEqual({ slug: 'people/lee-example', source: 'fuzzy_match' });
      return result;
    });
});
