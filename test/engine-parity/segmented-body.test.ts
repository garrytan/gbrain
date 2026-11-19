/**
 * BrainEngine parity — segmented page bodies (Wave B storage: segment texts,
 * manifest generations, stagings, the generation flip, GC sweep and
 * per-segment derivation watermarks).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: building, replacing and sweeping a segmented page gives the
 *    same manifest, texts, chunks, refusals and sweep counts on every engine
 *    arm (PGLite always; Postgres with DATABASE_URL; Rust later through
 *    test/engine-parity/harness.ts).
 *  - Regression: an engine that publishes a different live generation,
 *    accepts a stale flip, keeps or drops the wrong rows in a sweep, or
 *    loses a derivation watermark: large-page reads and incremental
 *    pipelines then disagree between engines.
 *  - Why existing coverage misses it: test/large-pages/segment-gc.test.ts and
 *    test/e2e/segment-gc-parity.test.ts run the same cases per engine but
 *    never compare the two engines' observables; the e2e arm skips without
 *    Postgres.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 *    Occurrence and page ids come from sequences that a reset does not
 *    rewind on Postgres, so observables map them to ordinals.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ManifestRow, SegmentTextInput } from '../../src/core/page-body/types.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, flipInput, hexOf, manifestRow, pageMeta, segmentText, sha256, stagingInput } from '../helpers/page-body-fixtures.ts';
import { parityArms, sorted } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const ONE = segmentText('# Intro\nfirst segment of the page\n');
const TWO = segmentText('## Middle\nsecond segment, kept across the replace\n');
const THREE = segmentText('## End\nthird segment, retired by the replace\n');
const FOUR = segmentText('## New end\nfourth segment, added by the replace\n');

/** Manifest rows with ids mapped to ordinals of `occurrences` and bytes to hex. */
function manifestView(rows: readonly ManifestRow[], occurrences: readonly number[]) {
  return rows.map((r) => ({
    occurrence: occurrences.indexOf(Number(r.occurrenceId)),
    genFrom: Number(r.genFrom),
    genTo: r.genTo === null ? null : Number(r.genTo),
    seq: Number(r.seq),
    region: r.region,
    sha256: hexOf(r.sha256),
    byteStart: Number(r.byteStart),
    byteLen: Number(r.byteLen),
    cutKind: r.cutKind,
    entryState: r.entryState,
    outline: r.outline,
    dateMin: r.dateMin,
    dateMax: r.dateMax,
    staged: r.stagingId !== null,
  }));
}

/** Stage `texts` (in order) as a generation of `pageId` inside one transaction; returns the staging id. */
async function stage(engine: BrainEngine, input: { pageId: number; slug: string; genFrom: number; texts: readonly SegmentTextInput[];
  occurrences: readonly number[]; chunks?: boolean }) {
  const staging = stagingInput({ slug: input.slug, pageId: input.pageId, mode: input.genFrom === 1 ? 'create' : 'replace' });
  const inserted = await engine.transaction(async (tx) => {
    await tx.openBodyStaging(staging);
    const { inserted: n } = await tx.stageSegmentTexts('default', input.texts, { stagingId: staging.id });
    let byteStart = 0;
    await tx.stageManifestRows(input.texts.map((text, seq) => {
      const row = manifestRow({ pageId: input.pageId, occurrenceId: input.occurrences[seq]!, genFrom: input.genFrom, seq, text, byteStart, stagingId: staging.id });
      byteStart += text.body.byteLength;
      return row;
    }));
    if (input.chunks) {
      const indexes = await tx.stageSegmentChunks(input.pageId, input.genFrom,
        input.texts.map((text, i) => chunk(input.occurrences[i]!, 0, new TextDecoder().decode(text.body))));
      expect(indexes.length).toBe(input.texts.length);
    }
    return n;
  });
  return { stagingId: staging.id, inserted };
}

/** Publish ONE, TWO, THREE as generation 1 of `notes/big`. */
async function publish(engine: BrainEngine, opts: { chunks?: boolean } = {}) {
  const { id: pageId } = await engine.createSegmentedPageShell('notes/big', pageMeta('Big page'), { sourceId: 'default' });
  const occurrences = await engine.allocateBodyOccurrenceIds(3);
  const texts = [ONE, TWO, THREE];
  const { stagingId, inserted } = await stage(engine, { pageId, slug: 'notes/big', genFrom: 1, texts, occurrences, chunks: opts.chunks });
  const flip = await engine.transaction(async (tx) => {
    const result = await tx.flipBodyGeneration(flipInput(pageId, 0, stagingId, texts));
    await tx.setBodyStagingState(stagingId, 'committed');
    return result;
  });
  return { pageId, occurrences, inserted, flip };
}

