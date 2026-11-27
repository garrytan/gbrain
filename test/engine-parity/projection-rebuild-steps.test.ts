/**
 * BrainEngine parity — the deferred chunk replacement (continueDeferredProjectionStep in
 * src/core/page-state/projections.ts) and the rebuild loop's queue stamps (rebuildPendingPageProjections).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a deferred replacement of a page whose chunks moved seals in one step when its moves fit the budget, or
 *    answers `more` and claims its job when they do not; a second continuation with its own token answers `held`
 *    while that claim is fresh, and the first continuation then seals. The sealed page keeps the chunk the new body
 *    still holds (with its vector when the model matches), loses the others, and leaves no job. The rebuild loop
 *    seals a job queued for a deferred replacement, answers a job another continuation holds as superseded, and its
 *    stamps (re-key, deferred stamp in both modes, unclaimed touch, defer, failed mark) change only the job at its
 *    revision. The re-seal's pending count (resealSafeChunks) counts the page's text chunks without a vector and
 *    their characters. The resident's window selection probes each candidate's source and live page by key and
 *    rebuilds a queued page. The answers are equal on every engine arm.
 *  - Regression: the step read the page head, the held probe, the row fingerprint, the stale vector list and ran the
 *    claim renewal, the unkept delete and the vector clear through `executeRaw`, which the Rust engine refuses
 *    (`This brain's engine does not support executeRaw yet`). The rebuild loop's stamps did the same, so a Rust
 *    brain could not finish a deferred replacement or stamp its queue while PGLite and Postgres did. The re-seal's
 *    pending count was raw too, so every resealSafeChunks call (an extraction receipt's page write) failed on Rust, and so did the window probe, which every resident projection
 *    pass (runResidentProjectionInvocation) runs.
 *  - Why existing coverage misses it: test/timeline-chunk-reuse.test.ts runs the replacement on PGLite and Postgres
 *    only, and test/projection-rebuild-sql-pin.test.ts pins the Postgres text on a recording fake with no database.
 *  - Seam: these cases set a deferred job's reason with renewDeferredReplacementClaim, the member the step itself uses
 *    to claim it; queuePageProjection (the typed queuePageProjectionJob) has its own case. Ids and
 *    revisions differ between arms, so they are compared only as changed or equal.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ProjectionJobKey } from '../../src/core/engine-sql/projection-rebuild.ts';
import { continueDeferredProjection, continueDeferredProjectionStep, DEFERRED_CHUNK_CLAIM, DEFERRED_CHUNK_REPLACEMENT,
  queuePageProjection, rebuildPendingPageProjections, resealSafeChunks } from '../../src/core/page-state/projections.ts';
import { newProjectionScanCursor } from '../../src/core/page-state/projection-window.ts';
import { basisEmbedding, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pageMeta } from '../helpers/page-body-fixtures.ts';
import { chunk } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());
const PAGE = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });
const OTHER_REVISION = '00000000-0000-4000-8000-000000000001';

/** Waits past the engine clock's resolution (PGLite's now() can repeat within a millisecond), so a stamp moves the time. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/** The page's chunks as index, text and whether a vector is stored. */
async function chunks(engine: BrainEngine, slug: string, includeUnsealed = true) {
  return (await engine.getChunks(slug, { includeUnsealed })).map(c => [c.chunk_index, c.chunk_text, c.embedded_at !== null]);
}

/** The one queued job of `slug`, as a job key. */
async function jobOf(engine: BrainEngine, slug: string): Promise<ProjectionJobKey> {
  const jobs = (await engine.listQueuedPageProjections({ limit: 10 })).filter(j => j.slug === slug);
  expect(jobs.length).toBe(1);
  return { sourceIncarnation: jobs[0]!.source_incarnation, slug, revision: jobs[0]!.revision };
}

