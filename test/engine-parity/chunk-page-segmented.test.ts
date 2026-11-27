/**
 * BrainEngine parity — chunk reads of a segmented page (getChunkPage, getChunkWindows).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a segmented page's chunks are read through its live body generation. A chunk staged for the next
 *    generation stays invisible until the flip (text, totals and max index alike), `getChunkPage` pages by position in
 *    document order (a segmented chunk_index is an insertion sequence, so it leaves gaps and is not the order), and a
 *    window chunk names the manifest occurrence it was cut from.
 *  - Regression: an engine that reads raw chunk rows shows draft text before the flip, returns an empty first page or a
 *    wrong max index once a replace retired a chunk or inserted one in the middle, or gives `occurrence_id` null so
 *    segmented evidence cannot map a chunk to its manifest row.
 *  - Also: a segmented page whose published body is nonempty but has no chunks counts, and is listed, as a chunkless
 *    page with content (the repair sweep re-chunks it); a fresh shell with no body does not. An engine that cannot read
 *    a segmented page's body size answers 0 and an empty list, so a body that lost its chunks is never re-chunked.
 *  - Why existing coverage misses it: segmented-body.test.ts reads `getChunks` only, and chunks.test.ts pages inline
 *    pages, whose chunk_index is the order and whose chunkless cases never publish a segmented body.
 *  - Seam: none. Real engines, typed methods only. Occurrence ids come from sequences, so observables map them to
 *    ordinals of the allocated ids.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SegmentTextInput } from '../../src/core/page-body/types.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, flipInput, manifestRow, pageMeta, segmentText, stagingInput } from '../helpers/page-body-fixtures.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const ONE = segmentText('# Intro\nfirst segment about quillwort\n');
const TWO = segmentText('## Middle\nsecond segment about heron\n');
const THREE = segmentText('## End\nthird segment about ibex\n');
const FOUR = segmentText('## Inserted\nfourth segment about marmot\n');
const textOf = (t: SegmentTextInput) => new TextDecoder().decode(t.body);

/** Publish ONE, TWO, THREE (one chunk each) as generation 1 of notes/big; occurrence ordinals 0..2, a fourth is spare. */
async function publish(engine: BrainEngine) {
  const { id: pageId } = await engine.createSegmentedPageShell('notes/big', pageMeta('Big page'), { sourceId: 'default' });
  const occ = await engine.allocateBodyOccurrenceIds(4);
  const texts = [ONE, TWO, THREE];
  const staging = stagingInput({ slug: 'notes/big', pageId, mode: 'create' });
  await engine.openBodyStaging(staging);
  await engine.stageSegmentTexts('default', texts, { stagingId: staging.id });
  let byteStart = 0;
  await engine.stageManifestRows(texts.map((text, seq) => {
    const row = manifestRow({ pageId, occurrenceId: occ[seq]!, genFrom: 1, seq, text, byteStart, stagingId: staging.id });
    byteStart += text.body.byteLength;
    return row;
  }));
  await engine.stageSegmentChunks(pageId, 1, texts.map((text, i) => chunk(occ[i]!, 0, textOf(text))));
  await engine.flipBodyGeneration(flipInput(pageId, 0, staging.id, texts));
  await engine.setBodyStagingState(staging.id, 'committed');
  await engine.sealSegmentedPage(pageId);
  return { pageId, occ };
}

/**
 * Stage generation 2 without flipping it: ONE, FOUR (new), TWO (moved after FOUR); THREE leaves. FOUR's chunk is
 * inserted after THREE's, so its chunk_index is the highest while its place in the document is the middle.
 */
