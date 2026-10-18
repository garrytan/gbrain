/**
 * The segmenter is linear in the input, and appending through a stored entry
 * state is linear in the appended text (plus one segment).
 *
 * 1. Protects: ingest of a 256 MB page and repeated appends to a large page
 *    stay O(bytes); a cut decision that rescans the open segment, or an
 *    append that resegments the page, would make both quadratic.
 * 2. Measures work, not time: `segmenterWork` (line and piece events; units the
 *    per-line passes read: cut-candidate classifiers and gear hash, blockers,
 *    line state, projection, long-piece fit and remainder; bookkeeping entries
 *    visited; units each emitted segment's join, copy, hash, projection parts,
 *    outline and dates read) and `regionScanWork` (units the line split, token
 *    search with its carry, fence probe, byte counts and inline-code scan read;
 *    projection units the PEM scan appends, searches, walks, claims and copies
 *    on trim; PEM cut, claim and fence entries visited). Thread CPU time grows
 *    when a co-tenant on a sibling vCPU slows one size (1.06-1.65x on CI), so a
 *    time ratio flakes on linear code; counts are the same on every machine.
 *    A new loop over the input or over carried state must count its work too.
 * 3. Fails when: at n and 2n bytes, for prose, short lines, one newline-free
 *    line, a giant fence, an unterminated protected region and key-dense text,
 *    or for the resuming append, a counter exceeds its per-byte bound or (with
 *    at least MIN_RATIO_COUNT counts at n) grows 2.1x or more.
 * 4. Forced probes: a cut search that rescans everything pushed so far (the
 *    whole prefix re-pushed into a fresh Segmenter before each 16 KiB push,
 *    256 and 512 KiB of giant fence) and an append path that resegments the
 *    whole page per 64 KiB append (256 and 512 KiB) both run through the
 *    counted code, and their doubling ratios exceed the bound.
 * 5. Inflation probe: the large size run while a co-tenant burns 60% extra
 *    thread CPU gives the same counts and passes the same bounds. The old
 *    CPU-time exponent at 4x read 1.34-1.48 there for every shape and the
 *    resuming append (0.93-1.04 plain), past its 1.3 bound.
 * 6. Measured (deterministic; per byte at n, doubling ratio x):
 *    - mixed page (1 MiB): lines 0.014 x1.99, chars 3.55 x2.01, entries 0.043
 *      x1.90, emitted 7.60 x2.01, region chars 11.4 x2.00, pem 3.06 x2.00.
 *    - short lines (512 KiB): lines 0.50, chars 3.44 x2.02, entries 1.13,
 *      emitted 8.0, region chars 11.0, pem 3.26 (x2.00 where not given).
 *    - one newline-free line (4 MiB): chars 4.19 x2.02, emitted 8.0, region
 *      chars 19.0, pem 3.11 x2.01; lines 14, entries 41 and region entries 21
 *      sit under the ratio floor.
 *    - giant fence (1 MiB): lines 0.107, chars 4.67, entries 0.24, emitted
 *      8.0, region chars 11.7, pem 3.23 x2.01.
 *    - unterminated protected region (1 MiB): lines 0.136, chars 2.61,
 *      entries 0.27, emitted 4.0, region chars 8.64, pem 0.
 *    - key-dense text (2 MiB): chars 3.92, entries 0.092 x2.02, emitted 5.69,
 *      region chars 10.6, pem 4.38, region entries 0.045 x2.02.
 *    - resuming append (2 MiB): lines 0.045 x2.01, chars 11.2, entries 0.126
 *      x1.98, emitted 24.6, region chars 37.3, pem 9.78 x1.99 (region
 *      entries 1,010, under the floor; at 1 MiB pem read x2.09, so this test
 *      runs at 2 MiB, where the last segment's size averages out).
 *    - probes: rescanning cut search lines x3.88, chars x4.22, region chars
 *      x3.88, pem x3.97; whole-page resegmenting per append chars x3.19,
 *      region chars x3.14.
 */