/** A page whose second chunk now holds the text the body starts with: one move and one dropped chunk. */
async function movingPage(engine: BrainEngine, slug: string) {
  await engine.putPage(slug, PAGE('Moving', 'a moving passage about ibex.'));
  await engine.upsertChunks(slug, [chunk(0, 'an old passage.'), chunk(1, 'a moving passage about ibex.', { embedding: basisEmbedding(4) })]);
}

describe('engine parity: the deferred chunk replacement', () => {
  parityTest('seals in one step, keeps the chunk the body still holds and leaves no job',
    { methods: ['putPage', 'upsertChunks', 'getChunks', 'listQueuedPageProjections', 'transaction', 'lockPageKeys', 'readProjectionHead',
      'isDeferredReplacementHeld', 'deleteUnkeptChunks', 'listStaleChunkVectors', 'clearChunkVectors', 'deleteProjectionJob'] },
    async (engine) => {
      await engine.putPage('notes/deferred', PAGE('Deferred', 'a kept passage about herons.'));
      await engine.upsertChunks('notes/deferred', [chunk(0, 'a kept passage about herons.', { embedding: basisEmbedding(3), model: 'other-model' }),
        chunk(1, 'a dropped passage.')]);
      const queued = (await engine.listQueuedPageProjections({ limit: 10 })).map(j => j.slug);
      const step = await continueDeferredProjectionStep(engine, 'default', 'notes/deferred');
      const out = {
        queued, step, after: await chunks(engine, 'notes/deferred'),
        left: (await engine.listQueuedPageProjections({ limit: 10 })).length,
        again: await continueDeferredProjectionStep(engine, 'default', 'notes/deferred'),
        rebuild: await rebuildPendingPageProjections(engine, 10),
      };
      expect(out).toEqual({ queued: ['notes/deferred'], step: 'sealed', after: [[0, 'a kept passage about herons.', false]], left: 0,
        again: 'skipped', rebuild: { rebuilt: 0, superseded: 0 } });
      return out;
    });

  parityTest('answers more and claims the job, holds a second token off, then seals',
    { methods: ['putPage', 'upsertChunks', 'getChunks', 'listQueuedPageProjections', 'readProjectionJobReason', 'transaction', 'lockPageKeys',
      'readProjectionHead', 'isDeferredReplacementHeld', 'readChunkRowsFingerprint', 'renewDeferredReplacementClaim', 'deleteProjectionJob'] },
    async (engine) => {
      await movingPage(engine, 'notes/moving');
      const state: { token?: string } = {};
      const first = await continueDeferredProjectionStep(engine, 'default', 'notes/moving', state, 0);
      const mid = await chunks(engine, 'notes/moving');
      const reason = await engine.readProjectionJobReason(await jobOf(engine, 'notes/moving'));
      const other = await continueDeferredProjectionStep(engine, 'default', 'notes/moving', {}, 0);
      const last = await continueDeferredProjectionStep(engine, 'default', 'notes/moving', state);
      const out = { first, mid, claimed: reason === `${DEFERRED_CHUNK_CLAIM}:${state.token}`, other, last,
        end: await chunks(engine, 'notes/moving', false), left: (await engine.listQueuedPageProjections({ limit: 10 })).length };
      expect(out).toEqual({ first: 'more', mid: [[1, 'a moving passage about ibex.', true]], claimed: true, other: 'held', last: 'sealed',
        end: [[0, 'a moving passage about ibex.', true]], left: 0 });
      return out;
    });
});

