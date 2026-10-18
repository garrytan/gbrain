/**
 * The Wave B segmenter cuts one region of a page's stored stream into
 * segments of at most SEGMENT_MAX_BYTES, spec section 2.
 *
 * 1. Protects: lossless storage (segments concatenate to the input, valid
 *    UTF-8, never over 1 MiB, CRLF kept whole), append-stability and resume
 *    (what makes an append O(last segment)), the never-cut zones (what makes
 *    per-segment privacy and parsing exact), and the per-segment projection
 *    metadata a windowed read is built from.
 * 2. Fails when: a cut looks forward, lands inside a fence, protected region,
 *    key margin, timeline detail run, marker bullet or withdrawal block, a
 *    forced cut splits a code point or a CRLF, resumed state diverges from a
 *    full run, or the joined per-segment projection differs from
 *    credentialSafeProjection(sanitizeRemoteBody(body)).
 * 3. Existing coverage: none; the segmenter is new in Wave B.
 * 4. No production seam: pure functions over strings and bytes.
 */
import { describe, expect, test } from 'bun:test';
import { markdownFenceTrusted } from '../../src/core/fence-scan.ts';
import { sanitizeRemoteBody } from '../../src/core/remote-body.ts';
import { credentialSafeProjection } from '../../src/core/credential-projection.ts';
import { stripMaterializedMarkers } from '../../src/core/timeline-marker.ts';
import { pageOutline } from '../../src/core/page-window/window.ts';
import { pickHeadPattern } from '../../src/core/conversation-parser/parse.ts';
import { initialEntryState, isCleanResumePoint, readEntryState, timelineEntryState } from '../../src/core/page-body/entry-state.ts';
import { PEM_CONTEXT_CHARS } from '../../src/core/page-body/region-scan.ts';
import { SEGMENT_MAX_BYTES, SEGMENT_MIN_BYTES } from '../../src/core/page-body/limits.ts';
import { regionFlags, Segmenter, segmentStream, segmentString, type SegmentOut } from '../../src/core/page-body/segmenter.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import {
  bigPage, FACTS_BLOCK, joinedProjection, KEY_BODY, MARKER_BULLET, PEM_BEGIN_RSA, PEM_BLOCK, PEM_END_RSA, pick, segmentOptions, segmentPieces, segmentShapeErrors, soup,
} from '../helpers/segment-bodies.ts';

const MAX = SEGMENT_MAX_BYTES;
const truthEntry = () => initialEntryState({ region: 'truth' });
const trustOf = (body: string) => markdownFenceTrusted(stripMaterializedMarkers(body)) ? 'trusted' as const : 'void' as const;
const cuts = (segs: readonly SegmentOut[]) => segs.map(s => s.byteStart);
const fingerprint = (s: SegmentOut) => JSON.stringify({
  byteStart: s.byteStart, len: s.bytes.length, lineStart: s.lineStart, lineCount: s.lineCount, cutKind: s.cutKind,
  sha: Buffer.from(s.sha256).toString('hex'), entry: s.entryState, exit: s.exitState, regions: s.protectedRegions,
  facts: s.factsSlots, proj: [s.staticProjBytes, s.staticProjLines], outline: s.outline, dates: [s.dateMin, s.dateMax],
});
const KEY_COUNT = (s: string) => s.split(KEY_BODY).length - 1;

/** Whether `a` is `b` with some characters deleted (shows nothing `b` does not). */
function isSubsequence(a: string, b: string): boolean {
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    j = b.indexOf(a[i]!, j);
    if (j === -1) return false;
    j++;
  }
  return true;
}

function filler(bytes: number): string {
  const line = 'plain words without structure '.repeat(3) + '\n';
  return line.repeat(Math.ceil(bytes / line.length));
}