async function stageReplace(engine: BrainEngine, pageId: number, occ: readonly number[]) {
  const staging = stagingInput({ slug: 'notes/big', pageId, mode: 'replace', baseGeneration: 1 });
  await engine.openBodyStaging(staging);
  await engine.stageSegmentTexts('default', [FOUR], { stagingId: staging.id });
  await engine.stageManifestRows([
    manifestRow({ pageId, occurrenceId: occ[3]!, genFrom: 2, seq: 1, text: FOUR, byteStart: ONE.body.byteLength, stagingId: staging.id }),
    manifestRow({ pageId, occurrenceId: occ[1]!, genFrom: 2, seq: 2, text: TWO, byteStart: ONE.body.byteLength + FOUR.body.byteLength, stagingId: staging.id }),
  ]);
  await engine.stageSegmentChunks(pageId, 2, [chunk(occ[3]!, 0, textOf(FOUR))]);
  return staging;
}

/** Flip generation 2: THREE is retired (its chunk deleted), TWO moves behind FOUR. */
async function flipReplace(engine: BrainEngine, pageId: number, occ: readonly number[], stagingId: string) {
  await engine.flipBodyGeneration(flipInput(pageId, 1, stagingId, [ONE, FOUR, TWO],
    { closeOccurrences: [occ[1]!, occ[2]!], retireChunkOccurrences: [occ[2]!] }));
  await engine.setBodyStagingState(stagingId, 'committed');
  await engine.sealSegmentedPage(pageId);
}

/** Replace the whole live body with `texts` (one chunk each) at generation `generation` + 1, retiring `previous`. */
async function replaceAll(engine: BrainEngine, pageId: number, generation: number, previous: readonly number[], texts: readonly SegmentTextInput[]) {
  const occ = await engine.allocateBodyOccurrenceIds(texts.length);
  const staging = stagingInput({ slug: 'notes/big', pageId, mode: 'replace', baseGeneration: generation });
  await engine.openBodyStaging(staging);
  await engine.stageSegmentTexts('default', texts, { stagingId: staging.id });
  let byteStart = 0;
  await engine.stageManifestRows(texts.map((text, seq) => {
    const row = manifestRow({ pageId, occurrenceId: occ[seq]!, genFrom: generation + 1, seq, text, byteStart, stagingId: staging.id });
    byteStart += text.body.byteLength;
    return row;
  }));
  await engine.stageSegmentChunks(pageId, generation + 1, texts.map((text, i) => chunk(occ[i]!, 0, textOf(text))));
  await engine.flipBodyGeneration(flipInput(pageId, generation, staging.id, texts, { closeOccurrences: previous, retireChunkOccurrences: previous }));
  await engine.setBodyStagingState(staging.id, 'committed');
  await engine.sealSegmentedPage(pageId);
  return occ;
}

/** Publish ONE, TWO as generation 1 of notes/big with no chunks staged, and leave the page unsealed. */
async function publishWithoutChunks(engine: BrainEngine) {
  const { id: pageId } = await engine.createSegmentedPageShell('notes/big', pageMeta('Big page'), { sourceId: 'default' });
  const occ = await engine.allocateBodyOccurrenceIds(2);
  const texts = [ONE, TWO];
  const staging = stagingInput({ slug: 'notes/big', pageId, mode: 'create' });
  await engine.openBodyStaging(staging);
  await engine.stageSegmentTexts('default', texts, { stagingId: staging.id });
  let byteStart = 0;
  await engine.stageManifestRows(texts.map((text, seq) => {
    const row = manifestRow({ pageId, occurrenceId: occ[seq]!, genFrom: 1, seq, text, byteStart, stagingId: staging.id });
    byteStart += text.body.byteLength;
    return row;
  }));
  await engine.flipBodyGeneration(flipInput(pageId, 0, staging.id, texts));
  await engine.setBodyStagingState(staging.id, 'committed');
  return pageId;
}

const words = (texts: readonly string[]) => texts.map((t) => t.split('\n')[1]!.split(' ').pop());

async function pageView(engine: BrainEngine, fromIndex: number, limit: number) {
  const page = await engine.getChunkPage('notes/big', { fromIndex, limit });
  return { words: words(page.chunks.map((c) => c.chunk_text)), total: page.total_chunks, max: page.max_chunk_index };
}