describe('engine parity: the rebuild loop on a deferred job', () => {
  parityTest('seals a job queued for a deferred replacement',
    { methods: ['putPage', 'upsertChunks', 'getChunks', 'listQueuedPageProjections', 'renewDeferredReplacementClaim', 'readProjectionJobReason',
      'readProjectionHead', 'isDeferredReplacementHeld', 'deleteProjectionJob'] },
    async (engine) => {
      await movingPage(engine, 'notes/moving');
      await engine.renewDeferredReplacementClaim(await jobOf(engine, 'notes/moving'), DEFERRED_CHUNK_REPLACEMENT);
      const rebuild = await rebuildPendingPageProjections(engine, 10);
      const out = { rebuild, end: await chunks(engine, 'notes/moving', false), left: (await engine.listQueuedPageProjections({ limit: 10 })).length };
      expect(out).toEqual({ rebuild: { rebuilt: 1, superseded: 0 }, end: [[0, 'a moving passage about ibex.', true]], left: 0 });
      return out;
    });

  parityTest("the resident's window selection rebuilds a queued page",
    { methods: ['putPage', 'listQueuedPageProjections', 'selectProjectionWindowJobs', 'probeProjectionWindowCandidates', 'readProjectionJobReason',
      'deleteProjectionJob'] },
    async (engine) => {
      await engine.putPage('notes/window', PAGE('Window', 'a passage about lynx.'));
      const rebuild = await rebuildPendingPageProjections(engine, 10, { window: newProjectionScanCursor() });
      const out = { rebuild, end: await chunks(engine, 'notes/window', false), left: (await engine.listQueuedPageProjections({ limit: 10 })).length };
      expect(out).toEqual({ rebuild: { rebuilt: 1, superseded: 0 }, end: [[0, 'a passage about lynx.', false]], left: 0 });
      return out;
    });

  parityTest('answers a job another continuation holds as superseded and leaves its claim',
    { methods: ['putPage', 'upsertChunks', 'listQueuedPageProjections', 'renewDeferredReplacementClaim', 'readProjectionJobReason',
      'readProjectionHead', 'isDeferredReplacementHeld'] },
    async (engine) => {
      await movingPage(engine, 'notes/moving');
      const job = await jobOf(engine, 'notes/moving');
      const claim = `${DEFERRED_CHUNK_CLAIM}:another`;
      await engine.renewDeferredReplacementClaim(job, claim);
      const rebuild = await rebuildPendingPageProjections(engine, 10);
      const out = { rebuild, kept: (await engine.readProjectionJobReason(job)) === claim };
      expect(out).toEqual({ rebuild: { rebuilt: 0, superseded: 1 }, kept: true });
      return out;
    });
});

describe('engine parity: queuing a page projection', () => {
  // queuePageProjection (a re-seal, a trust change, an embedding recovery, a deferred chunk replacement) queues the
  // live page at its revision with its reason, or moves its queued row to that reason at now; a gone page queues nothing.
  parityTest('queuePageProjection queues a live page with its reason, moves a queued row and skips a deleted page',
    { methods: ['putPage', 'softDeletePage', 'listQueuedPageProjections', 'readProjectionJobReason', 'queuePageProjectionJob',
      'deleteProjectionJob', 'readProjectionHead'] },
    async (engine) => {
      await engine.putPage('notes/queued', PAGE('Queued', 'a queued body.'));
      await engine.putPage('notes/gone', PAGE('Gone', 'a gone body.'));
      await engine.softDeletePage('notes/gone');
      const first = await jobOf(engine, 'notes/queued');
      await engine.deleteProjectionJob({ sourceIncarnation: first.sourceIncarnation, slug: first.slug, revision: first.revision });
      const before = (await engine.listQueuedPageProjections({ limit: 10 })).map(j => j.slug);
      await queuePageProjection(engine, 'default', 'notes/queued', 'safe_chunk_reseal');
      await queuePageProjection(engine, 'default', 'notes/gone', 'safe_chunk_reseal');
      await queuePageProjection(engine, 'default', 'notes/missing', 'safe_chunk_reseal');
      const queued = await jobOf(engine, 'notes/queued');
      const head = await engine.readProjectionHead('default', 'notes/queued');
      const reason = await engine.readProjectionJobReason(queued);
      await tick();
      await queuePageProjection(engine, 'default', 'notes/queued', 'trust_tier_changed');
      const out = {
        before, atRevision: queued.revision === head?.revision, reason,
        moved: await engine.readProjectionJobReason(queued),
        slugs: (await engine.listQueuedPageProjections({ limit: 10 })).map(j => j.slug),
      };
      expect(out).toEqual({ before: [], atRevision: true, reason: 'safe_chunk_reseal', moved: 'trust_tier_changed', slugs: ['notes/queued'] });
      return out;
    });
});