import { describe, expect, test } from 'bun:test';
import { initialEntryState } from '../../src/core/page-body/entry-state.ts';
import { regionScanWork } from '../../src/core/page-body/region-scan.ts';
import { Segmenter, segmenterWork, segmentString, type SegmentOut } from '../../src/core/page-body/segmenter.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { bigPage, PEM_BLOCK, segmentOptions } from '../helpers/segment-bodies.ts';
import {
  countWork, describeWork, linearityViolations, MAX_DOUBLING_RATIO, withCpuInflation, type Sample,
} from '../helpers/work-counts.ts';

const MB = 1024 * 1024;
const entry = () => initialEntryState({ region: 'truth' });

/** Per input byte, about 1.5-2x the largest measured value of any shape. */
const SEGMENT_PER_BYTE = {
  'segmenter.lines': 1, 'segmenter.chars': 8, 'segmenter.entries': 2, 'segmenter.emitted': 12,
  'region.chars': 32, 'region.pem': 8, 'region.entries': 0.1,
};
/** The resuming append re-reads the last segment per 64 KiB append. */
const APPEND_PER_BYTE = {
  'segmenter.lines': 1, 'segmenter.chars': 16, 'segmenter.entries': 2, 'segmenter.emitted': 40,
  'region.chars': 64, 'region.pem': 16, 'region.entries': 0.1,
};

const counters = { segmenter: segmenterWork, region: regionScanWork };
const sample = (body: string, run: (body: string) => unknown): Sample => ({ bytes: Buffer.byteLength(body), work: countWork(counters, () => run(body)) });

const page = bigPage(mulberry32(7), 4.5 * MB);
const prefix = (bytes: number) => page.slice(0, page.indexOf('\n', bytes) + 1);
const segmentAll = (body: string) => segmentString(body, entry(), segmentOptions('trusted'));

/** Segment `body` in `push`-char pushes, keeping only a count (ingest streams segments out). */
function segmentStreaming(body: string, push = 256 * 1024): number {
  const seg = new Segmenter(entry(), segmentOptions('trusted'));
  let n = 0;
  for (let i = 0; i < body.length; i += push) n += seg.push(body.slice(i, i + push)).length;
  return n + seg.finish().length;
}

const PROBE_PUSH = 16 * 1024;

/**
 * The quadratic cut search: before each 16 KiB push it re-reads everything pushed so far through a fresh
 * Segmenter, as a cut decision that rescans the open input instead of carrying its scan state would.
 */
function segmentRescanningCuts(body: string): number {
  let n = 0;
  for (let at = PROBE_PUSH; at < body.length + PROBE_PUSH; at += PROBE_PUSH) n = segmentStreaming(body.slice(0, at), PROBE_PUSH);
  return n;
}

const shapes: Array<[string, (bytes: number) => string, number]> = [
  ['mixed page', prefix, 1 * MB],
  ['short lines', bytes => 'a\n'.repeat(bytes / 2), MB / 2],
  ['one newline-free line', bytes => 'x'.repeat(bytes), 4 * MB],
  ['giant fence', bytes => '```\n' + '## not a heading\n\ncode line\n'.repeat(bytes / 28), 1 * MB],
  ['unterminated protected region', bytes => '<!--- gbrain:takes:begin -->\n' + '## secret\n\nwords here\n'.repeat(bytes / 23), 1 * MB],
  ['key-dense text', bytes => PEM_BLOCK.repeat(bytes / PEM_BLOCK.length), 2 * MB],
];

