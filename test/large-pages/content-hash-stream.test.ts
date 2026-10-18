/**
 * Wave B (spec 1.4): content_hash computed as a resumable stream.
 *
 * Protects: `streamingContentHash(page) === contentHash(page)` for every page
 * and every segmentation of its regions on code-point boundaries (astral
 * characters, CRLF, control characters, quotes, backslashes, U+2028, empty
 * truth, empty timeline, tags in frontmatter or hoisted, ephemeral frontmatter
 * keys); resuming from a stored midstate after an append equals hashing from
 * scratch, for each resume rule; the stored state stays under 128 bytes; the
 * vendored SHA-256 equals node:crypto around every block boundary.
 * Fails when: the streamed envelope drifts from JSON.stringify's bytes (key
 * order, escaping, the `timeline || ''` default, the frontmatter/tags
 * normalization), the midstate does not round-trip, or the SHA-256 padding is
 * wrong at a boundary.
 * Why existing coverage misses it: test/content-hash-parity-3694.test.ts pins
 * contentHash's formula, not a second implementation of it.
 * Seams: none; pure functions.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { contentHash } from '../../src/core/utils.ts';
import type { PageInput } from '../../src/core/types.ts';
import { CONTENT_HASH_STATE_MAX_BYTES, ContentHashStream, streamingContentHash } from '../../src/core/page-body/content-hash-stream.ts';
import { ResumableSha256, SHA256_STATE_MAX_BYTES } from '../../src/core/page-body/sha256-resumable.ts';

const NUM_RUNS = 500;
const unit = fc.constantFrom('a', 'Z', ' ', '"', '\\', '\r', '\n', '\r\n', '\t', '\u0000', '\u001f', '\u007f', '\u2028', '\u2029',
  'é', '中', '😀', '𝄞', '/', '<', '{', '}', ':');
const text = fc.string({ unit, maxLength: 60 });
const key = fc.constantFrom('captured_at', 'ingested_at', 'quarantine', 'trust_tier', 'atoms_scan_hash', 'tags', 'source', 'date', 'nested');
const value = fc.oneof(text, fc.integer(), fc.boolean(), fc.constant(null), fc.array(text, { maxLength: 3 }), fc.dictionary(text, text, { maxKeys: 2 }));
const page = fc.record({
  title: text,
  type: fc.constantFrom('note', 'person', 'concept'),
  compiled_truth: text,
  timeline: fc.option(text, { nil: undefined }),
  frontmatter: fc.option(fc.dictionary(key, value, { maxKeys: 5 }), { nil: undefined }),
  tags: fc.option(fc.array(text, { maxLength: 4 }), { nil: undefined }),
}) as fc.Arbitrary<PageInput>;

/** Split `s` at the given fractions, always on code-point boundaries. */
function segments(s: string, cuts: number[]): string[] {
  const points = Array.from(s);
  const at = [...new Set(cuts.map(c => Math.floor(c * (points.length + 1))))].sort((x, y) => x - y);
  const out: string[] = [];
  let prev = 0;
  for (const c of at) { out.push(points.slice(prev, c).join('')); prev = c; }
  out.push(points.slice(prev).join(''));
  return out;
}

const cuts = fc.array(fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }), { maxLength: 6 });