describe('engine parity: segmented page bodies', () => {
  parityTest(
    'a segmented page publishes generation 1 from staged texts and manifest rows',
    { methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows',
      'flipBodyGeneration', 'setBodyStagingState', 'readManifest', 'readSegmentTexts', 'transaction'] },
    async (engine) => {
      const shellOnly = await engine.createSegmentedPageShell('notes/shell', pageMeta('Shell'), { sourceId: 'default' });
      const shellManifest = await engine.readManifest(shellOnly.id);
      const { pageId, occurrences, inserted, flip } = await publish(engine);
      const ids = new Set(occurrences);
      expect(ids.size).toBe(3);
      const live = manifestView(await engine.readManifest(pageId), occurrences);
      expect(live.map((r) => r.occurrence)).toEqual([0, 1, 2]);
      expect(live.every((r) => r.genTo === null && !r.staged)).toBe(true);
      const tail = manifestView(await engine.readManifest(pageId, { lastN: 1 }), occurrences);
      const gen1 = manifestView(await engine.readManifest(pageId, { generation: 1 }), occurrences);
      const timeline = await engine.readManifest(pageId, { region: 'timeline' });
      const texts = await engine.readSegmentTexts('default', [ONE.sha256, THREE.sha256, sha256('absent')]);
      expect(sorted([...texts.keys()])).toEqual(sorted([hexOf(ONE.sha256), hexOf(THREE.sha256)]));
      expect(new TextDecoder().decode(texts.get(hexOf(ONE.sha256))!)).toBe('# Intro\nfirst segment of the page\n');
      const again = await engine.stageSegmentTexts('default', [ONE, FOUR]);
      expect(again.inserted).toBe(1);
      const otherSource = await engine.readSegmentTexts('no-such-source', [ONE.sha256]);
      const page = await engine.getPage('notes/big');
      return {
        shellManifest: shellManifest.length,
        inserted,
        flip,
        live,
        tail,
        gen1Matches: JSON.stringify(gen1) === JSON.stringify(live),
        timeline: timeline.length,
        texts: sorted([...texts].map(([k, v]) => `${k}:${v.byteLength}`)),
        again,
        otherSource: otherSource.size,
        page: page ? { slug: page.slug, title: page.title, type: page.type } : null,
      };
    },
  );

  parityTest(
    'a replace flips to generation 2, closes retired rows and refuses a stale generation',
    { methods: ['flipBodyGeneration', 'readManifest', 'stageSegmentChunks', 'getChunks'] },
    async (engine) => {
      const { pageId, occurrences } = await publish(engine, { chunks: true });
      const chunksBefore = (await engine.getChunks('notes/big')).map((c) => c.chunk_text);
      const [newOcc] = await engine.allocateBodyOccurrenceIds(1);
      const all = [...occurrences, newOcc!];
      // Keep ONE and TWO (same occurrences, same offsets), retire THREE, add FOUR.
      const staging = stagingInput({ slug: 'notes/big', pageId, mode: 'replace', baseGeneration: 1 });
      await engine.transaction(async (tx) => {
        await tx.openBodyStaging(staging);
        await tx.stageSegmentTexts('default', [FOUR]);
        await tx.stageManifestRows([manifestRow({ pageId, occurrenceId: newOcc!, genFrom: 2, seq: 2, text: FOUR,
          byteStart: ONE.body.byteLength + TWO.body.byteLength, stagingId: staging.id })]);
        await tx.stageSegmentChunks(pageId, 2, [chunk(newOcc!, 0, new TextDecoder().decode(FOUR.body))]);
      });
      let stale: string | null = null;
      try {
        await engine.transaction((tx) => tx.flipBodyGeneration(flipInput(pageId, 0, staging.id, [ONE, TWO, FOUR])));
      } catch (error) {
        stale = (error as { code?: string }).code ?? (error instanceof Error ? error.constructor.name : 'threw');
      }
      expect(stale).not.toBeNull();
      const flip = await engine.transaction(async (tx) => {
        const result = await tx.flipBodyGeneration(flipInput(pageId, 1, staging.id, [ONE, TWO, FOUR],
          { closeOccurrences: [occurrences[2]!], retireChunkOccurrences: [occurrences[2]!] }));
        await tx.setBodyStagingState(staging.id, 'committed');
        return result;
      });
      const live = manifestView(await engine.readManifest(pageId), all);
      expect(live.map((r) => r.occurrence)).toEqual([0, 1, 3]);
      const gen1 = manifestView(await engine.readManifest(pageId, { generation: 1 }), all);
      const chunksAfter = sorted((await engine.getChunks('notes/big')).map((c) => c.chunk_text));
      return { chunksBefore: sorted(chunksBefore), stale, flip, live, gen1, chunksAfter };
    },
  );

  parityTest(
    'sweepSegments deletes closed rows and unreferenced texts and expires stale stagings',
    { methods: ['sweepSegments', 'readSegmentTexts', 'openBodyStaging', 'readManifest'] },
    async (engine) => {
      const { pageId, occurrences } = await publish(engine);
      const orphan = segmentText('orphan text no manifest row references\n');
      await engine.stageSegmentTexts('default', [orphan]);
      const inGrace = await engine.sweepSegments({ sourceId: 'default' });
      const graceKept = (await engine.readSegmentTexts('default', [orphan.sha256])).size;
      const swept = await engine.sweepSegments({ sourceId: 'default', graceMs: 0 });
      const orphanGone = (await engine.readSegmentTexts('default', [orphan.sha256])).size;
      const liveKept = (await engine.readSegmentTexts('default', [ONE.sha256, TWO.sha256, THREE.sha256])).size;
      // An open staging past its deadlines expires; its staged rows go with it.
      const [occ] = await engine.allocateBodyOccurrenceIds(1);
      const staging = stagingInput({ slug: 'notes/big', pageId, mode: 'replace', baseGeneration: 1 });
      await engine.openBodyStaging(staging);
      await engine.stageSegmentTexts('default', [FOUR], { stagingId: staging.id });
      await engine.stageManifestRows([manifestRow({ pageId, occurrenceId: occ!, genFrom: 2, seq: 3, text: FOUR, byteStart: 999, stagingId: staging.id })]);
      const stagedBefore = (await engine.readManifest(pageId, { stagingId: staging.id })).length;
      const notExpired = await engine.sweepSegments({ sourceId: 'default', expireStagings: true });
      const expired = await engine.sweepSegments({ sourceId: 'default', expireStagings: true, now: new Date(Date.now() + 30 * 86_400_000) });
      const stagedAfter = (await engine.readManifest(pageId, { stagingId: staging.id })).length;
      const live = manifestView(await engine.readManifest(pageId), occurrences).map((r) => r.occurrence);
      return { inGrace, graceKept, swept, orphanGone, liveKept, stagedBefore, notExpired, expired, stagedAfter, live };
    },
  );

  parityTest(
    'segment derivations upsert by (page, kind, occurrence), read in order and retire dead occurrences',
    { methods: ['upsertSegmentDerivations', 'readSegmentDerivations', 'retireSegmentDerivations'] },
    async (engine) => {
      const { pageId, occurrences } = await publish(engine);
      const row = (kind: 'links' | 'timeline', i: number, state: 'done' | 'failed', output: unknown) => ({
        pageId, kind, occurrenceId: occurrences[i]!, version: 1, segmentSha256: sha256(`seg:${i}`), contextHash: sha256(`ctx:${kind}`),
        state, output, receipt: { n: i },
      });
      await engine.upsertSegmentDerivations([row('links', 0, 'done', ['a']), row('links', 1, 'failed', []), row('links', 2, 'done', ['c']),
        row('timeline', 0, 'done', { dates: 1 })]);
      await engine.upsertSegmentDerivations([{ ...row('links', 1, 'done', ['b']), version: 2 }]);
      const view = (rows: Awaited<ReturnType<BrainEngine['readSegmentDerivations']>>) => rows.map((r) => ({
        kind: r.kind, occurrence: occurrences.indexOf(Number(r.occurrenceId)), version: Number(r.version), state: r.state,
        output: r.output, receipt: r.receipt, sha: hexOf(r.segmentSha256), ctx: hexOf(r.contextHash), stamped: typeof r.createdAt === 'string' && typeof r.updatedAt === 'string',
      }));
      const all = view(await engine.readSegmentDerivations(pageId));
      const links = view(await engine.readSegmentDerivations(pageId, { kind: 'links', occurrenceIds: [occurrences[1]!] }));
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ version: 2, state: 'done', output: ['b'] });
      const retiredLinks = await engine.retireSegmentDerivations(pageId, [occurrences[0]!], { kind: 'links' });
      expect(retiredLinks).toBe(2);
      const retiredAll = await engine.retireSegmentDerivations(pageId, []);
      const left = view(await engine.readSegmentDerivations(pageId));
      return { all, links, retiredLinks, retiredAll, left };
    },
  );
});

