/**
 * Forced chunk cuts on sentence or line ends (Wave B PR 4, lane recall; N14 large-page fidelity).
 *
 * 1. Protects: when the chunker's hard cap (capByChars) has to cut a merged run, the segmented chunker cuts at a
 *    sentence end, else a line end, else whitespace, searched back from the bound over at most CUT_LOOKBACK_CHARS, so a
 *    needle sentence sits whole in one chunk. N14's 24 MiB chat missed one needle because chunk 7138 ended
 *    "...the <place> harbor pilot is <first name>" and the surname opened the next chunk: the run was just over the
 *    2,000-token budget, the window derived from its density ended mid-line and the next window started 310 characters
 *    back. This file reduces that layout to a 5.9 KB one-day chat (placeholder speakers) whose old cut lands inside the
 *    needle sentence.
 * 2. Fails when: a segmented chunk ends inside a line of a chat (old cuts), a chunk exceeds maxChunkTokens, chunk spans
 *    stop tiling the text, the cut search stops being bounded per window (a newline-free or whitespace-free segment
 *    would chunk in quadratic work), or SEGMENTED_CHUNKER_VERSION stops naming the new cuts.
 * 3. Existing coverage: test/large-pages/inline-chunks-golden.test.ts pins inline chunks byte for byte (the option is
 *    off there); test/chunker-spans-linear.slow.test.ts bounds the span bookkeeping.
 * 4. No production seam: pure functions.
 */
import { describe, expect, test } from 'bun:test';
import * as recursive from '../../src/core/chunkers/recursive.ts';
import { estimateEmbedTokens } from '../../src/core/chunkers/token-estimate.ts';
import { initialEntryState } from '../../src/core/page-body/entry-state.ts';
import { segmentString } from '../../src/core/page-body/segmenter.ts';
import * as segmentChunks from '../../src/core/page-body/segment-chunks.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../../src/core/search/safe-chunks.ts';
import { N14_REDUCED, NEEDLE, needleChat } from '../helpers/needle-chat.ts';
import { segmentOptions } from '../helpers/segment-bodies.ts';

const MAX_TOKENS = 2000;
const OLD = { maxTokens: MAX_TOKENS, spans: true, headingsLead: true } as const;

async function segmentedChunks(text: string, maxChunkTokens = MAX_TOKENS) {
  const segments = segmentString(text, initialEntryState({ region: 'truth' }), segmentOptions('trusted'));
  expect(segments.length).toBe(1);
  return segmentChunks.prepareSegmentChunks(segments[0]!, { fenceTrust: 'trusted', maxChunkTokens });
}

/** Chunk spans (UTF-8 byte offsets into `text`) cover its non-whitespace content with no gap. */
function expectTiles(text: string, spans: Array<{ start: number; end: number }>): void {
  const bytes = Buffer.from(text);
  const first = bytes.findIndex(b => b > 0x20);
  let last = bytes.length;
  while (last > 0 && bytes[last - 1]! <= 0x20) last--;
  expect(spans[0]!.start).toBeLessThanOrEqual(first);
  for (let i = 1; i < spans.length; i++) {
    const gap = bytes.subarray(spans[i - 1]!.end, Math.max(spans[i - 1]!.end, spans[i]!.start));
    expect(gap.every(b => b <= 0x20)).toBe(true);
  }
  expect(Math.max(...spans.map(s => s.end))).toBeGreaterThanOrEqual(last);
}

describe('forced cuts in the segmented chunker', () => {
  test('N14 24 MiB needle: the old cut splits the sentence across two chunks; the segmented chunker keeps it whole in one', async () => {
    const old = recursive.chunkProjectedText(N14_REDUCED, OLD).map(c => c.text);
    const split = old.find(t => t.includes('Fennmere') && !t.includes(NEEDLE));
    expect(split).toBeDefined();
    const tail = split!.slice(split!.lastIndexOf('noting here that ') + 'noting here that '.length);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(NEEDLE.length);
    expect(NEEDLE.startsWith(tail)).toBe(true);

    const chunks = await segmentedChunks(N14_REDUCED);
    const holding = chunks.filter(c => c.chunk_text.includes('Fennmere'));
    expect(holding.length).toBeGreaterThan(0);
    for (const c of holding) expect(c.chunk_text).toContain(NEEDLE);
    expect(segmentChunks.SEGMENTED_CHUNKER_VERSION).toBeGreaterThan(recursive.MARKDOWN_CHUNKER_VERSION);
    expect(segmentChunks.SEGMENTED_CHUNKER_VERSION).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
  });

  test('in a chat every segmented chunk ends at a line end (a word end when a line outgrows the look-back), fits maxChunkTokens and the spans tile the segment', async () => {
    const text = [3, 5, 7].map(seed => needleChat(seed, 400, -1)).join('\n');
    const bytes = Buffer.from(text);
    // At 128 tokens the window is about 190 characters, so its look-back (a quarter) is shorter than a chat line.
    for (const [max, ends] of [[MAX_TOKENS, [0x0a]], [512, [0x0a]], [128, [0x0a, 0x20]]] as const) {
      const chunks = await segmentedChunks(text, max);
      for (const c of chunks) {
        expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(max);
        expect(c.projected_byte_end === bytes.length || (ends as readonly number[]).includes(bytes[c.projected_byte_end!]!)).toBe(true);
      }
      expectTiles(text, chunks.map(c => ({ start: c.projected_byte_start!, end: c.projected_byte_end! })));
    }
  }, 60_000);

  for (const [name, make] of [
    ['newline-free prose', (chars: number) => 'the harbor pilot checks the tide tables. '.repeat(Math.ceil(chars / 41)).slice(0, chars)],
    ['whitespace-free text', (chars: number) => 'Qx7'.repeat(Math.ceil(chars / 3)).slice(0, chars)],
  ] as const) {
    test(`a ${name} 1 MiB segment chunks in linear work: the cut search visits at most CUT_LOOKBACK_CHARS per chunk`, () => {
      const work = (chars: number) => {
        const text = make(chars);
        recursive.cutWork.scanned = 0;
        const chunks = recursive.chunkProjectedText(text, { ...OLD, boundaryCuts: true });
        for (const c of chunks) expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(MAX_TOKENS);
        expectTiles(text, chunks.map(c => ({ start: c.byte_start!, end: c.byte_end! })));
        expect(recursive.cutWork.scanned).toBeLessThanOrEqual(recursive.CUT_LOOKBACK_CHARS * chunks.length);
        return { chunks: chunks.length, scanned: recursive.cutWork.scanned };
      };
      const half = work(512 * 1024);
      const full = work(1024 * 1024);
      expect(full.chunks / half.chunks).toBeLessThan(2.1);
      expect(full.scanned / Math.max(1, half.scanned)).toBeLessThan(2.1);
    }, 60_000);
  }
});
