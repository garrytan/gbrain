/**
 * BrainEngine parity: retrieval coverage (engine-sql/retrieval-coverage.ts) through
 * its two sites, search/retrieval-coverage (the pending and rebuild counts) and
 * search/projection-readiness (the readiness probe search, query and doctor read).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts) the pending-projection
 *    count, its could-affect and image counts, the exact top hit's
 *    `top_counted`, the rebuild progress and the readiness status are the same
 *    for the same pages and the same read scope: sources, privacy, kind, types,
 *    excluded slug prefixes, soft-deleted, quarantined and archived pages.
 *  - Regression: an engine whose count drifts tells a search caller that a
 *    complete answer is incomplete (or the reverse), and an engine whose probe
 *    drifts reports `ready` while pages wait for indexing. Before this lane the
 *    counts refused on Rust and the probe read `unknown` there.
 *  - Why existing coverage misses it: test/projection-readiness.test.ts and
 *    test/search-coverage-*.test.ts run on PGLite only and never compare arms.
 *  - Seam: none. Typed members and the site functions only. Page ids are
 *    serial and engine-dependent: a case passes ids it read with `getPage` and
 *    never returns them.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import {
  countPendingProjections, countProjectionRebuild, coverageRelevance, type CoverageRelevance,
} from '../../src/core/search/retrieval-coverage.ts';
import {
  __resetProjectionReadinessCacheForTests, PROJECTION_READINESS_CACHE_ENV, probeProjectionReadiness, type ProjectionReadinessScope,
} from '../../src/core/search/projection-readiness.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const ALL: CoverageRelevance = { all: true, types: [], patterns: [], pageIds: [], exactTopPageId: null, imageArm: false };
const NONE: CoverageRelevance = { ...ALL, all: false };
const PROTECTED_BODY = 'Scan of a receipt\n\n<!--- gbrain:facts:begin -->\n| fact |\n<!--- gbrain:facts:end -->';

function page(title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra };
}

/** Write a page and seal its projection, so it no longer counts as pending. */
async function sealed(engine: BrainEngine, slug: string, input: PageInput, sourceId?: string): Promise<void> {
  const opts = sourceId ? { sourceId } : undefined;
  await engine.putPage(slug, input, opts);
  await installChunks(engine, slug, [chunk(0, input.compiled_truth)], opts);
}

async function pageId(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<number> {
  const found = await engine.getPage(slug, { sourceId });
  if (!found) throw new Error(`fixture page ${sourceId}:${slug} is missing`);
  return found.id;
}

/** The probe with its cache cleared first, so each case starts cold on every arm. */
async function probe(engine: BrainEngine, scope: ProjectionReadinessScope = {}) {
  return (await probeProjectionReadiness(engine, scope)).status;
}

/**
 * The shared brain: in `default`, two unsealed notes, one sealed note, a soft-deleted, a quarantined and a private
 * unsealed note, an unsealed person and an unsealed image; in `other`, one unsealed note; in `gone` (archived), one.
 */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'other');
  await createSource(engine, backend, 'gone');
  await engine.putPage('notes/widget-plan', page('Widget plan'));
  await engine.putPage('notes/subwidgets', page('Subwidgets'));
  await sealed(engine, 'notes/sealed-widget', page('Sealed widget'));
  await engine.putPage('notes/deleted-widget', page('Deleted widget'));
  await engine.softDeletePage('notes/deleted-widget');
  await engine.putPage('notes/held-widget', page('Held widget', { frontmatter: { quarantine: 'unsafe import' } }));
  await engine.putPage('notes/private-widget', page('Private widget', { frontmatter: { visibility: 'private' } }));
  await engine.putPage('people/alice-example', page('Alice', { type: 'person' }));
  await engine.putPage('images/the_widget', page('the_widget', { page_kind: 'image', compiled_truth: 'Photo of the_widget' }));
  await engine.putPage('notes/other-widget', page('Other widget'), { sourceId: 'other' });
  await engine.putPage('notes/gone-widget', page('Gone widget'), { sourceId: 'gone' });
  await archiveSource(engine, backend, 'gone');
}

