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
 *    excluded slug prefixes, the trust floor, the flagged-page filter,
 *    soft-deleted, quarantined and archived pages. A
 *    count that reaches the cap counts every match in scope up to its own cap,
 *    whatever order the pages were written in, and the probe's cached answer
 *    lasts until the next write on every arm.
 *  - Regression: an engine whose count drifts tells a search caller that a
 *    complete answer is incomplete (or the reverse), and an engine whose probe
 *    drifts reports `ready` while pages wait for indexing. Before this lane the
 *    counts refused on Rust and the probe read `unknown` there.
 *  - Why existing coverage misses it: test/projection-readiness.test.ts and
 *    test/search-coverage-*.test.ts run on PGLite only and never compare arms.
 *  - Seam: none. Typed members and the site functions only; on Postgres one case
 *    holds a transaction open in another database through a second connection. Page ids are
 *    serial and engine-dependent: a case passes ids it read with `getPage` and
 *    never returns them.
 */
import { describe, expect } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import {
  countPendingProjections, countProjectionRebuild, coverageRelevance, type CoverageRelevance,
} from '../../src/core/search/retrieval-coverage.ts';
import {
  __resetProjectionReadinessCacheForTests, PROJECTION_READINESS_CACHE_ENV, probeProjectionReadiness, type ProjectionReadinessScope,
} from '../../src/core/search/projection-readiness.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const ALL: CoverageRelevance = { all: true, types: [], patterns: [], pageIds: [], exactTopPageId: null, imageArm: false };
const NONE: CoverageRelevance = { ...ALL, all: false };
const PROTECTED_BODY = 'Scan of a receipt\n\n<!--- gbrain:facts:begin -->\n| fact |\n<!--- gbrain:facts:end -->';

