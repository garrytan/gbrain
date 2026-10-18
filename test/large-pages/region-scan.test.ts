/**
 * Streaming forms of the two whole-body privacy scans (page-body/region-scan.ts).
 *
 * 1. Protects: segmented pages find exactly the protected regions and
 *    private-key spans whole-body sanitization finds, scanning the body once
 *    in pieces, so a per-segment projection never shows more than
 *    sanitizeRemoteBody + credentialSafeProjection would.
 * 2. Fails when: protectedRegionScan differs from protectedRegions (pairs,
 *    offsets, `read`, truncated tail) or feedPemScan differs from
 *    privateKeySpans for any chunking, or a fence trust flip by append goes
 *    unnoticed by the observed fence walk.
 * 3. Existing coverage: test/fence-scan*.test.ts and
 *    test/secret-scan-private-key-spans.test.ts pin the whole-body functions.
 * 4. No production seam: differential against the whole-body functions.
 */
import { describe, expect, test } from 'bun:test';
import { markdownFenceTrusted, protectedRegions } from '../../src/core/fence-scan.ts';
import { PROTECTED_PAIRS } from '../../src/core/remote-body.ts';
import { privateKeySpans } from '../../src/core/secret-scan.ts';
import { feedPemScan, initialPemScan, initialRegionScan, protectedRegionScan, walkTrusted, type ScannedRegion } from '../../src/core/page-body/region-scan.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { KEY_BODY, PEM_BEGIN_PKCS8, PEM_BEGIN_RSA, PEM_END_RSA, pick } from '../helpers/segment-bodies.ts';

const ATOMS = ['<!--- gbrain:facts:begin -->', '<!--- gbrain:facts:end -->', '<!--- gbrain:takes:begin -->', '<!--- gbrain:takes:end -->',
  '```', '~~~', '````', '```js', '`', '\n', '\r\n', '\r', ' ', 'text', 'é', '😀', '  ```', '    ```', '\\`', '\u2028'];
const PEM_ATOMS = [PEM_BEGIN_RSA, PEM_END_RSA, PEM_BEGIN_PKCS8, KEY_BODY, 'AAAA',
  '\n', '\r\n', ' ', 'prose words', '\\n', 'Proc-Type: 4,ENCRYPTED', '-----', 'BEGIN', ' PRIVATE KEY-----', 'x'.repeat(3000)];

const byteAt = (s: string, i: number) => Buffer.byteLength(s.slice(0, i));

function expectedRegions(body: string) {
  const { regions, truncatedAt } = protectedRegions(body, PROTECTED_PAIRS);
  return {
    regions: regions.map(r => ({ pair: r.pair, start: byteAt(body, r.start), end: byteAt(body, r.end), read: r.read })),
    truncatedAt: truncatedAt === -1 ? null : byteAt(body, truncatedAt),
  };
}

function scanInPieces(body: string, trusted: boolean, piece: () => number) {
  const state = initialRegionScan(trusted);
  const regions: ScannedRegion[] = [];
  for (let i = 0; i < body.length;) {
    let k = piece();
    const c = body.charCodeAt(i + k - 1);
    if (c >= 0xd800 && c <= 0xdbff) k++;
    regions.push(...protectedRegionScan(state, body.slice(i, i + k)).regions);
    i += k;
  }
  const last = protectedRegionScan(state, '', true);
  return { regions: [...regions, ...last.regions], truncatedAt: last.truncatedAt, state };
}

describe('protectedRegionScan', () => {
  test('equals protectedRegions on marker and fence soup in random chunkings', () => {
    const r = mulberry32(101);
    for (let t = 0; t < 8000; t++) {
      let body = '';
      const n = 1 + Math.floor(r() * 40);
      for (let i = 0; i < n; i++) body += pick(r, ATOMS);
      const { regions, truncatedAt } = scanInPieces(body, markdownFenceTrusted(body), () => 1 + Math.floor(r() * 8));
      expect({ regions, truncatedAt }).toEqual(expectedRegions(body));
    }
  });

  test('a fence trust flip by append: the observed walk reports it, and a rescan under the new trust matches', () => {
    const before = 'intro\n```\n<!--- gbrain:takes:begin -->\n```\nsecret <!--- gbrain:takes:end -->\n';
    const appended = '```\nnever closed <!--- gbrain:takes:end -->\n';
    expect(markdownFenceTrusted(before)).toBe(true);
    expect(markdownFenceTrusted(before + appended)).toBe(false);
    const first = scanInPieces(before, true, () => 7);
    expect(walkTrusted(first.state.track.walk)).toBe(true);
    const stale = initialRegionScan(true);
    protectedRegionScan(stale, before);
    protectedRegionScan(stale, appended, true);
    expect(walkTrusted(stale.track.walk)).toBe(false);
    const rescan = scanInPieces(before + appended, false, () => 5);
    expect({ regions: rescan.regions, truncatedAt: rescan.truncatedAt }).toEqual(expectedRegions(before + appended));
    expect(rescan.regions).not.toEqual(scanInPieces(before + appended, true, () => 5).regions);
  });
});

describe('feedPemScan', () => {
  test('equals privateKeySpans on key soup in random chunkings', () => {
    const r = mulberry32(103);
    let spans = 0;
    for (let t = 0; t < 1500; t++) {
      let body = '';
      const n = 1 + Math.floor(r() * 60);
      for (let i = 0; i < n; i++) body += pick(r, PEM_ATOMS);
      if (r() < 0.2) body = body.repeat(1 + Math.floor(r() * 8));
      const want = privateKeySpans(body);
      const st = initialPemScan('region_start');
      const got: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < body.length;) {
        const k = 1 + Math.floor(r() * (r() < 0.5 ? 10 : 5000));
        feedPemScan(st, body.slice(i, i + k), false, (start, end) => got.push({ start, end }));
        i += k;
      }
      feedPemScan(st, '', true, (start, end) => got.push({ start, end }));
      expect(got).toEqual(want.map(s => ({ start: s.start, end: s.end })));
      spans += want.length;
    }
    expect(spans).toBeGreaterThan(500);
  });
});