describe('lossless segments', () => {
  test('multi-MiB pages: concatenation, bounds, UTF-8, offsets, line counts, any feed chunking', () => {
    const r = mulberry32(11);
    for (const crlf of [false, true]) {
      const body = bigPage(r, 3_000_000, { crlf });
      const bytes = Buffer.from(body, 'utf8');
      const segs = segmentPieces(body, segmentOptions(trustOf(body)), () => 1 + Math.floor(r() * 300_000));
      expect(segmentShapeErrors(bytes, segs, MAX)).toEqual([]);
      expect(segs.length).toBeGreaterThan(5);
      expect(segs.slice(0, -1).every(s => s.bytes.length >= SEGMENT_MIN_BYTES)).toBe(true);
      expect(segs.reduce((n, s) => n + s.lineCount, 0)).toBe(body.split('\n').length - 1);
      segs.forEach((s, i) => { if (i > 0) expect(s.lineStart).toBe(segs[i - 1]!.lineStart + segs[i - 1]!.lineCount); });
      expect(segs.slice(0, -1).every(s => s.cutKind !== 'forced')).toBe(true);
      expect(segs[segs.length - 1]!.cutKind).toBe('eof');
      expect(segs.map(fingerprint)).toEqual(segmentString(body, truthEntry(), segmentOptions(trustOf(body))).map(fingerprint));
    }
  });

  test('newline-free input is cut at 1 MiB, the open line carried as mid-line', () => {
    const body = 'x'.repeat(3 * MAX + 12_345);
    const segs = segmentString(body, truthEntry(), segmentOptions('trusted'));
    expect(segs.map(s => s.bytes.length)).toEqual([MAX, MAX, MAX, 12_345]);
    expect(segs.map(s => s.cutKind)).toEqual(['forced', 'forced', 'forced', 'eof']);
    expect(segs.slice(1).every(s => s.entryState.at === 'mid')).toBe(true);
    expect(segmentShapeErrors(Buffer.from(body), segs, MAX)).toEqual([]);
  });

  test('4-byte code points at a forced cut stay whole', () => {
    for (const lead of ['', 'a', 'ab', 'abc']) {
      const body = lead + '😀'.repeat(MAX / 2) + '\n' + 'é'.repeat(MAX);
      const bytes = Buffer.from(body, 'utf8');
      const segs = segmentString(body, truthEntry(), segmentOptions('trusted'));
      expect(segmentShapeErrors(bytes, segs, MAX)).toEqual([]);
      expect(segs.some(s => s.bytes.length < MAX && s.cutKind === 'forced')).toBe(true);
    }
  });

  test('a cut never falls between \\r and \\n, and bare \\r ends a line', () => {
    for (const eol of ['\r\n', '\r', '\n']) {
      for (const pad of [0, 1, 2]) {
        const body = 'y'.repeat(MAX - pad) + eol + 'z' + eol + 'y'.repeat(MAX + 7) + eol + 'tail';
        const segs = segmentString(body, truthEntry(), segmentOptions('trusted'));
        expect(segmentShapeErrors(Buffer.from(body), segs, MAX)).toEqual([]);
        for (let i = 1; i < segs.length; i++) {
          const prev = segs[i - 1]!.bytes;
          expect(prev[prev.length - 1] === 13 && segs[i]!.bytes[0] === 10).toBe(false);
        }
      }
    }
  });

  test('segmentStream over byte chunks split inside code points equals segmentString', async () => {
    const r = mulberry32(5);
    const body = bigPage(r, 1_500_000);
    const bytes = Buffer.from(body, 'utf8');
    async function* feed() {
      for (let i = 0; i < bytes.length;) {
        const k = 1 + Math.floor(r() * 70_000);
        yield bytes.subarray(i, i + k);
        i += k;
      }
    }
    const got: SegmentOut[] = [];
    for await (const s of segmentStream(feed(), truthEntry(), segmentOptions(trustOf(body)))) got.push(s);
    expect(got.map(fingerprint)).toEqual(segmentString(body, truthEntry(), segmentOptions(trustOf(body))).map(fingerprint));
  });

  test('invalid UTF-8 is refused', async () => {
    async function* feed() { yield new Uint8Array([0x61, 0xff, 0x62]); }
    await expect((async () => { for await (const _ of segmentStream(feed(), truthEntry(), segmentOptions('trusted'))) { /* drain */ } })()).rejects.toThrow();
  });
});

