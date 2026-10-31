/**
 * Contextual synopsis per segment, PGLite arm (wave-b spec 8.6, PR 4 lane 4c), plus the pure window packing and the
 * inline input-hash golden. Cases: test/helpers/synopsis-segment-hash-cases.ts. Postgres arm:
 * test/e2e/synopsis-segment-hash-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { defineSynopsisSegmentHashCases } from '../helpers/synopsis-segment-hash-cases.ts';
import { acceptedEmbeddingInputHashes, embeddingInputHash, synopsisBodyHash } from '../../src/core/embedding-input-hash.ts';
import { SEGMENT_SYNOPSIS_WINDOW_BYTES, SYNOPSIS_DOC_MAX_CHARS, segmentSynopsisWindows } from '../../src/core/page-summary.ts';

let brain: AppendBrain;

beforeAll(async () => { brain = await openAppendBrain('pglite'); }, 120_000);
afterAll(async () => { await brain.close(); }, 120_000);

describe('synopsis segment hash [pglite]', () => {
  defineSynopsisSegmentHashCases({ getBrain: () => brain });
});

describe('inline synopsis input hash (golden)', () => {
  const chunks = [
    { chunk_text: 'Acme example kickoff notes.', chunk_source: 'compiled_truth' },
    { chunk_text: 'const x = 1;', chunk_source: 'fenced_code' },
    { chunk_text: 'diagram of the pipeline', chunk_source: 'image_asset' },
    { chunk_text: '2026-01-02 alice-example joined.', chunk_source: 'timeline' },
  ];
  const ctx = { column: 'embedding', model: 'openai:text-embedding-3-large', dimensions: 1536, title: 'Acme example notes', corpusGeneration: '0123456789abcdef', bodyHash: synopsisBodyHash(chunks) };

  test('the synopsisBodyHash-based input of a page read whole is byte for byte the pre-lane hash', () => {
    expect(ctx.bodyHash).toBe('7f24d78ef482a2ee487035dd1884bea7f9831fd9d14af23e4930ea5e9dd6fa49');
    expect(chunks.map(c => embeddingInputHash(ctx, 'per_chunk_synopsis', c))).toEqual([
      'da28bbb1c4442a2a14e20b354faebea5866bf6cb8cb5dfca46dec70eba442244',
      'c19d48403fee7292063b88db864ba4357b44b03865a98a5f9508d57dc8284cd3',
      '6b7641e37dd461f15fc48cdb29dc7b3d9e8cd270c145cb52e27a229cd89e3bb9',
      'd95ed96ff2c4b63da1e20dfe1639fae72ccb597bb0afbf906214de21cfc25d3b',
    ]);
    expect(chunks.map(c => embeddingInputHash(ctx, 'title', c))).toEqual([
      '9a035be9c3732fa1184b906484e7d9863d10c644161c1ed925975b81cca4ebd4',
      'fe291f01d54f51331864a6e28332a000d3a60abbb77c041844ef9640cb787701',
      'a203118d6e7b65138f9814f024802ea3b64bf1b961a76eeb6aa42ff727d0ca89',
      'fb81957f11ba923b11617aa6aa00269d130988bbd40d25da0b779c5f9594259a',
    ]);
    expect(acceptedEmbeddingInputHashes(ctx, 'per_chunk_synopsis', chunks[0]!)).toEqual([
      'da28bbb1c4442a2a14e20b354faebea5866bf6cb8cb5dfca46dec70eba442244',
      '9a035be9c3732fa1184b906484e7d9863d10c644161c1ed925975b81cca4ebd4',
    ]);
  });
});

describe('segmentSynopsisWindows (pure)', () => {
  test('packs a segment\'s chunks in order into windows the prompt never cuts; each chunk in exactly one window', () => {
    const lead = 'Lead paragraph. '.repeat(400);
    const rows = Array.from({ length: 40 }, (_, i) => ({ chunk_index: i, chunk_text: `chunk ${i} `.repeat(300), chunk_source: i === 7 ? 'image_asset' : 'compiled_truth' }));
    rows.push({ chunk_index: 40, chunk_text: 'x'.repeat(SEGMENT_SYNOPSIS_WINDOW_BYTES + 10), chunk_source: 'compiled_truth' });
    const windows = segmentSynopsisWindows(rows, lead);
    expect(windows.flatMap(w => w.chunks.map(c => c.chunk_index))).toEqual(rows.filter(r => r.chunk_source !== 'image_asset').map(r => r.chunk_index));
    expect(windows.at(-1)!.chunks.map(c => c.chunk_index)).toEqual([40]);
    expect(windows.length).toBeGreaterThan(2);
    for (const w of windows.slice(0, -1)) {
      expect(w.document.length).toBeLessThanOrEqual(SYNOPSIS_DOC_MAX_CHARS);
      expect(w.document.startsWith(lead)).toBe(true);
      expect(Buffer.byteLength(w.document) - Buffer.byteLength(lead)).toBeLessThanOrEqual(SEGMENT_SYNOPSIS_WINDOW_BYTES + 16);
      for (const c of w.chunks) expect(w.document).toContain(c.chunk_text);
    }
    expect(segmentSynopsisWindows(rows.slice(0, 3), '')[0]!.document).toBe(rows.slice(0, 3).map(r => r.chunk_text).join('\n\n'));
  });
});
