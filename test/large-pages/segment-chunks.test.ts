/**
 * The per-segment chunker (page-body/segment-chunks.ts), spec 4.1.
 *
 * 1. Protects: chunks of a segmented page stay inside their segment, address
 *    their text in stored and projected coordinates, keep today's privacy
 *    projection and order within the segment (prose, fenced code, low-tier
 *    facts rows), and a quarantined page has none.
 * 2. Fails when: a chunk's span leaves its segment or does not hold its
 *    text, fenced code or low-tier rows leave their segment's tail, a
 *    segment starting inside a giant fence misreads its closer, chunks are
 *    made from regions computed under the wrong fence trust, or a
 *    one-segment page chunks differently from prepareMarkdownChunks.
 * 3. Existing coverage: test/fence-chunk-overlay.test.ts and the chunker
 *    suites pin the inline pipeline this reuses.
 * 4. No production seam: pure functions; the fence overlay is passed in.
 */
import { describe, expect, test } from 'bun:test';
import { markdownFenceTrusted } from '../../src/core/fence-scan.ts';
import { stripMaterializedMarkers } from '../../src/core/timeline-marker.ts';
import { prepareMarkdownChunks, newFenceChunkBudget } from '../../src/core/markdown-chunks.ts';
import { QUARANTINE_KEY } from '../../src/core/quarantine.ts';
import { chunkFenceMarker, type FenceChunkOverlay } from '../../src/core/eligibility/fence-overlay.ts';
import { initialEntryState } from '../../src/core/page-body/entry-state.ts';
import { segmentString, type SegmentOut } from '../../src/core/page-body/segmenter.ts';
import { prepareSegmentChunks, type SegmentChunk } from '../../src/core/page-body/segment-chunks.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { bigPage, FACTS_BLOCK, joinedProjection, KEY_BODY, PEM_BEGIN_RSA, PEM_BLOCK, PEM_END_RSA, segmentOptions } from '../helpers/segment-bodies.ts';

const trustOf = (body: string) => markdownFenceTrusted(stripMaterializedMarkers(body)) ? 'trusted' as const : 'void' as const;
const squash = (s: string) => s.replace(/\s+/g, '');
const segment = (body: string, region: 'truth' | 'timeline' = 'truth') =>
  segmentString(body, initialEntryState({ region }), segmentOptions(trustOf(body)));
const kindOf = (c: SegmentChunk) => chunkFenceMarker(c.chunk_text) ? 'low' : c.chunk_source === 'fenced_code' ? 'code' : 'prose';
const DEMOTE: FenceChunkOverlay = { omit: new Set(), demote: new Map([[1, 'external_untrusted' as const]]) };

function overlaps(seg: SegmentOut, start: number, end: number): boolean {
  return seg.protectedRegions.some(r => seg.byteStart + r.start < end && start < seg.byteStart + r.end);
}