async function windowView(engine: BrainEngine, pageId: number, occ: readonly number[]) {
  const [window] = await engine.getChunkWindows([{ page_id: pageId, from_index: 0, to_index: 20, priority: 0 }],
    { chunkSources: ['compiled_truth', 'timeline'], maxRows: 50 });
  if (!window) return null;
  return {
    sealed: window.sealed,
    segmented: window.segmented === true,
    max: window.max_chunk_index,
    chunks: window.chunks.map((c) => ({ word: words([c.chunk_text])[0], occurrence: c.occurrence_id === undefined ? null : occ.indexOf(c.occurrence_id) })),
  };
}

describe('engine parity: chunk reads of a segmented page', () => {
  parityTest(
    'a segmented page with a published body and no chunks is chunkless with content; an empty shell is not',
    { methods: ['countChunklessPagesWithContent', 'listChunklessPagesWithContent', 'flipBodyGeneration', 'createSegmentedPageShell'] },
    async (engine) => {
      const { id: shellId } = await engine.createSegmentedPageShell('notes/shell', pageMeta('Shell page'), { sourceId: 'default' });
      const empty = { count: await engine.countChunklessPagesWithContent(), slugs: (await engine.listChunklessPagesWithContent()).map((p) => p.slug) };
      const pageId = await publishWithoutChunks(engine);
      const published = { count: await engine.countChunklessPagesWithContent(), slugs: (await engine.listChunklessPagesWithContent()).map((p) => p.slug) };
      expect(shellId).not.toBe(pageId);
      expect(empty).toEqual({ count: 0, slugs: [] });
      expect(published).toEqual({ count: 1, slugs: ['notes/big'] });
      return { empty, published };
    },
  );

  parityTest(
    'a chunk staged for the next generation stays out of getChunkPage and getChunkWindows until the flip',
    { methods: ['stageSegmentChunks', 'getChunkPage', 'getChunkWindows', 'flipBodyGeneration', 'sealSegmentedPage'] },
    async (engine) => {
      const { pageId, occ } = await publish(engine);
      const before = { page: await pageView(engine, 0, 10), window: await windowView(engine, pageId, occ) };
      const staging = await stageReplace(engine, pageId, occ);
      const staged = { page: await pageView(engine, 0, 10), window: await windowView(engine, pageId, occ) };
      expect(before.page).toEqual({ words: ['quillwort', 'heron', 'ibex'], total: 3, max: 2 });
      // Staged draft text, and the totals and max that count it, are not visible before the flip.
      expect(staged).toEqual(before);
      await flipReplace(engine, pageId, occ, staging.id);
      const flipped = { page: await pageView(engine, 0, 10), window: await windowView(engine, pageId, occ) };
      expect(flipped.page.words).toEqual(['quillwort', 'marmot', 'heron']);
      return { before, staged, flipped };
    },
  );

  // Review finding specialist-batched#3: includeUnsealed and the embedding maintenance reads use chunkGenerationFilter,
  // which also needs a live manifest row. A flip that defers its retire (retireMaxRows) leaves the closed occurrence's
  // chunk at an old generation; it is no longer part of the body, so these reads must not serve, count or embed it.
  parityTest(
    'a chunk whose occurrence a deferred retire closed stays out of includeUnsealed reads and embedding maintenance',
    { methods: ['getChunks', 'getChunksWithEmbeddings', 'countStaleChunks', 'sumStaleChunkChars', 'listStaleChunks', 'readEmbeddingStateCounts', 'listEmbeddingStateRows', 'flipBodyGeneration'] },
    async (engine) => {
      const { pageId, occ } = await publish(engine);
      const staging = await stageReplace(engine, pageId, occ);
      await engine.flipBodyGeneration(flipInput(pageId, 1, staging.id, [ONE, FOUR, TWO],
        { closeOccurrences: [occ[1]!, occ[2]!], retireChunkOccurrences: [occ[2]!], retireMaxRows: 0 }));
      await engine.setBodyStagingState(staging.id, 'committed');
      const unsealed = words((await engine.getChunks('notes/big', { includeUnsealed: true })).map((c) => c.chunk_text));
      const withVectors = words((await engine.getChunksWithEmbeddings('notes/big', { includeUnsealed: true })).map((c) => c.chunk_text));
      const stale = words((await engine.listStaleChunks({ batchSize: 50 })).map((r) => r.chunk_text)).sort();
      const counts = await engine.readEmbeddingStateCounts({ mode: 'full', purgeWindowHours: 24 });
      const rows = (await engine.listEmbeddingStateRows({ states: ['pending'], limit: 10, purgeWindowHours: 24 }))
        .map((r) => ({ slug: r.slug, state: r.state, chunks: r.chunks, bytes: r.bytes }));
      return {
        unsealed, withVectors, stale,
        staleCount: await engine.countStaleChunks(),
        staleChars: await engine.sumStaleChunkChars(),
        counts: counts.counts,
        rows,
      };
    },
  );

  // resolveFrozenHits joins chunks through chunkGenerationFilter too: a frozen hit on the chunk of an occurrence a
  // deferred retire closed keeps its page row and reads no chunk, so evidence never quotes retired text.
  parityTest(
    'a frozen hit on a chunk whose occurrence a deferred retire closed reads no chunk text',
    { methods: ['getChunks', 'flipBodyGeneration', 'sealSegmentedPage', 'resolveFrozenHits'] },
    async (engine) => {
      const { pageId, occ } = await publish(engine);
      const before = await engine.getChunks('notes/big');
      const idOf = (word: string) => Number(before.find((c) => words([c.chunk_text])[0] === word)!.id);
      const staging = await stageReplace(engine, pageId, occ);
      await engine.flipBodyGeneration(flipInput(pageId, 1, staging.id, [ONE, FOUR, TWO],
        { closeOccurrences: [occ[1]!, occ[2]!], retireChunkOccurrences: [occ[2]!], retireMaxRows: 0 }));
      await engine.setBodyStagingState(staging.id, 'committed');
      await engine.sealSegmentedPage(pageId);
      const rows = await engine.resolveFrozenHits([
        { source_id: 'default', slug: 'notes/big', chunk_id: idOf('ibex'), ord: 1 },
        { source_id: 'default', slug: 'notes/big', chunk_id: idOf('quillwort'), ord: 2 },
      ], {});
      const out = rows.map((r) => ({ ord: r.ord, slug: r.slug, chunk: r.chunk_text === null ? null : words([r.chunk_text])[0] }))
        .sort((a, b) => a.ord - b.ord);
      expect(out).toEqual([{ ord: 1, slug: 'notes/big', chunk: null }, { ord: 2, slug: 'notes/big', chunk: 'quillwort' }]);
      return out;
    },
  );

  parityTest(
    'the canonical chunk a relational walk names for a segmented page is a chunk of its live body',
    { methods: ['relationalFanout', 'getChunks', 'flipBodyGeneration', 'stageManifestRows', 'addLink'] },
    async (engine) => {
      const { pageId, occ } = await publish(engine);
      // Generation 2 drops ONE, the occurrence whose chunk has the lowest chunk_index. Its chunk retire is deferred
      // (retireMaxRows 0), so the chunk row stays while its manifest row is closed.
      const staging = stagingInput({ slug: 'notes/big', pageId, mode: 'replace', baseGeneration: 1 });
      await engine.openBodyStaging(staging);
      await engine.stageManifestRows([
        manifestRow({ pageId, occurrenceId: occ[1]!, genFrom: 2, seq: 0, text: TWO, byteStart: 0, stagingId: staging.id }),
        manifestRow({ pageId, occurrenceId: occ[2]!, genFrom: 2, seq: 1, text: THREE, byteStart: TWO.body.byteLength, stagingId: staging.id }),
      ]);
      await engine.flipBodyGeneration(flipInput(pageId, 1, staging.id, [TWO, THREE],
        { closeOccurrences: [occ[0]!, occ[1]!, occ[2]!], retireChunkOccurrences: [occ[0]!], retireMaxRows: 0 }));
      await engine.setBodyStagingState(staging.id, 'committed');
      await engine.putPage('people/reader', { type: 'person', title: 'Reader', compiled_truth: 'reads the big page', timeline: '' });
      await engine.addLink('people/reader', 'notes/big', 'reads it', 'cites', 'manual');
      const live = await engine.getChunks('notes/big', { includeUnsealed: true });
      const wordOf = new Map(live.map((c) => [c.id, words([c.chunk_text])[0]]));
      const [hit] = (await engine.relationalFanout(['people/reader'], { direction: 'out' })).filter((r) => r.slug === 'notes/big');
      const canonical = hit?.canonical_chunk_id == null ? null : (wordOf.get(hit.canonical_chunk_id) ?? 'not a live chunk');
      expect(words(live.map((c) => c.chunk_text))).toEqual(['heron', 'ibex']);
      expect(canonical).toBe('heron');
      return { live: [...wordOf.values()], canonical };
    },
  );

  parityTest(
    'getChunkPage pages a segmented page by position in document order, not by insertion chunk_index',
    { methods: ['getChunkPage', 'stageSegmentChunks', 'flipBodyGeneration'] },
    async (engine) => {
      const { pageId, occ } = await publish(engine);
      await flipReplace(engine, pageId, occ, (await stageReplace(engine, pageId, occ)).id);
      // Visible chunks in document order: ONE (chunk_index 0), FOUR (3), TWO (1): positions 0, 1, 2; index 2 is a gap.
      const pages = [];
      for (const fromIndex of [0, 1, 2, 3]) pages.push(await pageView(engine, fromIndex, 1));
      const wide = await pageView(engine, 1, 5);
      expect(pages).toEqual([
        { words: ['quillwort'], total: 3, max: 2 },
        { words: ['marmot'], total: 3, max: 2 },
        { words: ['heron'], total: 3, max: 2 },
        { words: [], total: 3, max: 2 },
      ]);
      expect(wide.words).toEqual(['marmot', 'heron']);
      return { pages, wide };
    },
  );

  parityTest(
    'getChunkWindows names the manifest occurrence of each segmented chunk',
    { methods: ['getChunkWindows', 'stageSegmentChunks', 'flipBodyGeneration'] },
    async (engine) => {
      const { pageId, occ } = await publish(engine);
      const first = await windowView(engine, pageId, occ);
      expect(first!.chunks).toEqual([{ word: 'quillwort', occurrence: 0 }, { word: 'heron', occurrence: 1 }, { word: 'ibex', occurrence: 2 }]);
      await flipReplace(engine, pageId, occ, (await stageReplace(engine, pageId, occ)).id);
      const second = await windowView(engine, pageId, occ);
      // Rows come in chunk_index order: ONE (0), TWO (1), FOUR (3); THREE's row (2) is gone.
      expect(second!.chunks).toEqual([{ word: 'quillwort', occurrence: 0 }, { word: 'heron', occurrence: 1 }, { word: 'marmot', occurrence: 3 }]);
      expect(second!.segmented).toBe(true);
      return { first, second };
    },
  );

  parityTest(
    'getChunkPage returns the visible chunks of a page whose earlier replaces left its chunk_index range far from zero',
    { methods: ['getChunkPage', 'stageSegmentChunks', 'flipBodyGeneration'] },
    async (engine) => {
      const { pageId, occ } = await publish(engine);
      // Generation 2 holds one chunk (chunk_index 3), generation 3 two (4 and 5): the retired rows are deleted.
      const second = await replaceAll(engine, pageId, 1, occ.slice(0, 3), [FOUR]);
      await replaceAll(engine, pageId, 2, second, [ONE, THREE]);
      const first = await pageView(engine, 0, 2);
      const tail = await pageView(engine, 1, 1);
      expect(first).toEqual({ words: ['quillwort', 'ibex'], total: 2, max: 1 });
      expect(tail).toEqual({ words: ['ibex'], total: 2, max: 1 });
      return { first, tail };
    },
  );
});