describe('engine parity: retrieval coverage', () => {
  parityTest(
    'search/retrieval-coverage: pending counts skip sealed, soft-deleted, quarantined and archived pages in each source scope',
    { methods: ['putPage', 'sealChunks', 'softDeletePage', 'countPendingProjectionPages'] },
    async (engine, backend) => {
      await seed(engine, backend);
      const scopes: Record<string, ProjectionReadinessScope> = {
        all: {}, default: { sourceId: 'default' }, other: { sourceId: 'other' }, both: { sourceIds: ['default', 'other'] },
        idsWin: { sourceId: 'default', sourceIds: ['other'] }, noSources: { sourceIds: [] }, archived: { sourceId: 'gone' },
        public: { excludePrivate: true },
      };
      const out: Record<string, unknown> = {};
      for (const [name, scope] of Object.entries(scopes)) out[name] = await countPendingProjections(engine, scope, ALL);
      expect(out.default).toEqual({ total: 5, could_affect: 4, capped: false, could_affect_images: 0 });
      return out;
    },
  );

  parityTest(
    'search/retrieval-coverage: kind, type and excluded-prefix scopes narrow the pending count',
    { methods: ['putPage', 'sealChunks', 'softDeletePage', 'countPendingProjectionPages'] },
    async (engine, backend) => {
      await seed(engine, backend);
      const scopes: Record<string, ProjectionReadinessScope> = {
        markdown: { pageKind: 'markdown' }, image: { pageKind: 'image' }, emptyKind: { pageKind: '' },
        people: { types: ['person'] }, noTypes: { types: [] }, notesAndPeople: { types: ['note', 'person'] },
        noNotes: { excludeSlugPrefixes: ['notes/'] }, twoPrefixes: { excludeSlugPrefixes: ['notes/', 'people/'] },
        emptyPrefix: { excludeSlugPrefixes: [''] }, likeChars: { excludeSlugPrefixes: ['notes_%'] },
      };
      const out: Record<string, unknown> = {};
      for (const [name, scope] of Object.entries(scopes)) out[name] = await countPendingProjections(engine, scope, ALL);
      return out;
    },
  );

  parityTest(
    'search/retrieval-coverage: could-affect follows types, whole-token words, returned pages and the image arm',
    { methods: ['putPage', 'sealChunks', 'softDeletePage', 'getPage', 'countPendingProjectionPages'] },
    async (engine, backend) => {
      await seed(engine, backend);
      await engine.putPage('notes/pre-widget', page('Pre-widget launch'));
      await engine.putPage('notes/widgetry', page('Widgetry'));
      const words = coverageRelevance([{ type: 'company' }], 'widget launches', undefined, new Set());
      const alice = await pageId(engine, 'people/alice-example');
      const image = await pageId(engine, 'images/the_widget');
      const cases: Record<string, CoverageRelevance> = {
        nothing: NONE,
        people: { ...NONE, types: ['person'] },
        words,
        wordsWithImages: { ...words, imageArm: true },
        launch: coverageRelevance([{ type: 'company' }], 'launch', undefined, new Set()),
        returned: { ...NONE, pageIds: [alice, image] },
        allWithImages: { ...ALL, imageArm: true },
      };
      const out: Record<string, unknown> = {};
      for (const [name, relevance] of Object.entries(cases)) out[name] = await countPendingProjections(engine, { sourceId: 'default' }, relevance);
      expect(words.patterns.length).toBe(2);
      return out;
    },
  );

  parityTest(
    'search/retrieval-coverage: an exact top hit is counted only while its own page waits for indexing',
    { methods: ['putPage', 'sealChunks', 'softDeletePage', 'getPage', 'countPendingProjectionPages'] },
    async (engine, backend) => {
      await seed(engine, backend);
      await engine.putPage('images/receipt', page('Receipt', { page_kind: 'image', compiled_truth: PROTECTED_BODY }));
      const tops: Record<string, number> = {
        pending: await pageId(engine, 'notes/widget-plan'),
        sealed: await pageId(engine, 'notes/sealed-widget'),
        quarantined: await pageId(engine, 'notes/held-widget'),
        otherSource: await pageId(engine, 'notes/other-widget', 'other'),
        archived: await pageId(engine, 'notes/gone-widget', 'gone'),
        protectedImage: await pageId(engine, 'images/receipt'),
      };
      const out: Record<string, unknown> = {};
      for (const [name, top] of Object.entries(tops)) {
        out[name] = await countPendingProjections(engine, { sourceId: 'default' }, { ...NONE, exactTopPageId: top });
      }
      return out;
    },
  );

  parityTest(
    'search/retrieval-coverage: protected images never count as pending, and an unsealed image counts as an image',
    { methods: ['putPage', 'sealChunks', 'countPendingProjectionPages'] },
    async (engine) => {
      await engine.putPage('images/receipt', page('Receipt', { page_kind: 'image', compiled_truth: PROTECTED_BODY }));
      const onlyProtected = await countPendingProjections(engine, {}, { ...ALL, imageArm: true });
      await engine.putPage('images/cat', page('Cat', { page_kind: 'image', compiled_truth: 'A cat' }));
      const withImage = await countPendingProjections(engine, {}, { ...ALL, imageArm: true });
      await installChunks(engine, 'images/cat', [chunk(0, 'A cat')]);
      const imageSealed = await countPendingProjections(engine, {}, { ...ALL, imageArm: true });
      return { onlyProtected, withImage, imageSealed };
    },
  );

  parityTest(
    'search/retrieval-coverage: no index rebuild is running, so the rebuild progress is null in every scope',
    { methods: ['putPage', 'sealChunks', 'softDeletePage', 'projectionRebuildProgress'] },
    async (engine, backend) => {
      await seed(engine, backend);
      const scopes: ProjectionReadinessScope[] = [{}, { sourceId: 'other' }, { sourceIds: [] }, { types: ['person'], excludePrivate: true }];
      const out: unknown[] = [];
      for (const scope of scopes) out.push(await countProjectionRebuild(engine, scope));
      expect(out).toEqual([null, null, null, null]);
      return out;
    },
  );

  parityTest(
    'search/projection-readiness: ready, pending and by-design statuses follow the scope',
    { methods: ['putPage', 'sealChunks', 'softDeletePage', 'readProjectionReadiness'] },
    async (engine, backend) => {
      __resetProjectionReadinessCacheForTests();
      return withEnv({ [PROJECTION_READINESS_CACHE_ENV]: '0' }, async () => {
        const empty = await probe(engine);
        await seed(engine, backend);
        await engine.putPage('images/receipt', page('Receipt', { page_kind: 'image', compiled_truth: PROTECTED_BODY }), { sourceId: 'other' });
        await sealed(engine, 'notes/other-widget', page('Other widget'), 'other');
        const scopes: Record<string, ProjectionReadinessScope> = {
          all: {}, default: { sourceId: 'default' }, other: { sourceId: 'other' }, noSources: { sourceIds: [] },
          archived: { sourceId: 'gone' }, images: { pageKind: 'image' }, people: { types: ['person'] },
          noNotes: { sourceId: 'default', excludeSlugPrefixes: ['notes/', 'people/', 'images/'] },
          public: { sourceId: 'default', excludePrivate: true, types: ['note'], excludeSlugPrefixes: ['notes/widget', 'notes/sub'] },
        };
        const out: Record<string, unknown> = { empty };
        for (const [name, scope] of Object.entries(scopes)) out[name] = await probe(engine, scope);
        expect(out.other).toBe('by_design');
        return out;
      });
    },
  );

  parityTest(
    'search/projection-readiness: with the cache on, a write, a seal and an archive each change the answer',
    { methods: ['putPage', 'sealChunks', 'readProjectionReadinessGeneration', 'readProjectionReadiness'] },
    async (engine, backend) => {
      __resetProjectionReadinessCacheForTests();
      return withEnv({ [PROJECTION_READINESS_CACHE_ENV]: undefined }, async () => {
        await createSource(engine, backend, 'other');
        const steps: string[] = [await probe(engine), await probe(engine)];
        await engine.putPage('notes/a', page('A'), { sourceId: 'other' });
        steps.push(await probe(engine), await probe(engine));
        await installChunks(engine, 'notes/a', [chunk(0, 'A body')], { sourceId: 'other' });
        steps.push(await probe(engine));
        await engine.putPage('notes/b', page('B'), { sourceId: 'other' });
        steps.push(await probe(engine));
        await archiveSource(engine, backend, 'other');
        steps.push(await probe(engine));
        expect(steps).toEqual(['ready', 'ready', 'projection_pending', 'projection_pending', 'ready', 'projection_pending', 'ready']);
        return steps;
      });
    },
  );

  parityTest(
    'search/retrieval-coverage: a trust floor in the scope is read on the SQL engines',
    { methods: ['putPage', 'countPendingProjectionPages'] },
    async (engine) => {
      await engine.putPage('notes/a', page('A'));
      return countPendingProjections(engine, { minTrust: 'agent_written' }, ALL);
    },
  );
});
