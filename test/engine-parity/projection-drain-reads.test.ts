/**
 * BrainEngine parity — the projection drain's own reads (src/core/page-state/projections.ts): the queue backlog by
 * class, the drain preview, the drain clock, the limited drain's work probe and the planner row estimate.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: projectionBacklog counts the queue by class within a scope, previewProjectionDrain lists the rows a
 *    drain takes in its order, drainProjections rebuilds the queued pages and reports what is left, and a limited
 *    drain reports more work while a queued page remains. The answers are equal on every engine arm.
 *  - Regression: these reads (readProjectionBacklog, listProjectionDrainPreview, readDrainRunStart, isDrainClockPast,
 *    hasQueuedProjectionWork, readPagesRowEstimate) ran through `executeRaw`, which the Rust engine refuses, so
 *    `gbrain projections drain` and its preview stopped at once on a Rust brain while PGLite and Postgres ran them.
 *  - Why existing coverage misses it: test/projection-drain.test.ts and test/projection-image-drain.test.ts run on
 *    PGLite and Postgres only, and test/projection-rebuild-sql-pin.test.ts pins the Postgres text on a recording fake.
 *  - Seam: none; pages are written and queued through typed members. Times and ages differ between arms, so they are
 *    compared by shape and relation only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { drainProjections, previewProjectionDrain, projectionBacklog, queuePageProjection } from '../../src/core/page-state/projections.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const PAGE = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });
const PROTECTED_BODY = 'Scan of a receipt\n\n<!--- gbrain:facts:begin -->\n| fact |\n<!--- gbrain:facts:end -->';

/** Waits past the engine clock's resolution (PGLite's now() can repeat within a millisecond). */
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/** A backlog with its clock and age replaced by their shape. */
function shape(backlog: Awaited<ReturnType<typeof projectionBacklog>>) {
  const { as_of, oldest_age_seconds, ...counts } = backlog;
  return { ...counts, clock: typeof as_of === 'string' && as_of.length > 0, aged: oldest_age_seconds === null ? null : oldest_age_seconds >= 0 };
}

/** Two queued notes and a failed one in `default`, one queued note in an archived source, and a protected image. */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'gone');
  await engine.putPage('notes/a', PAGE('A', 'first queued body.'));
  await tick();
  await engine.putPage('notes/b', PAGE('B', 'second queued body.'));
  await engine.putPage('notes/failed', PAGE('Failed', 'a body that failed.'));
  const [failed] = (await engine.listQueuedPageProjections({ limit: 10 })).filter(j => j.slug === 'notes/failed');
  await engine.markProjectionRebuildFailed({ sourceIncarnation: failed!.source_incarnation, slug: 'notes/failed', revision: failed!.revision });
  await engine.putPage('images/receipt', { type: 'note', title: 'Receipt', compiled_truth: PROTECTED_BODY, timeline: '', page_kind: 'image' } as never);
  await engine.putPage('notes/gone', PAGE('Gone', 'an archived body.'), { sourceId: 'gone' } as never);
  await archiveSource(engine, backend, 'gone');
}