describe('append-stability and resume', () => {
  test('cuts of segment(A) except the last are a prefix of the cuts of segment(A+B)', () => {
    const r = mulberry32(21);
    for (let t = 0; t < 4; t++) {
      const body = bigPage(r, 2_500_000, { crlf: t % 2 === 1 });
      const full = segmentString(body, truthEntry(), segmentOptions(trustOf(body)));
      for (let k = 0; k < 4; k++) {
        let at = Math.floor(body.length * (0.2 + r() * 0.7));
        const c = body.charCodeAt(at - 1);
        if (c >= 0xd800 && c <= 0xdbff) at++;
        const prefix = segmentString(body.slice(0, at), truthEntry(), segmentOptions(trustOf(body)));
        const stable = prefix.slice(0, -1);
        expect(stable.map(s => [s.byteStart, s.bytes.length, s.cutKind])).toEqual(full.slice(0, stable.length).map(s => [s.byteStart, s.bytes.length, s.cutKind]));
        expect(stable.map(s => JSON.stringify(s.entryState))).toEqual(full.slice(0, stable.length).map(s => JSON.stringify(s.entryState)));
      }
    }
  });

  test('segmenting from a stored entry state reproduces the full run', () => {
    const r = mulberry32(31);
    for (const crlf of [false, true]) {
      const body = bigPage(r, 3_000_000, { crlf });
      const bytes = Buffer.from(body, 'utf8');
      const trust = trustOf(body);
      const full = segmentString(body, truthEntry(), segmentOptions(trust));
      for (let k = 1; k < full.length; k++) {
        const s = full[k]!;
        const entry = readEntryState(JSON.parse(JSON.stringify(s.entryState)));
        expect(entry).not.toBeNull();
        const resumed = segmentString(bytes.subarray(s.byteStart).toString('utf8'), entry!, segmentOptions(trust, { byteStart: s.byteStart, lineStart: s.lineStart }));
        if (isCleanResumePoint(s.entryState)) expect(resumed.map(fingerprint)).toEqual(full.slice(k).map(fingerprint));
        else expect(cuts(resumed)).toEqual(cuts(full.slice(k)));
      }
    }
  });

  test('resume after forced cuts (giant line, giant fence) reproduces the full run', () => {
    const body = 'head\n' + 'x'.repeat(2 * MAX + 999) + '\n```\n' + 'code line\n'.repeat(250_000) + '```\n## after\n' + filler(300_000);
    const full = segmentString(body, truthEntry(), segmentOptions(trustOf(body)));
    const bytes = Buffer.from(body, 'utf8');
    for (let k = 1; k < full.length; k++) {
      const s = full[k]!;
      const resumed = segmentString(bytes.subarray(s.byteStart).toString('utf8'), s.entryState, segmentOptions(trustOf(body), { byteStart: s.byteStart, lineStart: s.lineStart }));
      expect(resumed.map(fingerprint)).toEqual(full.slice(k).map(fingerprint));
    }
  });

  test('cuts are the same under either fence trust (a trust flip moves regions, never a cut)', () => {
    const r = mulberry32(41);
    const body = bigPage(r, 2_000_000) + '```\nunclosed\n' + bigPage(r, 1_000_000);
    expect(cuts(segmentString(body, truthEntry(), segmentOptions('trusted')))).toEqual(cuts(segmentString(body, truthEntry(), segmentOptions('void'))));
  });
});