// Cases below run each step as its own call, so the Rust arm (no transactions yet) serves them.
import { bodyColumns } from '../helpers/page-body-fixtures.ts';
import { pick } from './harness.ts';

/** What a call threw, by code and message, so the arms compare the refusal a caller branches on. */
async function thrown(run: () => Promise<unknown>): Promise<{ code: string | null; message: string } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === 'string' ? code : null, message: error instanceof Error ? error.message : String(error) };
  }
}

/** True when the call threw: for refusals whose codes are the database's own (a foreign key, a unique key). */
const refuses = (run: () => Promise<unknown>) => run().then(() => false, () => true);

/** Stage `texts` as rows of a new staging at `genFrom` with separate calls (no outer transaction). */
async function stageApart(engine: BrainEngine, input: { pageId: number; slug: string; genFrom: number; texts: readonly SegmentTextInput[];
  occurrences: readonly number[]; firstSeq?: number; byteStart?: number }) {
  const staging = stagingInput({ slug: input.slug, pageId: input.pageId, mode: input.genFrom === 1 ? 'create' : 'replace',
    baseGeneration: input.genFrom === 1 ? null : input.genFrom - 1 });
  await engine.openBodyStaging(staging);
  const { inserted } = await engine.stageSegmentTexts('default', input.texts, { stagingId: staging.id });
  let byteStart = input.byteStart ?? 0;
  await engine.stageManifestRows(input.texts.map((text, i) => {
    const row = manifestRow({ pageId: input.pageId, occurrenceId: input.occurrences[i]!, genFrom: input.genFrom, seq: (input.firstSeq ?? 0) + i,
      text, byteStart, stagingId: staging.id });
    byteStart += text.body.byteLength;
    return row;
  }));
  return { stagingId: staging.id, inserted };
}