describe('engine parity: projection drain reads', () => {
  // Loss row 41: the image classes. A sealable image (safe fence, one image_asset chunk at index 0 holding the page's
  // text) is counted, previewed and sealed by a media drain; an image whose chunk no longer holds its text needs a
  // re-import; a protected image is never sealed. The drain's statistics refresh follows the row estimate.
  parityTest('the backlog, preview and a media drain class image pages as sealable, reimport or protected, and report the statistics refresh',
    { methods: ['putPage', 'upsertChunks', 'setChunkerVersion', 'readProjectionBacklog', 'listProjectionDrainPreview', 'hasDrainableProjectionJob',
      'hasQueuedProjectionWork', 'listImageSealWindow', 'readImageSealPages', 'listImageSealChunks', 'sealImagePages', 'readPagesRowEstimate',
      'readDrainRunStart', 'isDrainClockPast', 'getPage', 'transaction', 'lockPageKeys'] },
    async (engine) => {
      const image = async (slug: string, body: string, chunkText: string, version = 4) => {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', page_kind: 'image' } as never);
        await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: chunkText, chunk_source: 'image_asset', modality: 'image' } as never]);
        await engine.setChunkerVersion(slug, version);
      };
      await image('images/sealable', 'Photo of a heron', 'Photo of a heron');
      await image('images/changed', 'Photo of an ibex', 'an older caption');
      await image('images/pre-fence', 'Photo of a lynx', 'Photo of a lynx', 3);
      await image('images/receipt', PROTECTED_BODY, PROTECTED_BODY);
      await engine.putPage('notes/a', PAGE('A', 'a queued note.'));
      const before = shape(await projectionBacklog(engine));
      const preview = (await previewProjectionDrain(engine)).rows.map(r => ({ slug: r.slug, page_kind: r.page_kind }));
      const probes = { drainable: await engine.hasDrainableProjectionJob({ media: true }), work: await engine.hasQueuedProjectionWork({ media: true }) };
      const first = await drainProjections(engine, { media: true });
      const sealedPage = await engine.getPage('images/sealable');
      await image('images/second', 'Photo of an otter', 'Photo of an otter');
      const second = await drainProjections(engine, { media: true });
      const view = (r: typeof first) => ({ rebuilt: r.rebuilt, sealed: r.sealed, sealed_with_visual: r.sealed_with_visual, sealed_text_only: r.sealed_text_only,
        statistics_refreshed: r.statistics_refreshed, remaining: r.remaining, left: r.remaining_by_class && shape(r.remaining_by_class) });
      const out = { before, preview, probes, first: view(first), second: view(second),
        sealed: sealedPage?.text_projection_revision === sealedPage?.knowledge_revision };
      expect(out.before).toMatchObject({ pending: 1, sealable: 1, reimport: 2, protected: 1 });
      expect(out.preview.map(r => r.slug)).toEqual(['notes/a', 'images/sealable']);
      expect(out.first).toMatchObject({ rebuilt: 1, sealed: 1, statistics_refreshed: true });
      expect(out.second).toMatchObject({ sealed: 1, statistics_refreshed: false });
      return out;
    });

  parityTest('projectionBacklog counts the queue by class, within a source scope',
    { methods: ['putPage', 'listQueuedPageProjections', 'markProjectionRebuildFailed', 'readProjectionBacklog'] },
    async (engine, backend) => {
      const empty = shape(await projectionBacklog(engine));
      await seed(engine, backend);
      const out = {
        empty,
        all: shape(await projectionBacklog(engine)),
        scoped: shape(await projectionBacklog(engine, { sourceId: 'gone' })),
        listed: shape(await projectionBacklog(engine, { sourceIds: ['default'] })),
      };
      expect(out.all).toMatchObject({ pending: 3, failed: 1, protected: 1, archived: 1, sealable: 0, reimport: 0, clock: true, aged: true });
      expect(out.scoped).toMatchObject({ pending: 0, archived: 1, aged: null });
      return out;
    });

  parityTest('previewProjectionDrain lists the rows a drain takes, oldest first, at most the limit',
    { methods: ['putPage', 'listQueuedPageProjections', 'markProjectionRebuildFailed', 'readProjectionBacklog', 'listProjectionDrainPreview'] },
    async (engine, backend) => {
      await seed(engine, backend);
      const view = (p: Awaited<ReturnType<typeof previewProjectionDrain>>) => ({ pending: p.pending, protected: p.protected,
        rows: p.rows.map(r => ({ source_id: r.source_id, slug: r.slug, page_kind: r.page_kind, reason: r.reason, timed: typeof r.updated_at === 'string' })) });
      const out = { all: view(await previewProjectionDrain(engine)), one: view(await previewProjectionDrain(engine, 1)),
        floor: view(await previewProjectionDrain(engine, 0)) };
      expect(out.all.rows.map(r => r.slug)).toEqual(['notes/a', 'notes/b', 'notes/failed']);
      expect(out.one.rows.map(r => r.slug)).toEqual(['notes/a']);
      return out;
    });

  parityTest('drainProjections rebuilds the queued notes, and a limited drain reports the work it left',
    { methods: ['putPage', 'readDrainRunStart', 'isDrainClockPast', 'readProjectionBacklog', 'listQueuedPageProjections',
      'hasQueuedProjectionWork', 'getChunks', 'transaction'] },
    async (engine) => {
      await engine.putPage('notes/a', PAGE('A', 'first queued body about herons.'));
      await engine.putPage('notes/b', PAGE('B', 'second queued body about ibex.'));
      const limited = await drainProjections(engine, { limit: 1 });
      const rest = await drainProjections(engine);
      const out = {
        limited: { rebuilt: limited.rebuilt, remaining: limited.remaining, limited: limited.limited, failed: limited.failed.length },
        rest: { rebuilt: rest.rebuilt, remaining: rest.remaining, limited: rest.limited, failed: rest.failed.length },
        chunks: [(await engine.getChunks('notes/a')).length > 0, (await engine.getChunks('notes/b')).length > 0],
        backlog: shape(await projectionBacklog(engine)),
      };
      expect(out).toMatchObject({ limited: { rebuilt: 1, remaining: 1, limited: true }, rest: { rebuilt: 1, remaining: 0, limited: false },
        chunks: [true, true] });
      return out;
    });

  parityTest('the drain clock moves past its run start, the work probe sees any queued page, and the row estimate is a number',
    { methods: ['putPage', 'readDrainRunStart', 'isDrainClockPast', 'hasQueuedProjectionWork', 'readPagesRowEstimate', 'queuePageProjectionJob',
      'listQueuedPageProjections', 'markProjectionRebuildFailed'] },
    async (engine) => {
      const before = await engine.hasQueuedProjectionWork();
      const runStart = await engine.readDrainRunStart();
      await tick();
      const passed = await engine.isDrainClockPast(runStart);
      const future = await engine.isDrainClockPast('2999-01-01 00:00:00+00');
      await engine.putPage('notes/a', PAGE('A', 'a queued body.'));
      const queued = await engine.hasQueuedProjectionWork();
      const [job] = await engine.listQueuedPageProjections({ limit: 10 });
      await engine.markProjectionRebuildFailed({ sourceIncarnation: job!.source_incarnation, slug: 'notes/a', revision: job!.revision });
      const failed = await engine.hasQueuedProjectionWork();
      await queuePageProjection(engine, 'default', 'notes/a', 'safe_chunk_reseal');
      const estimate = await engine.readPagesRowEstimate();
      const out = { before, clock: typeof runStart === 'string' && runStart.length > 0, passed, future, queued, failed,
        estimate: Number.isFinite(estimate) && estimate >= 0 };
      expect(out).toEqual({ before: false, clock: true, passed: true, future: false, queued: true, failed: true, estimate: true });
      return out;
    });
});