describe('never-cut zones', () => {
  const after = '\n## after the zone\n';
  const zones: Array<[string, string]> = [
    ['open code fence', '```\n' + ('## heading inside the fence\n\n' + filler(2_000)).repeat(40) + '```\n'],
    ['takes region', '<!--- gbrain:takes:begin -->\n' + ('## heading inside takes\n\n' + filler(2_000)).repeat(40) + '<!--- gbrain:takes:end -->\n'],
    ['facts / withdrawal fence block', FACTS_BLOCK.replace('|---|', '\n## heading in facts\n\n|---|') + FACTS_BLOCK],
    ['private key plus margin', PEM_BLOCK + ('\n## heading after a key\n\n' + 'tail words\n').repeat(Math.floor((PEM_CONTEXT_CHARS - 100) / 36))],
    ['timeline entry detail run', '- **2024-01-02** | src — entry\n\nplain detail text that continues the entry\n'],
    ['marker and its bullet', MARKER_BULLET],
  ];
  for (const [name, zone] of zones) {
    test(name, () => {
      const lead = filler(420_000);
      const body = lead + zone + after + filler(200_000);
      const segs = segmentString(body, truthEntry(), segmentOptions(trustOf(body)));
      const start = Buffer.byteLength(lead);
      const end = start + Buffer.byteLength(zone);
      const inside = cuts(segs).filter(c => c > start && c < end);
      expect(inside).toEqual([]);
      if (name !== 'private key plus margin') expect(cuts(segs)).toContain(end + 1);
    });
  }

  test('a private key keeps the next cut PEM_CONTEXT_CHARS away in the projection', () => {
    const lead = filler(420_000);
    const body = lead + PEM_BLOCK + ('## heading\n\nwords\n').repeat(3_000);
    const segs = segmentString(body, truthEntry(), segmentOptions('trusted'));
    const keyEnd = Buffer.byteLength(lead + PEM_BLOCK) - 1;
    const next = cuts(segs).find(c => c > Buffer.byteLength(lead));
    expect(next! - keyEnd).toBeGreaterThanOrEqual(PEM_CONTEXT_CHARS - 1);
  });
});