describe('the segmenter does linear work', () => {
  for (const [name, make, small] of shapes) {
    test(`${name}: work per byte is bounded and doubles with the input`, () => {
      const a = sample(make(small), segmentStreaming);
      const b = sample(make(2 * small), segmentStreaming);
      console.log(`[segmenter-linear] ${name}: ${describeWork(a, b)}`);
      expect(linearityViolations(a, b, SEGMENT_PER_BYTE)).toEqual([]);
    }, 120_000);
  }

  test('forced probe: a cut search that rescans the pushed input exceeds the bound', () => {
    const giantFence = shapes.find(([name]) => name === 'giant fence')!;
    const a = sample(giantFence[1](MB / 4), segmentRescanningCuts);
    const b = sample(giantFence[1](MB / 2), segmentRescanningCuts);
    console.log(`[segmenter-linear] giant fence, rescanning cut search (quadratic probe): ${describeWork(a, b)}`);
    expect(b.work['segmenter.chars']! / a.work['segmenter.chars']!).toBeGreaterThan(MAX_DOUBLING_RATIO);
    expect(b.work['region.chars']! / a.work['region.chars']!).toBeGreaterThan(MAX_DOUBLING_RATIO);
  }, 120_000);

  test('inflation probe: 60% extra CPU on the large size cannot move the counts', () => {
    const small = prefix(1 * MB);
    const large = prefix(2 * MB);
    const a = sample(small, segmentStreaming);
    const plain = sample(large, segmentStreaming);
    let cpu = { workMs: 0, totalMs: 0 };
    const inflated = sample(large, body => { cpu = withCpuInflation(() => segmentStreaming(body), 0.6); });
    console.log(`[segmenter-linear] mixed page, large size under a co-tenant: ${cpu.workMs.toFixed(0)} ms work, ${cpu.totalMs.toFixed(0)} ms thread CPU`);
    expect(inflated.work).toEqual(plain.work);
    expect(linearityViolations(a, inflated, SEGMENT_PER_BYTE)).toEqual([]);
  }, 120_000);
});

const STEP = 64 * 1024;

/** Append `body` in STEP-char writes, each resegmenting only the last segment from its stored entry state. */
function appendResuming(body: string): SegmentOut[] {
  const segs: SegmentOut[] = [];
  for (let at = 0; at < body.length; at += STEP) {
    const last = segs.pop();
    const tail = (last ? Buffer.from(last.bytes).toString('utf8') : '') + body.slice(at, at + STEP);
    segs.push(...segmentString(tail, last ? last.entryState : entry(), segmentOptions('trusted', {
      byteStart: last ? last.byteStart : 0, lineStart: last ? last.lineStart : 0,
    })));
  }
  return segs;
}

/** The quadratic variant: every append resegments the whole page. */
function appendResegmenting(body: string): SegmentOut[] {
  let segs: SegmentOut[] = [];
  for (let at = 0; at < body.length; at += STEP) segs = segmentAll(body.slice(0, Math.min(body.length, at + STEP)));
  return segs;
}

describe('appends through a stored entry state', () => {
  const ascii = (bytes: number) => prefix(bytes).replace(/[^\n -~]/g, 'u');

  test('reproduce a full run\'s cuts', () => {
    const body = ascii(1.5 * MB);
    expect(appendResuming(body).map(s => [s.byteStart, s.bytes.length, s.cutKind])).toEqual(segmentAll(body).map(s => [s.byteStart, s.bytes.length, s.cutKind]));
  });

  test('appended text: work per byte is bounded and doubles with the input', () => {
    const a = sample(ascii(2 * MB), appendResuming);
    const b = sample(ascii(4 * MB), appendResuming);
    console.log(`[segmenter-linear] appends resuming: ${describeWork(a, b)}`);
    expect(linearityViolations(a, b, APPEND_PER_BYTE)).toEqual([]);
  }, 120_000);

  test('forced probe: resegmenting the whole page per append exceeds the bound', () => {
    const a = sample(ascii(MB / 4), appendResegmenting);
    const b = sample(ascii(MB / 2), appendResegmenting);
    console.log(`[segmenter-linear] appends resegmenting (quadratic probe): ${describeWork(a, b)}`);
    expect(b.work['segmenter.chars']! / a.work['segmenter.chars']!).toBeGreaterThan(MAX_DOUBLING_RATIO);
    expect(b.work['region.chars']! / a.work['region.chars']!).toBeGreaterThan(MAX_DOUBLING_RATIO);
  }, 120_000);
});