/** Shell plus generation 1 (ONE, TWO, THREE) of `slug`, each step its own call. */
async function publishApart(engine: BrainEngine, slug: string) {
  const { id: pageId } = await engine.createSegmentedPageShell(slug, pageMeta('Apart page'), { sourceId: 'default' });
  const occurrences = await engine.allocateBodyOccurrenceIds(3);
  const texts = [ONE, TWO, THREE];
  const { stagingId, inserted } = await stageApart(engine, { pageId, slug, genFrom: 1, texts, occurrences });
  const flip = await engine.flipBodyGeneration(flipInput(pageId, 0, stagingId, texts));
  await engine.setBodyStagingState(stagingId, 'committed');
  return { pageId, occurrences, stagingId, inserted, flip };
}

// Not compiled_truth or timeline: PGLite's page of a segmented body refuses whole-body reads of them.
const PAGE_FIELDS = ['slug', 'title', 'type', 'body_storage', 'body_bytes', 'frontmatter'] as const;

describe('engine parity: segmented page bodies, one call at a time', () => {
  parityTest(
    'a segmented page publishes generation 1 from separate staging, manifest and flip calls',
    { methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows',
      'flipBodyGeneration', 'setBodyStagingState', 'readManifest', 'readSegmentTexts', 'getPage'] },
    async (engine) => {
      const { id: shellId } = await engine.createSegmentedPageShell('notes/apart-shell', pageMeta('Shell only'), { sourceId: 'default' });
      const shellPage = await engine.getPage('notes/apart-shell');
      const shellManifest = (await engine.readManifest(shellId)).length;
      const none = await engine.allocateBodyOccurrenceIds(0);
      const { id: pageId } = await engine.createSegmentedPageShell('notes/apart', pageMeta('Apart page'), { sourceId: 'default' });
      const occurrences = await engine.allocateBodyOccurrenceIds(3);
      expect([...occurrences].sort((a, b) => a - b)).toEqual(occurrences);
      const texts = [ONE, TWO, THREE];
      const { stagingId, inserted } = await stageApart(engine, { pageId, slug: 'notes/apart', genFrom: 1, texts, occurrences });
      const staged = manifestView(await engine.readManifest(pageId, { stagingId }), occurrences);
      const liveBefore = (await engine.readManifest(pageId)).length;
      const flip = await engine.flipBodyGeneration(flipInput(pageId, 0, stagingId, texts));
      await engine.setBodyStagingState(stagingId, 'committed');
      await engine.setBodyStagingState(stagingId, 'committed');
      const live = manifestView(await engine.readManifest(pageId), occurrences);
      const tail = manifestView(await engine.readManifest(pageId, { lastN: 2 }), occurrences);
      const gen1 = manifestView(await engine.readManifest(pageId, { generation: 1 }), occurrences);
      const gen0 = (await engine.readManifest(pageId, { generation: 0 })).length;
      const truth = (await engine.readManifest(pageId, { region: 'truth' })).length;
      const timeline = (await engine.readManifest(pageId, { region: 'timeline' })).length;
      const stagedAfter = (await engine.readManifest(pageId, { stagingId })).length;
      const missingPage = (await engine.readManifest(987_654_321)).length;
      const found = await engine.readSegmentTexts('default', [THREE.sha256, ONE.sha256, ONE.sha256, sha256('absent')]);
      const empty = (await engine.readSegmentTexts('default', [])).size;
      const again = await engine.stageSegmentTexts('default', [ONE, FOUR, FOUR]);
      const noTexts = await engine.stageSegmentTexts('default', []);
      const page = await engine.getPage('notes/apart');
      return {
        shellPage: shellPage ? pick(shellPage, PAGE_FIELDS) : null, shellManifest, none, inserted, staged, liveBefore, flip, live, tail,
        gen1Matches: JSON.stringify(gen1) === JSON.stringify(live), gen0, truth, timeline, stagedAfter, missingPage,
        found: sorted([...found].map(([sha, body]) => `${sha}:${new TextDecoder().decode(body)}`)), empty, again, noTexts,
        page: page ? { ...pick(page, PAGE_FIELDS), content_hash: page.content_hash } : null,
      };
    },
  );

  parityTest(
    'a second generation closes retired occurrences and refuses a stale or spent staging',
    { methods: ['flipBodyGeneration', 'readManifest', 'openBodyStaging', 'stageManifestRows', 'setBodyStagingState', 'getPage'] },
    async (engine) => {
      const first = await publishApart(engine, 'notes/apart-two');
      const spent = await thrown(() => engine.flipBodyGeneration(flipInput(first.pageId, 1, first.stagingId, [ONE, TWO, THREE])));
      const [newOcc] = await engine.allocateBodyOccurrenceIds(1);
      const all = [...first.occurrences, newOcc!];
      const { stagingId } = await stageApart(engine, { pageId: first.pageId, slug: 'notes/apart-two', genFrom: 2, texts: [FOUR],
        occurrences: [newOcc!], firstSeq: 2, byteStart: ONE.body.byteLength + TWO.body.byteLength });
      const stale = await thrown(() => engine.flipBodyGeneration(flipInput(first.pageId, 0, stagingId, [ONE, TWO, FOUR])));
      const flip = await engine.flipBodyGeneration(flipInput(first.pageId, 1, stagingId, [ONE, TWO, FOUR],
        { closeOccurrences: [first.occurrences[2]!], meta: { ...pageMeta('Apart page v2'), page_kind: 'markdown' } }));
      await engine.setBodyStagingState(stagingId, 'committed');
      const live = manifestView(await engine.readManifest(first.pageId), all);
      expect(live.map((r) => r.occurrence)).toEqual([0, 1, 3]);
      const gen1 = manifestView(await engine.readManifest(first.pageId, { generation: 1 }), all);
      const gen2Tail = manifestView(await engine.readManifest(first.pageId, { generation: 2, lastN: 1 }), all);
      const page = await engine.getPage('notes/apart-two');
      return { firstFlip: first.flip, spent, stale, flip, live, gen1, gen2Tail,
        page: page ? { ...pick(page, PAGE_FIELDS), content_hash: page.content_hash } : null };
    },
  );

  parityTest(
    'a flip refuses a missing page, a skipped generation, an aborted staging and rows that do not tile the body',
    { methods: ['flipBodyGeneration', 'createSegmentedPageShell', 'setBodyStagingState', 'readManifest', 'getPage'] },
    async (engine) => {
      const { id: pageId } = await engine.createSegmentedPageShell('notes/apart-refuse', pageMeta(), { sourceId: 'default' });
      const occurrences = await engine.allocateBodyOccurrenceIds(2);
      const { stagingId } = await stageApart(engine, { pageId, slug: 'notes/apart-refuse', genFrom: 1, texts: [ONE, TWO], occurrences });
      const missing = await thrown(() => engine.flipBodyGeneration(flipInput(987_654_321, 0, stagingId, [ONE, TWO])));
      const skipped = await thrown(() => engine.flipBodyGeneration({ ...flipInput(pageId, 0, stagingId, [ONE, TWO]), newGeneration: 2 }));
      const short = await thrown(() => engine.flipBodyGeneration(flipInput(pageId, 0, stagingId, [ONE, TWO],
        { body: bodyColumns([ONE, TWO], { body_bytes: ONE.body.byteLength + TWO.body.byteLength + 7, segment_count: 3 }) })));
      const stillStaged = (await engine.readManifest(pageId, { stagingId })).length;
      const stillLive = (await engine.readManifest(pageId)).length;
      await engine.setBodyStagingState(stagingId, 'aborted');
      const aborted = await thrown(() => engine.flipBodyGeneration(flipInput(pageId, 0, stagingId, [ONE, TWO])));
      const page = await engine.getPage('notes/apart-refuse');
      return { missing, skipped, short, stillStaged, stillLive, aborted, page: page ? pick(page, PAGE_FIELDS) : null };
    },
  );

  parityTest(
    'a staging moves through its live states and refuses to revive once it ended',
    { methods: ['openBodyStaging', 'setBodyStagingState'] },
    async (engine) => {
      const staging = stagingInput({ slug: 'notes/apart-states', declaredBytes: 12, declaredSha256: sha256('declared') });
      await engine.openBodyStaging(staging);
      await engine.setBodyStagingState(staging.id, 'sealed');
      await engine.setBodyStagingState(staging.id, 'prepared', { commitRequestId: '00000000-0000-4000-8000-000000000001' });
      await engine.setBodyStagingState(staging.id, 'committed', { commitRequestId: null });
      const sameAgain = await thrown(() => engine.setBodyStagingState(staging.id, 'committed'));
      const abortEnded = await thrown(() => engine.setBodyStagingState(staging.id, 'aborted'));
      const expireEnded = await thrown(() => engine.setBodyStagingState(staging.id, 'expired'));
      const revive = await thrown(() => engine.setBodyStagingState(staging.id, 'prepared'));
      const unknown = '00000000-0000-4000-8000-0000000000ff';
      const unknownPrepared = await thrown(() => engine.setBodyStagingState(unknown, 'prepared'));
      const unknownAborted = await thrown(() => engine.setBodyStagingState(unknown, 'aborted'));
      const expiring = stagingInput({ slug: 'notes/apart-states-2' });
      await engine.openBodyStaging(expiring);
      await engine.setBodyStagingState(expiring.id, 'expired');
      const committeAfterExpiry = await thrown(() => engine.setBodyStagingState(expiring.id, 'committed'));
      return { sameAgain, abortEnded, expireEnded, revive, unknownPrepared, unknownAborted, committeAfterExpiry };
    },
  );

  parityTest(
    'segment writes refuse what the tables refuse',
    { methods: ['openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'createSegmentedPageShell', 'refreshPageBody', 'readManifest', 'getPage'] },
    async (engine) => {
      const { id: pageId } = await engine.createSegmentedPageShell('notes/apart-tables', pageMeta(), { sourceId: 'default' });
      const staging = stagingInput({ slug: 'notes/apart-tables', pageId });
      await engine.openBodyStaging(staging);
      await engine.stageSegmentTexts('default', [ONE]);
      const [occ] = await engine.allocateBodyOccurrenceIds(1);
      const row = manifestRow({ pageId, occurrenceId: occ!, genFrom: 1, seq: 0, text: ONE, byteStart: 0, stagingId: staging.id });
      return {
        duplicateStaging: await refuses(() => engine.openBodyStaging(staging)),
        duplicateClient: await refuses(() => engine.openBodyStaging({ ...stagingInput({ slug: 'x' }), clientRequestId: staging.clientRequestId })),
        stagingNoSource: await refuses(() => engine.openBodyStaging(stagingInput({ slug: 'x', sourceId: 'no-such-source' }))),
        stagingNoPage: await refuses(() => engine.openBodyStaging(stagingInput({ slug: 'x', pageId: 987_654_321 }))),
        textNoSource: await refuses(() => engine.stageSegmentTexts('no-such-source', [TWO])),
        textNoStaging: await refuses(() => engine.stageSegmentTexts('default', [TWO], { stagingId: '00000000-0000-4000-8000-0000000000aa' })),
        rowNoPage: await refuses(() => engine.stageManifestRows([{ ...row, pageId: 987_654_321 }])),
        rowNoText: await refuses(() => engine.stageManifestRows([{ ...row, sha256: FOUR.sha256 }])),
        rowTwice: await refuses(() => engine.stageManifestRows([row, row])),
        stagedAfterRefusals: (await engine.readManifest(pageId, { stagingId: staging.id })).length,
        shellTaken: await refuses(() => engine.createSegmentedPageShell('notes/apart-tables', pageMeta(), { sourceId: 'default' })),
        shellNoSource: await refuses(() => engine.createSegmentedPageShell('notes/apart-x', pageMeta(), { sourceId: 'no-such-source' })),
        shellBadSlug: await refuses(() => engine.createSegmentedPageShell('Bad Slug!', pageMeta(), { sourceId: 'default' })),
        refreshSegmented: await refuses(() => engine.refreshPageBody('notes/apart-tables', 'default', 'inline text', '', 'hash')),
        negativeTail: await refuses(() => engine.readManifest(pageId, { lastN: -1 })),
        page: pick((await engine.getPage('notes/apart-tables'))!, PAGE_FIELDS),
      };
    },
  );

  parityTest(
    'segment derivations of a shell page upsert, read in order and retire without an outer transaction',
    { methods: ['upsertSegmentDerivations', 'readSegmentDerivations', 'retireSegmentDerivations', 'createSegmentedPageShell'] },
    async (engine) => {
      const { id: pageId } = await engine.createSegmentedPageShell('notes/apart-derived', pageMeta(), { sourceId: 'default' });
      const occurrences = await engine.allocateBodyOccurrenceIds(3);
      const row = (kind: 'links' | 'timeline', i: number, state: 'done' | 'failed', output: unknown) => ({
        pageId, kind, occurrenceId: occurrences[i]!, version: 1, segmentSha256: sha256(`seg:${i}`), contextHash: sha256(`ctx:${kind}`),
        state, output, receipt: i === 2 ? null : { n: i },
      });
      await engine.upsertSegmentDerivations([row('timeline', 2, 'done', { dates: 1 }), row('links', 2, 'done', ['c']), row('links', 0, 'done', ['a']),
        row('links', 1, 'failed', null)]);
      await engine.upsertSegmentDerivations([{ ...row('links', 1, 'done', ['b']), version: 3 }]);
      await engine.upsertSegmentDerivations([]);
      const view = (rows: Awaited<ReturnType<BrainEngine['readSegmentDerivations']>>) => rows.map((r) => ({
        kind: r.kind, occurrence: occurrences.indexOf(Number(r.occurrenceId)), version: Number(r.version), state: r.state,
        output: r.output, receipt: r.receipt, sha: hexOf(r.segmentSha256), ctx: hexOf(r.contextHash),
        stamped: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(r.createdAt) && r.createdAt <= r.updatedAt,
      }));
      const all = view(await engine.readSegmentDerivations(pageId));
      const timeline = view(await engine.readSegmentDerivations(pageId, { kind: 'timeline' }));
      const picked = view(await engine.readSegmentDerivations(pageId, { occurrenceIds: [occurrences[2]!, occurrences[0]!] }));
      const none = await engine.readSegmentDerivations(pageId, { occurrenceIds: [] });
      const otherPage = await engine.readSegmentDerivations(987_654_321);
      const noPage = await refuses(() => engine.upsertSegmentDerivations([{ ...row('links', 0, 'done', []), pageId: 987_654_321 }]));
      const retiredTimeline = await engine.retireSegmentDerivations(pageId, [occurrences[0]!], { kind: 'timeline' });
      const retiredLinks = await engine.retireSegmentDerivations(pageId, [occurrences[0]!, occurrences[1]!]);
      const left = view(await engine.readSegmentDerivations(pageId));
      return { all, timeline, picked, none, otherPage, noPage, retiredTimeline, retiredLinks, left };
    },
  );

  parityTest(
    'segment chunks stage for the live or a later generation and refuse a stale, missing or unpublished target',
    { methods: ['stageSegmentChunks', 'putPage', 'getPage'] },
    async (engine) => {
      const { pageId, occurrences } = await publishApart(engine, 'notes/chunks-apart');
      const [one, two, three] = occurrences;
      const noChunks = await engine.stageSegmentChunks(pageId, 0, []);
      const stale = await thrown(() => engine.stageSegmentChunks(pageId, 0, [chunk(one!, 0, 'old')]));
      const missing = await thrown(() => engine.stageSegmentChunks(987_654_321, 1, [chunk(one!, 0, 'gone')]));
      const unpublished = await thrown(() => engine.stageSegmentChunks(pageId, 1, [chunk(one!, 0, 'ok'), chunk(three! + 1_000_000, 0, 'stray')]));
      const live = await engine.stageSegmentChunks(pageId, 1, [chunk(one!, 0, 'one'), chunk(two!, 0, 'two'), chunk(two!, 1, 'two more')]);
      const later = await engine.stageSegmentChunks(pageId, 2, [chunk(three! + 1_000_000, 0, 'next')]);
      await engine.putPage('notes/chunks-inline', { type: 'note', title: 'Inline', compiled_truth: 'Inline body.', timeline: '' });
      const inline = await engine.getPage('notes/chunks-inline');
      const inlineNow = await thrown(() => engine.stageSegmentChunks(inline!.id, 0, [chunk(1, 0, 'inline')]));
      const inlineNext = await engine.stageSegmentChunks(inline!.id, 1, [chunk(1, 0, 'inline next')]);
      return { noChunks, stale, missing, unpublished, live, later, inlineNow, inlineNext };
    },
  );

  parityTest(
    'sealing a segmented page shows its chunks at the current revision, again after a replace that keeps older chunks',
    { methods: ['sealSegmentedPage', 'stageSegmentChunks', 'getChunks', 'flipBodyGeneration'] },
    async (engine) => {
      const texts = (rows: Awaited<ReturnType<BrainEngine['getChunks']>>) => sorted(rows.map((c) => c.chunk_text));
      const { pageId, occurrences } = await publishApart(engine, 'notes/sealed');
      const [one, two, three] = occurrences;
      await engine.stageSegmentChunks(pageId, 1, [chunk(one!, 0, 'one'), chunk(two!, 0, 'two'), chunk(three!, 0, 'three')]);
      const unsealed = texts(await engine.getChunks('notes/sealed'));
      await engine.sealSegmentedPage(pageId);
      const sealed = texts(await engine.getChunks('notes/sealed'));
      // A replace that keeps ONE and TWO: their generation-1 chunks stay and show beside FOUR's.
      // (The chunker stamp the seal keeps is not readable through an engine member; the store tests pin it.)
      const [four] = await engine.allocateBodyOccurrenceIds(1);
      const { stagingId } = await stageApart(engine, { pageId, slug: 'notes/sealed', genFrom: 2, texts: [FOUR], occurrences: [four!],
        firstSeq: 2, byteStart: ONE.body.byteLength + TWO.body.byteLength });
      await engine.stageSegmentChunks(pageId, 2, [chunk(four!, 0, 'four')]);
      await engine.flipBodyGeneration(flipInput(pageId, 1, stagingId, [ONE, TWO, FOUR],
        { closeOccurrences: [three!], retireChunkOccurrences: [three!] }));
      await engine.setBodyStagingState(stagingId, 'committed');
      const flipped = texts(await engine.getChunks('notes/sealed'));
      await engine.sealSegmentedPage(pageId, { timelineLead: 'a lead the caller passes' });
      const resealed = texts(await engine.getChunks('notes/sealed'));
      const missing = await thrown(() => engine.sealSegmentedPage(987_654_321));
      return { unsealed, sealed, flipped, resealed, missing };
    },
  );

  parityTest(
    'a sealed segmented page is found by its title and timeline lead',
    { methods: ['sealSegmentedPage', 'searchTitles'] },
    async (engine) => {
      const { pageId } = await publishApart(engine, 'notes/sealed-titles');
      const slugs = async (query: string) => sorted((await engine.searchTitles(query, { limit: 5 })).map((r) => r.slug));
      const unsealed = await slugs('Segmented probe');
      await engine.sealSegmentedPage(pageId);
      // The flip renamed the shell to the fixture title; the stored lead is the fixture's timeline_lead.
      const sealed = { title: await slugs('Segmented probe'), lead: await slugs('zephyrwinds') };
      await engine.sealSegmentedPage(pageId, { timelineLead: 'a caller lead names quillfeather' });
      const passed = { title: await slugs('Segmented probe'), stored: await slugs('zephyrwinds'), lead: await slugs('quillfeather') };
      return { unsealed, sealed, passed };
    },
  );

  parityTest(
    'sealChunks refuses a segmented page and leaves its chunks as they were',
    { methods: ['sealChunks', 'getChunks', 'stageSegmentChunks', 'sealSegmentedPage'] },
    async (engine) => {
      const texts = (rows: Awaited<ReturnType<BrainEngine['getChunks']>>) => sorted(rows.map((c) => c.chunk_text));
      const { pageId, occurrences } = await publishApart(engine, 'notes/seal-refused');
      await engine.stageSegmentChunks(pageId, 1, occurrences.map((o, i) => chunk(o, 0, `segment ${i}`)));
      await engine.sealSegmentedPage(pageId);
      const before = texts(await engine.getChunks('notes/seal-refused'));
      const empty = await thrown(() => engine.sealChunks('notes/seal-refused', []));
      const replace = await thrown(() => engine.sealChunks('notes/seal-refused', [{ chunk_index: 0, chunk_text: 'inline text', chunk_source: 'compiled_truth' }]));
      const after = texts(await engine.getChunks('notes/seal-refused'));
      return { before, empty: empty?.message ?? null, replace: replace?.message ?? null, after };
    },
  );

  parityTest(
    'createVersion of a segmented page versions it on PGLite and is a typed refusal on the Rust store',
    { methods: ['createVersion', 'getVersions'] },
    async (engine) => {
      await publishApart(engine, 'notes/versioned-big');
      const version = await engine.createVersion('notes/versioned-big');
      const versions = await engine.getVersions('notes/versioned-big');
      return { title: version.title, count: versions.length };
    },
  );

  // Review finding specialist-batched#2: updateSlug versions the page before it moves it. SQL versions a segmented page as
  // a reference to its live body generation; the Rust store keeps no such reference, so it must refuse the rename (as
  // createVersion does) instead of writing a version with no body and moving the page.
  parityTest(
    'pageCollapseFacts reads a segmented page through its stored truth lead',
    { methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'flipBodyGeneration', 'pageCollapseFacts', 'putPage'] },
    async (engine) => {
      // Long enough (>= 200 characters) that the collapse facts carry an md5 of the body, not only its length and lead.
      const LONG = segmentText(`# Long\n${'a long segmented body about the pelican migration. '.repeat(6)}\n`);
      const { id: pageId } = await engine.createSegmentedPageShell('notes/long', pageMeta('Long page'), { sourceId: 'default' });
      const occurrences = await engine.allocateBodyOccurrenceIds(1);
      const { stagingId } = await stageApart(engine, { pageId, slug: 'notes/long', genFrom: 1, texts: [LONG], occurrences });
      await engine.flipBodyGeneration(flipInput(pageId, 0, stagingId, [LONG]));
      await engine.setBodyStagingState(stagingId, 'committed');
      const inline = await engine.putPage('notes/short', { type: 'note', title: 'Short', compiled_truth: 'a short inline body', timeline: '' });
      const rows = await engine.pageCollapseFacts([pageId, inline.id], [pageId, inline.id]);
      const view = rows.map((r) => ({ page: r.id === pageId ? 'segmented' : 'inline', body_chars: r.body_chars, hashed: r.body !== null,
        lead: r.lead?.slice(0, 30) ?? null }));
      const segmented = view.find((r) => r.page === 'segmented');
      expect(segmented?.body_chars).toBeGreaterThan(200);
      expect(segmented?.hashed).toBe(true);
      expect(segmented?.lead).toStartWith('# Long');
      return { view, bodies: rows.map((r) => r.body) };
    },
  );

  parityTest(
    'updateSlug of a segmented page versions it by reference on PGLite and is a typed refusal on the Rust store',
    { methods: ['updateSlug', 'getVersions', 'getPage'] },
    async (engine) => {
      await publishApart(engine, 'notes/renamed-big');
      // Rust: the typed refusal ends the case, and nothing was renamed or versioned (checked in the store's unit test).
      const moved = await engine.updateSlug('notes/renamed-big', 'notes/renamed-big-2');
      const versions = await engine.getVersions('notes/renamed-big-2');
      const page = await engine.getPage('notes/renamed-big-2');
      return {
        moved,
        page: page ? { slug: page.slug, title: page.title } : null,
        versions: versions.map((v) => ({ title: v.title, compiled_truth: v.compiled_truth, timeline: v.timeline, content_hash: v.content_hash ?? null })),
      };
    },
  );
});