describe('forced cuts with open state', () => {
  test('a giant fence: forced cuts at line starts, the fence carried, a structural cut after it closes', () => {
    const body = filler(100_000) + '```\n' + ('## not a heading\n' + 'code line here\n'.repeat(20)).repeat(9_000) + '```\n' + '## real heading\n' + filler(400_000) + '## next\n' + filler(10_000);
    const segs = segmentString(body, truthEntry(), segmentOptions('trusted'));
    expect(segmentShapeErrors(Buffer.from(body), segs, MAX)).toEqual([]);
    const inFence = segs.filter(s => s.entryState.trusted.walk.fence === '`');
    expect(inFence.length).toBeGreaterThan(1);
    expect(inFence.every(s => s.entryState.at === 'lf')).toBe(true);
    expect(segs.slice(0, -1).filter(s => s.exitState.trusted.walk.fence === '`').every(s => s.cutKind === 'forced')).toBe(true);
    expect(segs.some(s => s.cutKind === 'heading')).toBe(true);
    expect(segs.every(s => s.outline.every(h => h.text !== 'not a heading'))).toBe(true);
  });

  test('an unterminated fence: only forced cuts after it, every segment bounded', () => {
    const body = filler(100_000) + '~~~\n' + '## inside\n\nline\n'.repeat(200_000);
    const segs = segmentString(body, truthEntry(), segmentOptions(trustOf(body)));
    expect(trustOf(body)).toBe('void');
    expect(segmentShapeErrors(Buffer.from(body), segs, MAX)).toEqual([]);
    expect(segs.slice(0, -1).every(s => s.cutKind === 'forced')).toBe(true);
  });

  test('an unterminated protected region: open takes runs, the truncated tail at EOF, later segments project nothing', () => {
    const lead = filler(200_000);
    const body = lead + '<!--- gbrain:takes:begin -->\n' + ('## secret heading\n\n' + filler(1_000)).repeat(3_000);
    const segs = segmentString(body, truthEntry(), segmentOptions('trusted'));
    const flags = regionFlags(segs[segs.length - 1]!.exitState, 'trusted');
    expect(flags.protectedTailFrom).toBe(Buffer.byteLength(lead));
    expect(segs.length).toBeGreaterThan(2);
    for (const [i, s] of segs.entries()) {
      if (i === 0) continue;
      expect(s.staticProjBytes).toBe(0);
      const kind = i === segs.length - 1 ? 'tail' : 'takes';
      expect(s.protectedRegions).toEqual([expect.objectContaining({ kind, start: 0, end: s.bytes.length, open_start: Buffer.byteLength(lead) })]);
    }
    expect(joinedProjection(Buffer.from(body), segs)).toBe(credentialSafeProjection(sanitizeRemoteBody(body)));
  });

  test('after a truncated tail, closed segments are released without waiting for EOF', () => {
    const lead = filler(200_000);
    const body = lead + '<!--- gbrain:takes:begin -->\nsecret\n<!--- gbrain:facts:begin -->\n' + filler(4 * MAX);
    const seg = new Segmenter(truthEntry(), segmentOptions('trusted'));
    const early: SegmentOut[] = [];
    for (let i = 0; i < body.length; i += 256 * 1024) early.push(...seg.push(body.slice(i, i + 256 * 1024)));
    const all = [...early, ...seg.finish()];
    expect(early.length).toBeGreaterThanOrEqual(3);
    expect(all.map(fingerprint)).toEqual(segmentString(body, truthEntry(), segmentOptions('trusted')).map(fingerprint));
    expect(regionFlags(all[all.length - 1]!.exitState, 'trusted').protectedTailFrom).toBe(Buffer.byteLength(lead));
  });

  for (const [name, open, close] of [
    ['an unterminated takes block', '<!--- gbrain:takes:begin -->\n', ''],
    ['a closed takes block', '<!--- gbrain:takes:begin -->\n', '<!--- gbrain:takes:end -->\n'],
    ['a giant facts fence', '<!--- gbrain:facts:begin -->\n', '<!--- gbrain:facts:end -->\n'],
  ] as const) {
    test(`${name} longer than the hold bound: segments leave as they close, the same for any feed chunking`, () => {
      const body = filler(200_000) + KEY_BODY + '\n' + open + filler(12 * MAX) + close + '## after\n' + filler(300_000);
      const seg = new Segmenter(truthEntry(), segmentOptions('trusted'));
      const early: SegmentOut[] = [];
      let maxHeld = 0;
      for (let i = 0; i < body.length; i += 256 * 1024) {
        early.push(...seg.push(body.slice(i, i + 256 * 1024)));
        const closed = Buffer.byteLength(body.slice(0, Math.min(body.length, i + 256 * 1024))) - early.reduce((n, x) => n + x.bytes.length, 0);
        maxHeld = Math.max(maxHeld, closed);
      }
      const all = [...early, ...seg.finish()];
      expect(maxHeld).toBeLessThanOrEqual(4 * MAX);
      expect(all.map(fingerprint)).toEqual(segmentString(body, truthEntry(), segmentOptions('trusted')).map(fingerprint));
      const r = mulberry32(name.length);
      expect(all.map(fingerprint)).toEqual(segmentPieces(body, segmentOptions('trusted'), () => 1 + Math.floor(r() * 400_000)).map(fingerprint));
      const bytes = Buffer.from(body, 'utf8');
      expect(segmentShapeErrors(bytes, all, MAX)).toEqual([]);
      expect(isSubsequence(joinedProjection(bytes, all), credentialSafeProjection(sanitizeRemoteBody(body)))).toBe(true);
    }, 60_000);
  }

  test('released early, a segment never shows what whole-body sanitization hides (key lines around giant regions)', () => {
    const r = mulberry32(91);
    const keyish = [`${KEY_BODY}\n`, `  ${KEY_BODY.slice(0, 40)}\n`, 'prose line here\n', '\n', `${PEM_BEGIN_RSA}\n`,
      `${PEM_END_RSA}\n`, `"k": "${KEY_BODY}\\n${KEY_BODY}\\n`, 'é😀\n', '## heading\n'];
    const regions = [['<!--- gbrain:takes:begin -->\n', '<!--- gbrain:takes:end -->\n'], ['<!--- gbrain:takes:begin -->\n', ''],
      ['<!--- gbrain:facts:begin -->\n', '<!--- gbrain:facts:end -->\n']];
    let guarded = 0;
    for (let t = 0; t < 12; t++) {
      const around = (n: number) => Array.from({ length: n }, () => pick(r, keyish)).join('');
      const [open, close] = pick(r, regions);
      const body = filler(Math.floor(r() * 300_000)) + around(1 + Math.floor(r() * 12)) + open + filler(Math.floor((2.5 + r() * 2) * MAX))
        + (close ? close + around(1 + Math.floor(r() * 12)) + filler(Math.floor(r() * 300_000)) : '');
      const bytes = Buffer.from(body, 'utf8');
      const segs = segmentPieces(body, segmentOptions(trustOf(body)), () => 1 + Math.floor(r() * 500_000));
      const want = credentialSafeProjection(sanitizeRemoteBody(body));
      const got = joinedProjection(bytes, segs);
      expect(isSubsequence(got, want)).toBe(true);
      expect(KEY_COUNT(got)).toBeLessThanOrEqual(KEY_COUNT(want));
      if (segs.some(s => s.protectedRegions.some(x => x.kind === 'pem_guard'))) guarded++;
      else if (!open.includes('facts')) expect(got).toBe(want);
    }
    expect(guarded).toBeGreaterThan(0);
  });

  test('a protected region crossing a forced cut: its start on both sides, its end where it ends', () => {
    const lead = filler(900_000);
    const region = '<!--- gbrain:takes:begin -->\n' + filler(400_000) + '<!--- gbrain:takes:end -->\n';
    const body = lead + region + filler(10_000);
    const segs = segmentString(body, truthEntry(), segmentOptions('trusted'));
    const start = Buffer.byteLength(lead);
    const end = start + Buffer.byteLength(region) - 1;
    const parts = segs.flatMap(s => s.protectedRegions.filter(r => r.kind === 'takes').map(r => ({ ...r, segStart: s.byteStart })));
    expect(parts.map(p => [p.open_start, p.open_end])).toEqual([[start, undefined], [start, end]]);
  });
});