describe('prepareSegmentChunks', () => {
  test('a one-segment page chunks like prepareMarkdownChunks', async () => {
    const body = '# Notes\n\nIntro paragraph about acme-example.\n\n' + FACTS_BLOCK + '\nMiddle text.\n\n'
      + '<!--- gbrain:takes:begin -->\nsecret take\n<!--- gbrain:takes:end -->\n\n```ts\nexport function f(a: number) { return a + 1; }\n```\n\n'
      + 'More prose 2024-04-05.\n\n' + 'filler words here. '.repeat(400) + '\n';
    const [seg, ...rest] = segment(body);
    expect(rest).toEqual([]);
    const got = await prepareSegmentChunks(seg!, { fenceTrust: 'trusted' });
    const want = await prepareMarkdownChunks({ compiled_truth: body });
    expect(got.map(c => [c.chunk_text, c.chunk_source, c.projected_byte_start, c.projected_byte_end, c.symbol_name]))
      .toEqual(want.map(c => [c.chunk_text, c.chunk_source, c.projected_byte_start, c.projected_byte_end, c.symbol_name]));
    expect(got.some(c => c.chunk_source === 'fenced_code')).toBe(true);
    expect(got.map(c => c.chunk_text).join('\n')).not.toContain('secret take');
    expect(got.map(c => c.chunk_text).join('\n')).not.toContain('private thing');
  });

  test('a key inside a world facts row is redacted as prepareMarkdownChunks redacts it', async () => {
    const facts = FACTS_BLOCK.replace('| 1 | likes tea |', `| 1 | deploy key ${PEM_BEGIN_RSA} ${KEY_BODY} ${PEM_END_RSA} |`);
    const body = '# Notes\n\nIntro paragraph.\n\n' + facts + '\nAfter the facts.\n\n' + 'filler words here. '.repeat(200) + '\n';
    const [seg, ...rest] = segment(body);
    expect(rest).toEqual([]);
    const got = await prepareSegmentChunks(seg!, { fenceTrust: 'trusted' });
    const want = await prepareMarkdownChunks({ compiled_truth: body });
    expect(got.map(c => [c.chunk_text, c.chunk_source])).toEqual(want.map(c => [c.chunk_text, c.chunk_source]));
    expect(got.map(c => c.chunk_text).join('\n')).not.toContain(KEY_BODY);
  });

  test('chunks stay inside their segment and their spans hold their text', async () => {
    const body = bigPage(mulberry32(3), 2_500_000);
    const bytes = Buffer.from(body, 'utf8');
    const segs = segment(body);
    expect(segs.length).toBeGreaterThan(4);
    const budget = newFenceChunkBudget();
    let checkedRaw = 0;
    for (const seg of segs) {
      const chunks = await prepareSegmentChunks(seg, { fenceTrust: trustOf(body), fenceBudget: budget });
      const projection = Buffer.from(joinedProjection(bytes, [seg]), 'utf8');
      expect(chunks.map(c => c.local_ordinal)).toEqual(chunks.map((_, i) => i));
      const order = chunks.map(kindOf).join(',');
      expect(order).toMatch(/^(prose,)*prose(,code)*(,low)*$/);
      for (const c of chunks) {
        expect(c.raw_byte_start).toBeGreaterThanOrEqual(0);
        expect(c.raw_byte_end).toBeLessThanOrEqual(seg.bytes.length);
        expect(c.raw_byte_end).toBeGreaterThan(c.raw_byte_start);
        if (kindOf(c) !== 'prose') continue;
        expect(c.projected_byte_end!).toBeLessThanOrEqual(projection.length);
        expect(squash(projection.subarray(c.projected_byte_start!, c.projected_byte_end!).toString('utf8'))).toBe(squash(c.chunk_text));
        if (!overlaps(seg, seg.byteStart + c.raw_byte_start, seg.byteStart + c.raw_byte_end)) {
          expect(squash(bytes.subarray(seg.byteStart + c.raw_byte_start, seg.byteStart + c.raw_byte_end).toString('utf8'))).toBe(squash(c.chunk_text));
          checkedRaw++;
        }
      }
      const text = chunks.map(c => c.chunk_text).join('\n');
      expect(text).not.toContain('private thing');
      expect(text).not.toContain('MIIBOgIB');
    }
    expect(checkedRaw).toBeGreaterThan(100);
    expect(budget.fences).toBeLessThan(newFenceChunkBudget().fences);
  });

  test('low-tier facts rows are marked chunks at the end of their own segment', async () => {
    const section = (i: number) => `## Section ${i}\n\n` + 'filler words for the section. '.repeat(10_000) + '\n\n' + FACTS_BLOCK
      + `\n\`\`\`ts\nexport const v${i} = ${i};\n\`\`\`\n\n`;
    const body = [0, 1, 2, 3].map(section).join('');
    const segs = segment(body);
    expect(segs.length).toBe(4);
    for (const seg of segs) {
      expect(seg.factsSlots.length).toBe(1);
      const chunks = await prepareSegmentChunks(seg, { fenceTrust: 'trusted', overlay: DEMOTE });
      expect(chunks.map(kindOf).join(',')).toMatch(/^(prose,)+code,low$/);
      expect(chunks[chunks.length - 1]!.chunk_text).toContain('likes tea');
      expect(chunks.filter(c => kindOf(c) === 'prose').map(c => c.chunk_text).join('\n')).not.toContain('likes tea');
    }
  });

  test('raw spans of chunks around a key or a facts table cover the stored region', async () => {
    const body = 'Lead text before the key.\n\n' + PEM_BLOCK + '\nText after the key.\n\n' + FACTS_BLOCK + '\nClosing text.\n';
    const [seg] = segment(body);
    const chunks = await prepareSegmentChunks(seg!, { fenceTrust: 'trusted' });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.chunk_text).toContain('<REDACTED:private_key_pem>');
    expect(chunks[0]!.chunk_text).toContain('likes tea');
    expect([chunks[0]!.raw_byte_start, chunks[0]!.raw_byte_end]).toEqual([0, Buffer.byteLength(body) - 1]);
  });

  test('a segment starting inside a giant fence still finds the fences after it closes', async () => {
    const body = 'intro\n~~~\n' + 'plain fenced line\n'.repeat(70_000) + '~~~\n\n```ts\nexport function g(x: number) { return x * 2; }\n```\n\nafter\n';
    const segs = segment(body);
    expect(segs.length).toBe(2);
    expect(segs[1]!.entryState.trusted.walk.fence).toBe('~');
    const chunks = await prepareSegmentChunks(segs[1]!, { fenceTrust: 'trusted' });
    expect(chunks.some(c => c.chunk_source === 'fenced_code' && c.chunk_text.includes('function g'))).toBe(true);
  });

  test('timeline segments are timeline chunks and carry no fenced-code chunks', async () => {
    const body = '- **2024-01-02** | src — entry\n\n```ts\nexport const a = 1;\n```\n';
    const [seg] = segment(body, 'timeline');
    const chunks = await prepareSegmentChunks(seg!, { fenceTrust: 'trusted' });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(c => c.chunk_source === 'timeline')).toBe(true);
  });

  test('a quarantined page has no chunks', async () => {
    const [seg] = segment('# Title\n\nSome text.\n');
    expect(await prepareSegmentChunks(seg!, { fenceTrust: 'trusted', frontmatter: { [QUARANTINE_KEY]: { reason: 'test' } } })).toEqual([]);
  });

  test('regions computed under the other fence trust are refused', async () => {
    const [seg] = segment('# Title\n\nSome text.\n');
    await expect(prepareSegmentChunks(seg!, { fenceTrust: 'void' })).rejects.toThrow(/segment_regions_stale/);
  });
});