describe('engine parity: a continuation hands its claim back', () => {
  // continueDeferredProjection releases its claim when it stops early or fails, so the next drain resumes the page.
  parityTest('the release gives back only the matching claim, in any source',
    { methods: ['putPage', 'upsertChunks', 'listQueuedPageProjections', 'renewDeferredReplacementClaim', 'readProjectionJobReason',
      'releaseDeferredReplacementClaim'] },
    async (engine) => {
      await movingPage(engine, 'notes/moving');
      const job = await jobOf(engine, 'notes/moving');
      const claim = `${DEFERRED_CHUNK_CLAIM}:mine`;
      await engine.renewDeferredReplacementClaim(job, claim);
      await engine.releaseDeferredReplacementClaim('notes/moving', `${DEFERRED_CHUNK_CLAIM}:theirs`);
      await engine.releaseDeferredReplacementClaim('notes/other', claim);
      const kept = await engine.readProjectionJobReason(job);
      await engine.releaseDeferredReplacementClaim('notes/moving', claim);
      const out = { kept: kept === claim, released: await engine.readProjectionJobReason(job) };
      expect(out).toEqual({ kept: true, released: DEFERRED_CHUNK_REPLACEMENT });
      return out;
    });

  parityTest('a continuation that its time budget stops hands its claim back to the drain',
    { methods: ['putPage', 'upsertChunks', 'getChunks', 'listQueuedPageProjections', 'readProjectionJobReason', 'transaction', 'lockPageKeys',
      'readProjectionHead', 'isDeferredReplacementHeld', 'readChunkRowsFingerprint', 'renewDeferredReplacementClaim',
      'releaseDeferredReplacementClaim', 'deleteProjectionJob'] },
    async (engine) => {
      // A body of many chunks, stored again each one index later than the body puts it: more moves than one step's budget.
      const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(' ');
      const para = (seed: number) => Array.from({ length: 300 }, (_, i) => words[(seed * 7 + i * 5) % words.length]).join(' ') + '.';
      const text = Array.from({ length: 10 }, (_, i) => para(i)).join('\n\n');
      await engine.putPage('notes/long-move', PAGE('Long move', text));
      await rebuildPendingPageProjections(engine, 10);
      const sealed = await engine.getChunks('notes/long-move');
      await engine.putPage('notes/long-move', PAGE('Long move again', text));
      await engine.upsertChunks('notes/long-move', [chunk(0, 'an old opening passage.'),
        ...sealed.map(c => chunk(c.chunk_index + 1, c.chunk_text, { embedding: basisEmbedding(c.chunk_index + 1) }))]);
      const body = sealed.length > 5;
      const job = await jobOf(engine, 'notes/long-move');
      const stopped = await continueDeferredProjection(engine, 'default', 'notes/long-move', () => true);
      const out = { body, stopped, reason: await engine.readProjectionJobReason(job) };
      expect(out).toEqual({ body: true, stopped: 'more', reason: DEFERRED_CHUNK_REPLACEMENT });
      return out;
    });
});