describe('streamed content_hash', () => {
  test('equals contentHash for every page and segmentation', () => {
    fc.assert(fc.property(page, cuts, cuts, (p, truthCuts, timelineCuts) => {
      const stream = ContentHashStream.begin(p);
      for (const seg of segments(p.compiled_truth, truthCuts)) stream.pushTruth(seg);
      stream.beginTimeline();
      for (const seg of segments(p.timeline || '', timelineCuts)) stream.pushTimeline(seg);
      expect(stream.finish(p)).toBe(contentHash(p));
      expect(streamingContentHash(p)).toBe(contentHash(p));
    }), { numRuns: NUM_RUNS });
  });

  test('named shapes: empty regions, hoisted vs frontmatter tags, ephemeral keys', () => {
    const base: PageInput = { title: 'T', type: 'note', compiled_truth: '' };
    const shapes: PageInput[] = [
      base,
      { ...base, timeline: '' },
      { ...base, compiled_truth: '', timeline: 'only timeline' },
      { ...base, frontmatter: { tags: ['b', 'a'] } },
      { ...base, tags: ['b', 'a'] },
      { ...base, frontmatter: { captured_at: '2026-01-01', ingested_at: 'x', trust_tier: 'owner', atoms_scan_hash: 'abc', keep: 1 } },
      { ...base, compiled_truth: 'line\r\n"quoted" \\ back\u2028sep\u0000nul😀' },
      { ...base, frontmatter: { date: new Date(Date.UTC(2024, 5, 1)) } },
    ];
    for (const p of shapes) expect(streamingContentHash(p)).toBe(contentHash(p));
    expect(streamingContentHash(shapes[3]!)).toBe(streamingContentHash(shapes[4]!));
  });

  test('resume after append equals hashing from scratch, for each resume rule', () => {
    fc.assert(fc.property(page, text, text, (p, truthAppend, timelineAppend) => {
      const truth = p.compiled_truth;
      const timeline = p.timeline || '';
      const truthRow = ContentHashStream.begin(p).pushTruth(truth).exportState();
      const lastRow = ContentHashStream.fromState(truthRow).pushTimeline(timeline).exportState();

      // Append to the last region (the timeline): resume from the last row.
      const appendedTimeline = { ...p, timeline: timeline + timelineAppend };
      expect(ContentHashStream.fromState(lastRow).pushTimeline(timelineAppend).finish(p)).toBe(contentHash(appendedTimeline));

      // Append to the truth while the timeline is non-empty: resume from the last truth row, re-feed the timeline.
      const appendedTruth = { ...p, compiled_truth: truth + truthAppend };
      expect(ContentHashStream.fromState(truthRow).pushTruth(truthAppend).pushTimeline(timeline).finish(p)).toBe(contentHash(appendedTruth));

      // Frontmatter or tags change: resume from the last row with the new values.
      const retagged = { ...p, tags: ['zeta', 'alpha'], frontmatter: { ...(p.frontmatter ?? {}), added: truthAppend } };
      expect(ContentHashStream.fromState(lastRow).finish(retagged)).toBe(contentHash(retagged));

      // An empty timeline: the truth row is the last row.
      const noTimeline = { ...p, timeline: '', compiled_truth: truth + truthAppend };
      expect(ContentHashStream.fromState(truthRow).pushTruth(truthAppend).finish(p)).toBe(contentHash(noTimeline));
    }), { numRuns: NUM_RUNS });
  });

  test('finish leaves the stream usable and state stays under 128 bytes', () => {
    fc.assert(fc.property(page, (p) => {
      const stream = ContentHashStream.begin(p).pushTruth(p.compiled_truth);
      const before = stream.finish(p);
      expect(stream.finish(p)).toBe(before);
      expect(stream.exportState().length).toBeLessThanOrEqual(CONTENT_HASH_STATE_MAX_BYTES);
      expect(stream.pushTimeline(p.timeline || '').exportState().length).toBeLessThanOrEqual(128);
    }), { numRuns: NUM_RUNS });
    expect(() => ContentHashStream.begin({ title: 't', type: 'note' }).pushTimeline('x').pushTruth('y')).toThrow();
    expect(() => ContentHashStream.fromState(new Uint8Array([7, ...new Uint8Array(40)]))).toThrow();
  });
});

describe('ResumableSha256', () => {
  const native = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

  test('digest equals node:crypto around every block boundary, resumed at every split', () => {
    const lengths = new Set<number>();
    for (const k of [0, 1, 2, 3, 4, 8, 16]) for (const d of [-1, 0, 1]) { lengths.add(Math.max(0, 64 * k + d)); lengths.add(Math.max(0, 64 * k + 55 + d)); }
    for (let n = 0; n <= 130; n++) lengths.add(n);
    for (const n of lengths) {
      const data = new Uint8Array(n).map((_, i) => (i * 131 + n) & 0xff);
      const expected = native(data);
      expect(new ResumableSha256().update(data).digest()).toBe(expected);
      for (const split of [0, 1, n >> 1, Math.max(0, n - 1), n]) {
        const state = new ResumableSha256().update(data.subarray(0, split)).exportState();
        expect(state.length).toBeLessThanOrEqual(SHA256_STATE_MAX_BYTES);
        expect(ResumableSha256.fromState(state).update(data.subarray(split)).digest()).toBe(expected);
      }
    }
  });

  test('random lengths and chunkings', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 2000 }), fc.array(fc.nat(300), { maxLength: 8 }), (data, sizes) => {
      let hasher = new ResumableSha256();
      let at = 0;
      for (const size of sizes) {
        hasher = ResumableSha256.fromState(hasher.update(data.subarray(at, at + size)).exportState());
        at = Math.min(data.length, at + size);
      }
      hasher.update(data.subarray(at));
      expect(hasher.digest()).toBe(native(data));
    }), { numRuns: NUM_RUNS });
  });

  test('a state whose length disagrees with its byte count is refused', () => {
    const state = new ResumableSha256().update(new Uint8Array(70)).exportState();
    expect(() => ResumableSha256.fromState(state.subarray(0, state.length - 1))).toThrow();
    expect(() => ResumableSha256.fromState(new Uint8Array(10))).toThrow();
  });
});
