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