/** On the Postgres arm, runs `body` while the server's DATABASE_URL database holds an open transaction with an id. */
async function withOtherDatabaseBusy<T>(backend: string, body: () => Promise<T>): Promise<T> {
  if (backend !== 'postgres') return body();
  const other = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  try {
    await other.unsafe('BEGIN');
    await other.unsafe('SELECT txid_current()');
    return await body();
  } finally { await other.unsafe('ROLLBACK').catch(() => undefined); await other.end(); }
}

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

  // #10000 (loss row 40): the rebuild counts as running only while an activation row waits on a `text` page of a live
  // source in scope, so activation rows parked on images, on an archived source or outside the scope start no clock.
  parityTest(
    'search/retrieval-coverage: the rebuild clock starts only from an activation row on a text page in scope',
    { methods: ['putPage', 'claimSegmentedProjection', 'projectionRebuildProgress'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await createSource(engine, backend, 'gone');
      const activate = (slug: string, sourceId = 'default') => engine.claimSegmentedProjection({ sourceId, slug }, 'protocol_activation');
      const progress = async (scope: ProjectionReadinessScope) => {
        const p = await countProjectionRebuild(engine, scope);
        return p === null ? null : { done: p.done, total: p.total, rated: p.pages_per_second === null ? null : p.pages_per_second > 0 };
      };
      await engine.putPage('images/the_widget', page('the_widget', { page_kind: 'image', compiled_truth: 'Photo of the_widget' }));
      await engine.putPage('notes/gone-widget', page('Gone widget'), { sourceId: 'gone' });
      await engine.putPage('notes/other-widget', page('Other widget'), { sourceId: 'other' });
      const claims = [await activate('images/the_widget'), await activate('notes/gone-widget', 'gone'), await activate('notes/other-widget', 'other')];
      await archiveSource(engine, backend, 'gone');
      const imagesOnly = { all: await progress({}), mine: await progress({ sourceId: 'default' }) };
      await engine.putPage('notes/widget-plan', page('Widget plan'));
      claims.push(await activate('notes/widget-plan'));
      const withText = { mine: await progress({ sourceId: 'default' }), image: await progress({ sourceId: 'default', pageKind: 'image' }) };
      const out = { claims, imagesOnly, withText };
      expect(out.imagesOnly.mine).toBeNull();
      expect(out.withText.mine).not.toBeNull();
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

  // A transaction reads its own writes before they commit: the probe must not reuse an answer cached before them.
  parityTest(
    'search/projection-readiness: with the cache on, a probe inside a transaction sees that transaction\'s page write',
    { methods: ['transaction', 'putPage', 'readProjectionReadinessGeneration', 'readProjectionReadiness'] },
    async (engine) => {
      __resetProjectionReadinessCacheForTests();
      return withEnv({ [PROJECTION_READINESS_CACHE_ENV]: undefined }, () => engine.transaction(async (tx) => {
        const steps: string[] = [await probe(tx)];
        await tx.putPage('notes/in-transaction', page('In transaction'));
        steps.push(await probe(tx), await probe(tx));
        expect(steps).toEqual(['ready', 'projection_pending', 'projection_pending']);
        return steps;
      }));
    },
  );

  parityTest(
    'search/projection-readiness: with the cache on, a probe with no write since the last reuses its answer',
    { methods: ['putPage', 'readProjectionReadinessGeneration', 'readProjectionReadiness'] },
    async (engine, backend) => {
      __resetProjectionReadinessCacheForTests();
      // On Postgres a transaction stays open in another database on the same server (the server's own database), as
      // on a server shared with other brains or a busy job queue: it must not turn this brain's cache off.
      return withOtherDatabaseBusy(backend, () => withEnv({ [PROJECTION_READINESS_CACHE_ENV]: undefined }, async () => {
        await engine.putPage('notes/a', page('A'));
        const first = await probeProjectionReadiness(engine);
        const again = await probeProjectionReadiness(engine);
        await engine.putPage('notes/b', page('B'));
        const afterWrite = await probeProjectionReadiness(engine);
        const generation = await engine.readProjectionReadinessGeneration();
        return { status: first.status, reused: again === first, rereadAfterWrite: afterWrite !== again, named: typeof generation === 'string' };
      }));
    },
  );

  parityTest(
    'search/retrieval-coverage: a capped count gives the same could-affect whatever order the pages were written in',
    { methods: ['putPage', 'countPendingProjectionPages'] },
    async (engine) => {
      // Three matching pages sort before a cap of other pages and two after them, and they are written in neither
      // order. Rewriting the matching pages moves their rows on the SQL engines, so a count of the matches among the
      // first 1000 rows an engine reads moves with them (and differs between engines); a count of every match does not.
      const widgets = ['alpha/widget-0', 'alpha/widget-1', 'alpha/widget-2', 'zeta/widget-3', 'zeta/widget-4'];
      for (const slug of widgets.slice(3)) await engine.putPage(slug, page(`Widget ${slug}`));
      for (let i = 0; i < 1000; i++) await engine.putPage(`mid/other-${String(i).padStart(4, '0')}`, page('Other'));
      for (const slug of widgets.slice(0, 3)) await engine.putPage(slug, page(`Widget ${slug}`));
      const words = coverageRelevance([{ type: 'company' }], 'widget', undefined, new Set());
      const written = await countPendingProjections(engine, {}, words);
      for (const slug of widgets) await engine.putPage(slug, page(`Widget ${slug} again`));
      const rewritten = await countPendingProjections(engine, {}, words);
      expect({ written, rewritten }).toEqual({
        written: { total: 1000, capped: true, could_affect: 5, could_affect_images: 0 },
        rewritten: { total: 1000, capped: true, could_affect: 5, could_affect_images: 0 },
      });
      return { written, rewritten };
    },
  );

  parityTest(
    'search/retrieval-coverage: more could-affect pages than the cap stop could-affect at the cap',
    { methods: ['putPage', 'countPendingProjectionPages'] },
    async (engine) => {
      // More than a cap of matching pages: could_affect stops at its own cap, never above total, and the notice's
      // `could - images` stays non-negative.
      for (let i = 0; i < 1003; i++) await engine.putPage(`notes/widget-${String(i).padStart(4, '0')}`, page(`Widget ${i}`));
      const words = coverageRelevance([{ type: 'company' }], 'widget', undefined, new Set());
      const capped = await countPendingProjections(engine, {}, words);
      expect(capped).toEqual({ total: 1000, capped: true, could_affect: 1000, could_affect_images: 0 });
      return capped;
    },
  );

  parityTest(
    'search/retrieval-coverage: a count that reaches the cap still counts every could-affect page',
    { methods: ['putPage', 'countPendingProjectionPages'] },
    async (engine) => {
      // Five matching pages written first, then a cap of pages that sort before them by slug. could_affect counts
      // every match in scope (up to its own cap), not the matches among the first 1000 pages an engine happens to read.
      for (let i = 0; i < 5; i++) await engine.putPage(`zeta/widget-${i}`, page(`Widget ${i}`));
      for (let i = 0; i < 1000; i++) await engine.putPage(`alpha/other-${String(i).padStart(4, '0')}`, page('Other'));
      for (let i = 0; i < 5; i++) await engine.putPage(`zeta/widget-${i}`, page(`Widget ${i}`, { compiled_truth: `Widget ${i} body, revised` }));
      const words = coverageRelevance([{ type: 'company' }], 'widget', undefined, new Set());
      const capped = await countPendingProjections(engine, {}, words);
      expect(capped).toEqual({ total: 1000, capped: true, could_affect: 5, could_affect_images: 0 });
      return capped;
    },
  );

  parityTest(
    'search/retrieval-coverage: a trust floor and the flagged-page filter narrow the pending count, the rebuild and the probe',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'upsertPageWriteGateReceipt', 'countPendingProjectionPages', 'projectionRebuildProgress', 'readProjectionReadiness'] },
    async (engine) => {
      const declared = (tier: string, slug: string) => engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
        await tx.putPage(slug, page(slug));
      });
      const flag = (slug: string, families: string[]) => engine.upsertPageWriteGateReceipt('default', slug, {
        content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: families,
        reasons: families, detector_error: false, request_id: null,
      });
      await declared('operator_curated', 'notes/curated');
      await declared('tool_observed', 'notes/observed');
      await declared('agent_written', 'notes/agent');
      await declared('agent_written', 'notes/agent-flagged');
      await flag('notes/agent-flagged', ['override']);
      await declared('agent_written', 'notes/agent-other-flag');
      await flag('notes/agent-other-flag', ['other']);
      await engine.putPage('notes/unknown-flagged', page('Unknown flagged'));
      await flag('notes/unknown-flagged', ['credential']);
      await declared('external_untrusted', 'notes/outside');
      const scopes: Record<string, ProjectionReadinessScope> = {
        none: {}, emptyFloor: { minTrust: '' as never }, curated: { minTrust: 'operator_curated' }, observed: { minTrust: 'tool_observed' },
        agent: { minTrust: 'agent_written' }, unknown: { minTrust: 'unknown' }, any: { minTrust: 'external_untrusted' },
        confirmedOnly: { minTrust: 'user_confirmed' }, suppressed: { suppressFlagged: true },
        agentSuppressed: { minTrust: 'agent_written', suppressFlagged: true },
      };
      const counts: Record<string, unknown> = {};
      const rebuild: Record<string, unknown> = {};
      const probes: Record<string, unknown> = {};
      for (const [name, scope] of Object.entries(scopes)) {
        counts[name] = await countPendingProjections(engine, scope, ALL);
        rebuild[name] = await countProjectionRebuild(engine, scope);
        __resetProjectionReadinessCacheForTests();
        probes[name] = await withEnv({ [PROJECTION_READINESS_CACHE_ENV]: '0' }, () => probe(engine, scope));
      }
      expect((counts.agentSuppressed as { total: number }).total).toBe(4);
      expect((counts.confirmedOnly as { total: number }).total).toBe(0);
      return { counts, rebuild, probes };
    },
  );

  parityTest(
    'search/retrieval-coverage: under excludePrivate the pending count, the rebuild and the probe apply a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'countPendingProjectionPages', 'projectionRebuildProgress', 'readProjectionReadiness'] },
    async (engine) => {
      for (const [slug, frontmatter] of [
        ['notes/open', {}], ['notes/private', { visibility: 'private' }], ['notes/readers', { readable_by: ['alice-example'] }],
        ['notes/team', { readable_by: 'group:team-a' }], ['notes/bob-only', { readable_by: ['bob-example'] }],
        ['notes/pinned', { visibility: 'private', pinned_question: true }],
      ] as const) await engine.putPage(slug, page(slug, { frontmatter }));
      const scope: ProjectionReadinessScope = { excludePrivate: true };
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () => {
        __resetProjectionReadinessCacheForTests();
        return {
          count: await countPendingProjections(engine, scope, ALL),
          rebuild: await countProjectionRebuild(engine, scope),
          probe: await withEnv({ [PROJECTION_READINESS_CACHE_ENV]: '0' }, () => probe(engine, scope)),
        };
      });
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const stranger = await read({ identity: ['member:carol-example'], hidePrivate: true });
      expect(stranger.count?.total).toBe(1);
      expect(member.count?.total).toBe(3);
      expect(granted.count?.total).toBe(3);
      return { member, granted, stranger };
    },
  );

  parityTest(
    'search/retrieval-coverage: under excludePrivate the pending count, the rebuild and the probe skip an owner-only source, and under the closed form every page while one exists',
    { methods: ['putPage', 'addLink', 'countPendingProjectionPages', 'projectionRebuildProgress', 'readProjectionReadiness'] },
    async (engine, backend) => {
      await engine.putPage('notes/open-a', page('Open a'));
      await engine.putPage('notes/open-b', page('Open b'));
      await engine.putPage('concepts/synthesis', page('Synthesis', { type: 'concept' }));
      await sealed(engine, 'notes/sealed', page('Sealed'));
      const scope: ProjectionReadinessScope = { excludePrivate: true };
      const read = async () => {
        __resetProjectionReadinessCacheForTests();
        return {
          count: await countPendingProjections(engine, scope, ALL),
          rebuild: await countProjectionRebuild(engine, scope),
          probe: await withEnv({ [PROJECTION_READINESS_CACHE_ENV]: '0' }, () => probe(engine, scope)),
        };
      };
      const before = await read();
      // An owner-only source: two unsealed pages, one sealed, and the concept's lineage input.
      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await engine.putPage('notes/chat-a', page('Chat a'), { sourceId: 'chat' });
      await engine.putPage('notes/chat-b', page('Chat b'), { sourceId: 'chat' });
      await sealed(engine, 'notes/chat-sealed', page('Chat sealed'), 'chat');
      await engine.addLink('concepts/synthesis', 'notes/chat-a', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: 'default', toSourceId: 'chat' });
      const unfiltered = await countPendingProjections(engine, {}, ALL);
      const closed = await read();
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      const fn = await withEngineScope(engine, read);
      expect(before.count?.total).toBe(3);
      expect(unfiltered?.total).toBe(5);
      expect(closed.count?.total).toBe(0);
      expect(fn.count?.total).toBe(2);
      return { before, unfiltered, closed, fn };
    },
  );
});
