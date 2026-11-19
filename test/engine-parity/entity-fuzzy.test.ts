/**
 * BrainEngine parity — the fuzzy entity lookup (engine-sql/entity-reads.ts `findFuzzyEntityCandidates`) and the
 * resolvers that read it (entities/resolve.ts `tryFuzzyMatch`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the candidate rows (slug, title, type and the pg_trgm score), their order (best score, then slug), the
 *    five-row cap, the title `%` and slug `ILIKE` filters, and the live, unretired, one-source scope are the same on
 *    every engine arm. So are the answers of the two resolvers built on it: `resolveEntitySlugWithSource` (the
 *    same-name tier; entities/resolve.ts and persistence/memory-mutations.ts `resolveRememberEntity` send a
 *    reference with a folder there) and `resolvePhantomCanonical` (the score-gap tier).
 *  - Regression: an engine that scores with a different trigram set, breaks equal scores another way, keeps a sixth
 *    row, matches the slug case-sensitively or reads a retired, deleted or other-source page changes which page a
 *    fact or a phantom merges into; an engine that cannot run the lookup at all stops every remember of an entity
 *    with a folder.
 *  - Why existing coverage misses it: the lookup ran through `executeRaw`, which the parity cases cannot call (D18),
 *    and the Rust store refused it, so no case compared it across engines.
 *  - Seam: none. Typed methods and the resolvers only. Scores are `real`s; every arm returns them as JavaScript reads
 *    a PGLite `real`. Equal-score slugs here sort the same under C and the Postgres test locale (`slug ASC`
 *    follows the database collation on Postgres; PGLite and the store sort bytes). A whole remember is not a case
 *    here: on the Rust arm the persistence consumer's resident projection probe (page-state/projections.ts) still
 *    reads through executeRaw.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveEntitySlugWithSource, resolvePhantomCanonical } from '../../src/core/entities/resolve.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'other');
  const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}) =>
    ({ type, title, compiled_truth: `${title} body.`, frontmatter }) as Parameters<BrainEngine['putPage']>[1];
  const pages: Array<[string, Parameters<BrainEngine['putPage']>[1], string?]> = [
    ['people/a-example', page('person', 'Alice Example')],
    ['people/alicia-example', page('person', 'Alicia Example')],
    ['people/carol-example', page('person', 'Carol Example')],
    ['people/ops-acme', page('person', 'Ops/Acme')],
    ['people/dana-a', page('person', 'Dana Ray')],
    ['people/dana-b', page('person', 'Dana Ray')],
    ['people/zoe-muller', page('person', 'Zoë MÜLLER')],
    ['companies/acme-widgets', page('company', 'Acme Widgets')],
    ['projects/widget-co-launch', page('project', 'Launch plan')],
    ['meetings/2026-04-03', page('meeting', 'Alice Example sync')],
    ['people/old-alice', page('person', 'Alice Example', { status: 'Redirect' })],
    ['people/merged-alice', page('person', 'Alice Example', { merged_into: 'people/a-example' })],
    ['people/blank-alice', page('person', 'Alice Examples', { merged_into: '  ', canonical: true })],
    ['people/gone-alice', page('person', 'Alice Example')],
    ['people/b-example', page('person', 'Alice Example'), 'other'],
  ];
  for (const [slug, input, sourceId] of pages) await engine.putPage(slug, input, { sourceId: sourceId ?? 'default' });
  await engine.softDeletePage('people/gone-alice', { sourceId: 'default' });
}

describe('engine parity: the fuzzy entity lookup', () => {
  parityTest('findFuzzyEntityCandidates scores, filters, orders and caps the candidates of one source',
    { methods: ['findFuzzyEntityCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const read = (title: string, fragment: string, sourceId = 'default') =>
        engine.findFuzzyEntityCandidates(sourceId, title, fragment);
      const result = {
        typo: await read('alice exampel', 'alice-exampel'),
        exact: await read('alice example', 'alice-example'),
        tie: await read('dana ray', 'dana-ray'),
        unicode: await read('zoë müller', 'zoe-muller'),
        slugOnly: await read('widget co', 'widget-co'),
        upperFragment: await read('nothing alike', 'WIDGET-CO'),
        wildcard: await read('nothing alike', 'dana_a'),
        everySlug: await read('qqq', ''),
        other: await read('alice example', 'alice-example', 'other'),
        none: await read('zzz', 'zzz'),
        ghost: await read('alice example', 'alice-example', 'no-such-source'),
      };
      expect(result.exact.map((r) => r.slug)).toEqual(['people/a-example', 'people/blank-alice', 'meetings/2026-04-03',
        'people/alicia-example', 'people/carol-example']);
      expect(result.exact[0]).toEqual({ slug: 'people/a-example', title: 'Alice Example', type: 'person', score: 1 });
      expect(result.tie.map((r) => r.slug).slice(0, 2)).toEqual(['people/dana-a', 'people/dana-b']);
      expect(result.slugOnly.map((r) => r.slug)).toContain('projects/widget-co-launch');
      expect(result.upperFragment.map((r) => r.slug)).toEqual(['projects/widget-co-launch']);
      expect(result.wildcard.map((r) => r.slug)).toEqual(['people/dana-a']);
      expect(result.everySlug).toHaveLength(5);
      expect(result.other.map((r) => r.slug)).toEqual(['people/b-example']);
      expect(result.none).toEqual([]);
      expect(result.ghost).toEqual([]);
      return result;
    });

  // A reference with a folder skips the exact-basename tier (entity-basename.test.ts) and goes straight to the
  // fuzzy tier as `resolveRememberEntity` sends it there.
  parityTest('resolveEntitySlugWithSource takes the one same-name fuzzy candidate and falls back on two',
    { methods: ['findFuzzyEntityCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const resolve = (raw: string) => resolveEntitySlugWithSource(engine, 'default', raw);
      const result = {
        sameName: await resolve('Acme/Ops'),
        twoSameName: await resolve('Ray/Dana'),
        folderIsAName: await resolve('People/Alice Example'),
        typo: await resolve('People/Alice Exampel'),
        unicode: await resolve('People/Zoë Müller'),
      };
      expect(result.sameName).toEqual({ slug: 'people/ops-acme', source: 'fuzzy_match' });
      expect(result.twoSameName?.source).toBe('fallback_slugify');
      expect(result.folderIsAName?.source).toBe('fallback_slugify');
      return result;
    });

  // Only phantoms the fuzzy tier settles: a miss goes on to prefix expansion, whose referrer count is another wall.
  parityTest('resolvePhantomCanonical takes a clear fuzzy leader',
    { methods: ['findFuzzyEntityCandidates'] }, async (engine, backend) => {
      await seed(engine, backend);
      const result = {
        leader: await resolvePhantomCanonical(engine, 'default', 'carol-example'),
        typo: await resolvePhantomCanonical(engine, 'default', 'carol-exampl'),
      };
      expect(result.leader).toBe('people/carol-example');
      return result;
    });
});
