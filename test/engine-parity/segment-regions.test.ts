/**
 * BrainEngine parity — where search hits on a segmented page start in its body (segmentRegions, search/dedup.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when one page has more hits than dedup keeps per page, segmentRegions answers, for each hit chunk of a
 *    served segmented page, the stored byte where its occurrence starts in the live body. A chunk staged for the next
 *    generation, a chunk of a retired occurrence and a chunk of an inline page have no region; a moved occurrence
 *    reports its new start after the flip.
 *  - Regression: on an engine with no SQL dialect the read refused (keywordBoundedRead is raw SQL) and the caller
 *    caught the refusal, so every segmented page fell back to the inline rule and search dropped far-apart passages of
 *    a large page with no error.
 *  - Why existing coverage misses it: test/large-pages/segmented-search-dedup.test.ts runs PGLite and Postgres only,
 *    and seeds its hits through executeRaw.
 *  - Seam: none. Real engines and typed members build the page; segmentRegions runs as search runs it. Chunk ids come
 *    from sequences, so observables name chunks by their segment's word.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SegmentTextInput } from '../../src/core/page-body/types.ts';
import { segmentRegions } from '../../src/core/search/dedup.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, flipInput, manifestRow, pageMeta, segmentText, stagingInput } from '../helpers/page-body-fixtures.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const ONE = segmentText('# Intro\nfirst segment about quillwort\n');
const TWO = segmentText('## Middle\nsecond segment about heron\n');
const THREE = segmentText('## End\nthird segment about ibex\n');
const FOUR = segmentText('## Inserted\nfourth segment about marmot\n');
const textOf = (t: SegmentTextInput) => new TextDecoder().decode(t.body);
const len = (...texts: SegmentTextInput[]) => texts.reduce((n, t) => n + t.body.byteLength, 0);

/** Publish ONE, TWO, THREE (one chunk each) as generation 1 of notes/big; the chunk ids, read back in chunk_index order, follow the segments. */
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
  const ids = (await engine.getChunks('notes/big')).sort((a, b) => a.chunk_index - b.chunk_index).map(c => c.id);
  return { pageId, occ, ids };
}

/** An inline page with three chunks, so it also passes dedup's per-page threshold. */
async function inline(engine: BrainEngine) {
  await engine.putPage('notes/small', { type: 'note', title: 'Small page', compiled_truth: 'otter\n\nbadger\n\nmole', timeline: '', frontmatter: {} });
  await engine.upsertChunks('notes/small', ['otter', 'badger', 'mole'].map((chunk_text, chunk_index) => ({ chunk_index, chunk_text, chunk_source: 'compiled_truth' as const })));
  const page = await engine.getPage('notes/small');
  const chunks = await engine.getChunks('notes/small', { includeUnsealed: true });
  return { pageId: page!.id, ids: chunks.map(c => c.id) };
}

const hit = (slug: string, pageId: number, chunkId: number, i: number): SearchResult =>
  ({ slug, page_id: pageId, source_id: 'default', chunk_id: chunkId, chunk_index: i, title: slug, type: 'note', chunk_text: '', chunk_source: 'compiled_truth', score: 1 - i * 0.01, stale: false });

/** segmentRegions over the hits, with each chunk id named by its word. */
async function regions(engine: BrainEngine, hits: SearchResult[], names: Map<number, string>) {
  const found = await segmentRegions(engine, hits);
  return [...found].map(([id, at]) => [names.get(id) ?? `unknown:${id}`, at] as const).sort((a, b) => a[1] - b[1]);
}

describe('engine parity: segmented regions of search hits', () => {
  parityTest(
    'each hit on a served segmented page gets its occurrence start; staged, retired and inline chunks get none',
    { methods: ['stageSegmentChunks', 'flipBodyGeneration', 'sealSegmentedPage', 'upsertChunks'] },
    async (engine) => {
      const big = await publish(engine);
      const small = await inline(engine);
      const names = new Map<number, string>([
        [big.ids[0]!, 'quillwort'], [big.ids[1]!, 'heron'], [big.ids[2]!, 'ibex'],
        [small.ids[0]!, 'otter'], [small.ids[1]!, 'badger'], [small.ids[2]!, 'mole'],
      ]);
      const bigHits = big.ids.map((id, i) => hit('notes/big', big.pageId, id, i));
      const smallHits = small.ids.map((id, i) => hit('notes/small', small.pageId, id, i));
      const published = await regions(engine, [...bigHits, ...smallHits], names);
      expect(published).toEqual([['quillwort', 0], ['heron', len(ONE)], ['ibex', len(ONE, TWO)]]);

      // Two hits on the page are within dedup's per-page cap, so the read is skipped.
      const underCap = await regions(engine, bigHits.slice(0, 2), names);
      expect(underCap).toEqual([]);

      // Stage generation 2 (ONE, FOUR, TWO; THREE leaves) without the flip: FOUR's chunk has no region yet. No read
      // names a staged chunk, so the hits cover every id up to past the largest known one; after the flip the test
      // checks that FOUR's id was among them.
      const staging = stagingInput({ slug: 'notes/big', pageId: big.pageId, mode: 'replace', baseGeneration: 1 });
      await engine.openBodyStaging(staging);
      await engine.stageSegmentTexts('default', [FOUR], { stagingId: staging.id });
      await engine.stageManifestRows([
        manifestRow({ pageId: big.pageId, occurrenceId: big.occ[3]!, genFrom: 2, seq: 1, text: FOUR, byteStart: len(ONE), stagingId: staging.id }),
        manifestRow({ pageId: big.pageId, occurrenceId: big.occ[1]!, genFrom: 2, seq: 2, text: TWO, byteStart: len(ONE, FOUR), stagingId: staging.id }),
      ]);
      await engine.stageSegmentChunks(big.pageId, 2, [chunk(big.occ[3]!, 0, textOf(FOUR))]);
      const span = Math.max(...names.keys()) + 32;
      const everyId = Array.from({ length: span }, (_, i) => hit('notes/big', big.pageId, i + 1, i));
      const staged = await regions(engine, everyId, names);
      expect(staged).toEqual(published);

      // The flip retires THREE and moves TWO behind FOUR.
      await engine.flipBodyGeneration(flipInput(big.pageId, 1, staging.id, [ONE, FOUR, TWO],
        { closeOccurrences: [big.occ[1]!, big.occ[2]!], retireChunkOccurrences: [big.occ[2]!] }));
      await engine.setBodyStagingState(staging.id, 'committed');
      await engine.sealSegmentedPage(big.pageId);
      const fourId = (await engine.getChunks('notes/big')).find(c => c.chunk_text === textOf(FOUR))!.id;
      expect(fourId).toBeLessThanOrEqual(span);
      names.set(fourId, 'marmot');
      const withFour = [...bigHits, hit('notes/big', big.pageId, fourId, 3)];
      const flipped = await regions(engine, withFour, names);
      expect(flipped).toEqual([['quillwort', 0], ['marmot', len(ONE)], ['heron', len(ONE, FOUR)]]);
      return { published, underCap, staged, flipped };
    },
  );
});