describe('per-segment projection', () => {
  test('joined segment projections equal the whole-body projection (fuzz soup)', () => {
    const r = mulberry32(51);
    let mixed = 0;
    for (let t = 0; t < 1500; t++) {
      const body = soup(r);
      const segs = segmentPieces(body, segmentOptions(trustOf(body)), () => 1 + Math.floor(r() * 12));
      const bytes = Buffer.from(body, 'utf8');
      expect(segmentShapeErrors(bytes, segs, MAX)).toEqual([]);
      const want = credentialSafeProjection(sanitizeRemoteBody(body));
      const got = joinedProjection(bytes, segs);
      if (body.includes('gbrain:facts:begin') && body.includes('PRIVATE KEY-----')) {
        mixed++;
        expect(KEY_COUNT(got)).toBeLessThanOrEqual(KEY_COUNT(want));
      } else {
        expect(got).toBe(want);
      }
    }
    expect(mixed).toBeGreaterThan(0);
  });

  test('joined projections equal the whole-body projection across many segments', () => {
    const r = mulberry32(61);
    for (let t = 0; t < 3; t++) {
      const body = bigPage(r, 2_500_000, { crlf: t === 1, keys: t !== 2 });
      const segs = segmentString(body, truthEntry(), segmentOptions(trustOf(body)));
      expect(segs.length).toBeGreaterThan(4);
      expect(joinedProjection(Buffer.from(body), segs)).toBe(credentialSafeProjection(sanitizeRemoteBody(body)));
    }
  });

  test('static projection sizes, lines, outline and dates match the joined static projection', () => {
    const r = mulberry32(71);
    const body = bigPage(r, 2_500_000, { facts: false });
    const segs = segmentString(body, truthEntry(), segmentOptions(trustOf(body)));
    const stat = joinedProjection(Buffer.from(body), segs, false);
    expect(segs.reduce((n, s) => n + s.staticProjBytes, 0)).toBe(Buffer.byteLength(stat));
    expect(segs.reduce((n, s) => n + s.staticProjLines, 0)).toBe(stat.split('\n').length - 1);
    let base = 0;
    const outline: Array<{ byte: number; level: number; text: string }> = [];
    for (const s of segs) {
      expect(s.outline.length).toBeLessThanOrEqual(64);
      for (const h of s.outline) outline.push({ byte: base + h.proj_byte, level: h.level, text: h.text });
      base += s.staticProjBytes;
    }
    const want = pageOutline(Buffer.from(stat), 0, 100_000).entries.filter(e => e.heading !== null)
      .map(e => ({ byte: e.byte_start, level: e.level!, text: e.heading! }));
    expect(outline).toEqual(want);
    const dates = [...stat.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m => m[0]).sort();
    expect(segs.map(s => s.dateMin).filter(Boolean).sort()[0]).toBe(dates[0]);
    expect(segs.map(s => s.dateMax).filter(Boolean).sort().pop()).toBe(dates[dates.length - 1]);
  });

  test('facts regions are slots: zero static bytes, the raw fence kept for read-time rendering', () => {
    const body = 'intro\n' + FACTS_BLOCK + 'outro\n';
    const [seg] = segmentString(body, truthEntry(), segmentOptions('trusted'));
    expect(seg!.factsSlots).toEqual([{ proj_byte: Buffer.byteLength('intro\n'), start: 6, end: 6 + Buffer.byteLength(FACTS_BLOCK) - 1 }]);
    expect(seg!.staticProjBytes).toBe(Buffer.byteLength('intro\n\noutro\n'));
  });
});