describe('engine parity: the rebuild loop queue stamps', () => {
  parityTest('the segmented probe answers only a live segmented page',
    { methods: ['putPage', 'createSegmentedPageShell', 'hasSegmentedPage', 'deletePage'] },
    async (engine) => {
      await engine.putPage('notes/inline', PAGE('Inline', 'inline body.'));
      await engine.createSegmentedPageShell('notes/big', pageMeta('Big page'), { sourceId: 'default' });
      const before = await Promise.all(['notes/inline', 'notes/big', 'notes/none'].map(s => engine.hasSegmentedPage('default', s)));
      const otherSource = await engine.hasSegmentedPage('no-such-source', 'notes/big');
      await engine.deletePage('notes/big');
      const out = { before, otherSource, deleted: await engine.hasSegmentedPage('default', 'notes/big') };
      expect(out).toEqual({ before: [false, true, false], otherSource: false, deleted: false });
      return out;
    });

  parityTest("the window probe finds each candidate's source and live page by key",
    { methods: ['putPage', 'createSegmentedPageShell', 'deletePage', 'listQueuedPageProjections', 'probeProjectionWindowCandidates'] },
    async (engine) => {
      await engine.putPage('notes/live', PAGE('Live', 'live body.'));
      await engine.putPage('notes/gone', PAGE('Gone', 'gone body.'));
      await engine.createSegmentedPageShell('notes/big', pageMeta('Big page'), { sourceId: 'default' });
      const incarnation = (await jobOf(engine, 'notes/live')).sourceIncarnation;
      await engine.deletePage('notes/gone');
      const probed = await engine.probeProjectionWindowCandidates(['notes/live', 'notes/gone', 'notes/big', 'notes/none'].map(slug =>
        ({ source_incarnation: incarnation, slug })).concat([{ source_incarnation: OTHER_REVISION, slug: 'notes/live' }]));
      const out = { probed: probed.map(row => ({ ...row, i: Number(row.i) })).sort((a, b) => a.i - b.i),
        none: await engine.probeProjectionWindowCandidates([]) };
      const live = { source_id: 'default', archived: false };
      const missing = { page_kind: null, body_storage: null };
      expect(out).toEqual({ probed: [
        { i: 0, ...live, page_kind: 'markdown', body_storage: 'inline' },
        { i: 1, ...live, ...missing },
        { i: 2, ...live, page_kind: 'markdown', body_storage: 'segmented' },
        { i: 3, ...live, ...missing },
        { i: 4, source_id: null, archived: null, ...missing },
      ], none: [] });
      return out;
    });

  parityTest('re-keys, stamps and defers only the job at its revision',
    { methods: ['putPage', 'listQueuedPageProjections', 'readProjectionJobReason', 'rekeyProjectionJob', 'stampDeferredProjectionJob',
      'deferProjectionJob', 'renewDeferredReplacementClaim'] },
    async (engine) => {
      await engine.putPage('notes/a', PAGE('A', 'body.'));
      const job = await jobOf(engine, 'notes/a');
      const stale = { ...job, revision: OTHER_REVISION };
      const updated = async () => (await engine.listQueuedPageProjections({ limit: 10 })).find(j => j.slug === 'notes/a')!.updated_at!;
      const reason = async (key: ProjectionJobKey) => engine.readProjectionJobReason(key);
      const t0 = await updated();
      const deferStale = await engine.deferProjectionJob(stale);
      const t1 = await updated();
      await tick();
      const defer = await engine.deferProjectionJob(job);
      const t2 = await updated();
      await engine.renewDeferredReplacementClaim(job, DEFERRED_CHUNK_REPLACEMENT);
      await engine.stampDeferredProjectionJob(stale, true);
      const keptByStale = await reason(job);
      await engine.stampDeferredProjectionJob(job, false);
      const keptByMore = await reason(job);
      await engine.stampDeferredProjectionJob(job, true);
      const requeued = await reason(job);
      await engine.rekeyProjectionJob(stale, job.revision);
      const rekeyStale = (await jobOf(engine, 'notes/a')).revision === job.revision;
      await engine.rekeyProjectionJob(job, OTHER_REVISION);
      const out = {
        deferStale, staleKeptTime: t1 === t0, defer, deferMoved: t2 > t1,
        keptByStale, keptByMore, requeued, rekeyStale,
        rekeyed: (await jobOf(engine, 'notes/a')).revision === OTHER_REVISION,
        oldKey: await reason(job), newKey: await reason(stale),
      };
      expect(out).toEqual({ deferStale: false, staleKeptTime: true, defer: true, deferMoved: true,
        keptByStale: DEFERRED_CHUNK_REPLACEMENT, keptByMore: DEFERRED_CHUNK_REPLACEMENT, requeued: 'canonical_change', rekeyStale: true,
        rekeyed: true, oldKey: null, newKey: 'canonical_change' });
      return out;
    });

  parityTest('the unclaimed touch leaves a live segmented claim alone and the failed mark lands only unclaimed',
    { methods: ['putPage', 'listQueuedPageProjections', 'readProjectionJobReason', 'claimSegmentedProjection', 'releaseSegmentedProjectionClaim',
      'touchUnclaimedProjectionJob', 'markProjectionRebuildFailed'] },
    async (engine) => {
      await engine.putPage('notes/a', PAGE('A', 'body.'));
      const job = await jobOf(engine, 'notes/a');
      const ref = { sourceId: 'default', slug: 'notes/a' };
      const updated = async () => (await engine.listQueuedPageProjections({ limit: 10 })).find(j => j.slug === 'notes/a')!.updated_at!;
      const claim = 'segmented_projecting:mine';
      const claimed = await engine.claimSegmentedProjection(ref, claim);
      const t0 = await updated();
      await engine.touchUnclaimedProjectionJob(job);
      const t1 = await updated();
      await engine.markProjectionRebuildFailed(job);
      const whileClaimed = await engine.readProjectionJobReason(job);
      await engine.releaseSegmentedProjectionClaim(ref, claim);
      const t2 = await updated();
      await tick();
      await engine.touchUnclaimedProjectionJob(job);
      const t3 = await updated();
      await engine.markProjectionRebuildFailed({ ...job, revision: OTHER_REVISION });
      const staleMark = await engine.readProjectionJobReason(job);
      await engine.markProjectionRebuildFailed(job);
      const out = { claimed, claimedKeptTime: t1 === t0, whileClaimed: whileClaimed === claim, touched: t3 > t2,
        staleMark, failed: await engine.readProjectionJobReason(job) };
      expect(out).toEqual({ claimed: 'claimed', claimedKeptTime: true, whileClaimed: true, touched: true,
        staleMark: 'canonical_change', failed: 'rebuild_failed' });
      return out;
    });

  parityTest("the re-seal's pending count counts only the page's text chunks without a vector, in characters",
    { methods: ['putPage', 'upsertChunks', 'readProjectionHead', 'countPendingTextChunks'] },
    async (engine) => {
      await engine.putPage('notes/pending', PAGE('Pending', 'body.'));
      await engine.putPage('notes/other', PAGE('Other', 'body.'));
      await engine.upsertChunks('notes/pending', [chunk(0, 'embedded.', { embedding: basisEmbedding(1) }), chunk(1, 'twö!'),
        chunk(2, 'an image caption.', { modality: 'image' }), chunk(3, 'more.')]);
      await engine.upsertChunks('notes/other', [chunk(0, 'another page.')]);
      const column = { name: 'embedding', dimensions: basisEmbedding(1).length };
      const id = (await engine.readProjectionHead('default', 'notes/pending'))!.id;
      const out = { pending: await engine.countPendingTextChunks(id, column),
        none: await engine.countPendingTextChunks(id + 100000, column) };
      expect(out).toEqual({ pending: { chunks: 2, chars: 9 }, none: { chunks: 0, chars: 0 } });
      return out;
    });

  parityTest('resealSafeChunks seals the page, reports the chunks still waiting for a vector, and skips a sealed page',
    { methods: ['putPage', 'getChunks', 'transaction', 'readChunkKeepState', 'clearUnkeptChunkVectors', 'countPendingTextChunks'] },
    async (engine) => {
      await engine.putPage('notes/reseal', PAGE('Reseal', 'a passage about otters.\n\nanother passage about voles.'));
      const out = { first: await resealSafeChunks(engine, 'notes/reseal', 'default'), chunks: await chunks(engine, 'notes/reseal', false),
        again: await resealSafeChunks(engine, 'notes/reseal', 'default') };
      expect(out).toEqual({ first: { pendingChunks: 1, pendingChars: 53 },
        chunks: [[0, 'a passage about otters.\n\nanother passage about voles.', false]], again: null });
      return out;
    });
});