describe('regions of a page', () => {
  test('truth then timeline: the region boundary cuts, offsets and lines continue', () => {
    const r = mulberry32(81);
    const truth = bigPage(r, 1_500_000);
    const timeline = bigPage(r, 900_000);
    const t = segmentString(truth, truthEntry(), segmentOptions(trustOf(truth), { end: 'region_end' }));
    const last = t[t.length - 1]!;
    expect(last.cutKind).toBe('region_end');
    const tl = segmentString(timeline, timelineEntryState(last.exitState), segmentOptions(trustOf(timeline), {
      byteStart: last.byteStart + last.bytes.length, lineStart: last.lineStart + last.lineCount,
    }));
    expect(tl[0]!.byteStart).toBe(Buffer.byteLength(truth));
    expect(tl.every(s => s.region === 'timeline')).toBe(true);
    expect(tl[tl.length - 1]!.cutKind).toBe('eof');
    expect(segmentShapeErrors(Buffer.from(timeline), tl, MAX, Buffer.byteLength(truth))).toEqual([]);
  });

  test('conversation pages cut at the winning pattern\'s message anchors', () => {
    const lines: string[] = [];
    for (let i = 0; lines.join('').length < 1_200_000; i++) {
      lines.push(`**alice-example** (2024-03-${String(1 + (i % 28)).padStart(2, '0')} 10:${String(i % 60).padStart(2, '0')} AM): ${'message words '.repeat(30)}\n`);
    }
    const body = lines.join('');
    const entry = initialEntryState({ region: 'truth', conversationPattern: pickHeadPattern(body.slice(0, 64 * 1024)) });
    expect(entry.conversation.pattern).toBe('imessage-slack');
    const segs = segmentString(body, entry, segmentOptions('trusted'));
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.slice(0, -1).every(s => s.cutKind === 'message')).toBe(true);
  });
});
